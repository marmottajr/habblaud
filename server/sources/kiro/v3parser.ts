// Parser das linhas do transcript do Kiro CLI 3.x (<pasta>/sessions/<hash>/<sessionId>/messages.jsonl).
// Cada linha é um evento {id, timestamp (ISO), payload: {type, ...}}: user, assistant (Say/Reasoning), tool_call,
// tool_result, pending_interaction (pedido de aprovação), interaction_resolved, turn_start/turn_end, usage_summary,
// session_metadata, sub_agent_start/sub_agent_complete. O resto (hooks, steering, notas) é ruído e fica de fora.
// Sem I/O: o estado (tarefas, números, ferramentas vistas, aprovações pendentes) vai num KiroV3State que o watcher
// guarda por sessão. As descrições reaproveitam as do 2.x (parser.ts) e as do Claude Code (shared/activity.ts).
import type { Activity, AgentStats, AgentStatus, TaskItem } from '../../../shared/types';
import { describePrompt, describeShellJob, describeTool, maskSecrets, SPECIAL, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { ShellStart } from '../shells';
import { cleanKiroPrompt, describeKiroTool, KIRO_SHELL_TOOLS } from './parser';
import { kiroRole } from './watcher';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const firstStr = (o: Obj, ...keys: string[]): string => {
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  return '';
};

/** Ferramentas que disparam subagente (3.x: orchestrate_subagent; 2.x: subagent/use_subagent/delegate). */
export const KIRO_V3_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['orchestrate_subagent', 'subagent', 'use_subagent', 'delegate']);
const TODO_TOOLS: ReadonlySet<string> = new Set(['todo_list', 'todo']);
/** Ferramentas cujo resultado diz as linhas mexidas (os argumentos trazem o texto). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['str_replace', 'fs_write', 'fs_append', 'write', 'write_file', 'edit']);
/** Ids de ferramentas guardados (para não contar duas vezes uma linha repetida). */
const MAX_TOOLS = 512;

interface SeenTool {
  name: string;
  label: string;
  input: Obj;
}

export interface KiroV3State {
  tasks: TaskItem[];
  stats: AgentStats;
  /** toolCallId -> ferramenta (liga o tool_call ao tool_result e ao pedido de aprovação). */
  tools: Map<string, SeenTool>;
  /** toolCallIds com pedido de aprovação na tela. */
  approvals: Set<string>;
  /** Quantos subagentes os tool_call pediram e quantos sub_agent_start apareceram (vale o maior). */
  subagentCalls: number;
  subagentStarts: number;
  /** Dentro de um turno (do pedido ao turn_end): o resultado de um shell em segundo plano depois dele não reabre. */
  inTurn: boolean;
  lineNo: number;
}

export function createKiroV3State(): KiroV3State {
  return {
    tasks: [],
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    tools: new Map(),
    approvals: new Set(),
    subagentCalls: 0,
    subagentStarts: 0,
    inTurn: false,
    lineNo: 0,
  };
}

/** O que uma linha pede ao rastreador de shells (ShellTracker). */
export type KiroV3ShellSignal =
  | { type: 'start'; shell: ShellStart }
  /** tool_result do shell: em primeiro plano sai da lista; em segundo plano termina (ok ou falhou). */
  | { type: 'result'; toolUseId: string; error: boolean }
  /** Fim do turno: nenhum comando em primeiro plano continua rodando. */
  | { type: 'turnEnd' };

export interface KiroV3LineResult {
  type: string;
  /** Horário da linha (timestamp; sem ele, `now`). */
  at: number;
  activities: Activity[];
  status?: AgentStatus;
  waitingFor?: string;
  tasksChanged: boolean;
  statsChanged: boolean;
  shells: KiroV3ShellSignal[];
  /** Pedido do usuário sem o contexto injetado (vira título quando a sessão não tem). */
  promptText?: string;
  /** sub_agent_start: o watcher põe o subagente no escritório e lê sub-executions/<subSessionId>.jsonl. */
  subStart?: KiroV3SubStart;
  /** sub_agent_complete: o watcher termina de ler o arquivo do subagente e o tira do trabalho. */
  subComplete?: KiroV3SubComplete;
}

export interface KiroV3SubStart {
  subSessionId: string;
  /** Papel (subAgentName sem o prefixo do Kiro), ou undefined. */
  role?: string;
  /** Pedido resumido (sem o briefing do orquestrador, segredos mascarados, até 90 caracteres). */
  title?: string;
}

export interface KiroV3SubComplete {
  subSessionId: string;
  error: boolean;
  /** Resposta (ou mensagem de erro) do subagente, sem cortar: o Activity corta e mascara. */
  text?: string;
}

export interface KiroV3ParseOptions {
  /** Prefixo dos ids das atividades (o id da sessão). */
  idPrefix?: string;
  now?: number;
  mcpServers?: ReadonlyMap<string, string>;
}

// ------------------------------------------------------------------ texto

/** Texto de um content do 3.x: string, lista de partes ({type:'text', text} / {kind:'text', data}) ou {text}. */
export function kiroV3Text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        const o = obj(p);
        if (typeof o.text === 'string') return o.text;
        if ((o.kind === 'text' || o.type === 'text') && typeof o.data === 'string') return o.data;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  const o = obj(content);
  return str(o.text);
}

// ------------------------------------------------------------------ subagentes

const BRIEFING = /<orchestrator_briefing>[\s\S]*?(?:<\/orchestrator_briefing>|$)/g;
const WRAPPER_TAGS = /<\/?(?:user_instruction|how_to_interpret|orchestrator_briefing)>/g;

/**
 * Título do subagente pelo pedido do sub_agent_start: o texto de <user_instruction> quando houver (pode vir sem o
 * fechamento); senão o pedido sem os blocos <orchestrator_briefing>; senão a explicação. Só as tags do Kiro saem:
 * "<repo>" e afins no meio do pedido são texto do usuário.
 */
export function kiroSubTitle(prompt: string, explanation = ''): string | undefined {
  const pick = (s: string): string => {
    const open = s.indexOf('<user_instruction>');
    let t = s;
    if (open >= 0) {
      const rest = s.slice(open + '<user_instruction>'.length);
      const close = rest.indexOf('</user_instruction>');
      t = close >= 0 ? rest.slice(0, close) : rest.replace(BRIEFING, ' ');
    } else t = s.replace(BRIEFING, ' ');
    return cleanKiroPrompt(t.replace(WRAPPER_TAGS, ' ')).replace(/\s+/g, ' ').trim();
  };
  const text = pick(prompt) || pick(explanation);
  return text ? truncate(maskSecrets(text.slice(0, 2_000)), 90) : undefined;
}

// ------------------------------------------------------------------ linhas mexidas

function lines(s: string): string[] {
  if (!s) return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Linhas adicionadas e removidas entre dois textos (tira o começo e o fim em comum). */
export function diffLineCounts(before: string, after: string): { added: number; removed: number } {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { added: b.length - start - end, removed: a.length - start - end };
}

/**
 * Linhas mexidas por uma edição que deu certo, pelos argumentos: str_replace (antes -> depois), fs_append e fs_write
 * (o texto escrito conta como adicionado; o conteúdo antigo de um arquivo sobrescrito não aparece no transcript).
 */
export function kiroEditLines(name: string, input: Obj): { added: number; removed: number } | undefined {
  if (!EDIT_TOOLS.has(name)) return undefined;
  const oldS = firstStr(input, 'oldStr', 'old_str', 'oldString', 'old');
  const newS = firstStr(input, 'newStr', 'new_str', 'newString', 'new');
  const replace = name === 'str_replace' || name === 'edit' || /^str_?replace$/i.test(str(input.command));
  if (replace) return oldS || newS ? diffLineCounts(oldS, newS) : undefined;
  const text = firstStr(input, 'text', 'content', 'file_text', 'fileText') || newS;
  return text ? { added: lines(text).length, removed: 0 } : undefined;
}

// ------------------------------------------------------------------ tarefas (todo_list)

/** Valores de um objeto com chaves numéricas ({"0": x, "1": y}) na ordem delas; lista = ela mesma. */
function entries(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const o = obj(v);
  return Object.keys(o)
    .sort((x, y) => Number(x) - Number(y) || x.localeCompare(y))
    .map((k) => o[k]);
}

function taskTitle(t: unknown): string {
  if (typeof t === 'string') return t;
  const o = obj(t);
  return firstStr(o, 'task_description', 'description', 'title', 'content', 'task');
}

function newTasks(list: unknown[], firstId: number): TaskItem[] {
  const out: TaskItem[] = [];
  for (const t of list) {
    const title = taskTitle(t).trim();
    if (!title) continue;
    out.push({ id: String(firstId + out.length), title: truncate(title, 120), status: 'pending' });
  }
  return out;
}

/**
 * Aplica um todo_list do 3.x: create ({tasks: {"0": {task_description}}}) troca a lista (ids 1, 2, … na ordem);
 * add acrescenta no fim; complete ({completed_task_ids: {"0": "1"}}) marca como concluídas. Devolve undefined quando
 * o formato não é reconhecido (a lista fica como está).
 */
export function applyKiroTodo(tasks: readonly TaskItem[], input: Obj): TaskItem[] | undefined {
  const command = str(input.command).toLowerCase();
  if (command === 'create') {
    const list = entries(input.tasks ?? input.task_list ?? input.todos);
    return list.length ? newTasks(list, 1) : undefined;
  }
  if (command === 'add' || command === 'add_tasks') {
    const list = entries(input.new_tasks ?? input.tasks);
    const max = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
    const added = newTasks(list, max + 1);
    return added.length ? [...tasks, ...added] : undefined;
  }
  if (command === 'complete') {
    const ids = entries(input.completed_task_ids ?? input.completed_indices ?? input.task_ids)
      .map((v) => (typeof v === 'number' ? String(v) : str(v)))
      .filter(Boolean);
    if (!ids.length) return undefined;
    // Os ids vistos são 1, 2, …; um "0" sem tarefa 0 quer dizer contagem a partir do zero.
    const zeroBased = ids.includes('0') && !tasks.some((t) => t.id === '0');
    const done = new Set(ids.map((id) => (zeroBased && /^\d+$/.test(id) ? String(Number(id) + 1) : id)));
    return tasks.map((t) => (done.has(t.id) ? { ...t, status: 'completed' as const } : t));
  }
  return undefined;
}

// ------------------------------------------------------------------ linhas

const REJECTED = /reject|deny|denied|declin|cancel|refus|\bno\b/i;
const INTERRUPTED = /cancel|interrupt|abort/i;
const FAILED = /error|fail/i;

function describeV3Tool(name: string, input: Obj, mcpServers?: ReadonlyMap<string, string>) {
  if (name === 'orchestrate_subagent') {
    const what = firstStr(input, 'description', 'task', 'prompt', 'query', 'objective');
    return describeTool('Task', { description: truncate(what, 40), prompt: what });
  }
  return describeKiroTool(name, input, mcpServers);
}

/** Status depois que uma aprovação saiu da tela: ainda há outra pendente = continua esperando; fora do turno, nada muda. */
function afterApproval(state: KiroV3State): Pick<KiroV3LineResult, 'status' | 'waitingFor'> {
  if (state.approvals.size) return { status: 'waiting', waitingFor: tr('aprovar uma permissão') };
  return state.inTurn ? { status: 'working' } : {};
}

/** Converte uma linha do messages.jsonl (e atualiza o estado). undefined = linha inválida ou ruído. */
export function applyKiroV3Line(state: KiroV3State, line: string, opts: KiroV3ParseOptions = {}): KiroV3LineResult | undefined {
  if (!line.trim()) return undefined;
  let row: Obj;
  try {
    row = obj(JSON.parse(line));
  } catch {
    return undefined;
  }
  const payload = obj(row.payload);
  const type = str(payload.type);
  if (!type) return undefined;
  state.lineNo++;
  const ts = Date.parse(str(row.timestamp));
  const at = Number.isNaN(ts) ? (opts.now ?? Date.now()) : ts;
  const prefix = opts.idPrefix ? `${opts.idPrefix}#` : '';
  const base = `${prefix}${str(row.id) || `l${state.lineNo}`}`;
  const r: KiroV3LineResult = { type, at, activities: [], tasksChanged: false, statsChanged: false, shells: [] };
  const act = (suffix: string, d: Omit<Activity, 'id' | 'at'>) => r.activities.push({ id: `${base}:${suffix}`, at, ...d });

  switch (type) {
    case 'user': {
      const text = cleanKiroPrompt(kiroV3Text(payload.content));
      state.approvals.clear();
      act('p', text ? describePrompt(text) : { kind: 'prompt', icon: '📨', text: tr('Recebeu um pedido') });
      if (text) r.promptText = text;
      state.inTurn = true;
      r.status = 'working';
      return r;
    }
    case 'assistant': {
      const text = kiroV3Text(payload.content).trim();
      if (str(payload.operationType) === 'Reasoning') act('t', SPECIAL.think());
      else if (text) act('r', SPECIAL.respond(text));
      state.inTurn = true;
      r.status = 'working';
      return r;
    }
    case 'tool_call': {
      const id = str(payload.toolCallId);
      const name = str(payload.toolName) || 'tool';
      const input = obj(payload.args);
      if (id && state.tools.has(id)) return r; // a mesma chamada de novo (status atualizado)
      const d = describeV3Tool(name, input, opts.mcpServers);
      const toolId = id || `${base}:t`;
      r.activities.push({ id: `${prefix}${toolId}`, at, ...d, tool: name });
      state.tools.set(toolId, { name, label: d.text, input });
      if (state.tools.size > MAX_TOOLS) state.tools.delete(state.tools.keys().next().value as string);
      state.stats.toolCalls++;
      state.inTurn = true;
      if (KIRO_V3_SUBAGENT_TOOLS.has(name)) state.subagentCalls++;
      state.stats.subagents = Math.max(state.subagentCalls, state.subagentStarts);
      r.statsChanged = true;
      if (TODO_TOOLS.has(name) && str(payload.status) !== 'failed') {
        const next = applyKiroTodo(state.tasks, input);
        if (next) {
          state.tasks = next;
          r.tasksChanged = true;
        }
      }
      if (KIRO_SHELL_TOOLS.has(name) && id) {
        const job = describeShellJob('Bash', input);
        const shell: ShellStart = { toolUseId: id, label: job.label, background: input.run_in_background === true, kind: 'shell', at };
        if (job.command) shell.command = job.command;
        r.shells.push({ type: 'start', shell });
      }
      if (d.kind === 'ask') {
        r.status = 'waiting';
        r.waitingFor = tr('responder uma pergunta');
      } else r.status = state.approvals.size ? 'waiting' : 'working';
      if (r.status === 'waiting' && !r.waitingFor) r.waitingFor = tr('aprovar uma permissão');
      return r;
    }
    case 'tool_result': {
      const id = str(payload.toolCallId);
      const t = state.tools.get(id);
      const ok = payload.success !== false;
      if (!ok) act('err', { ...SPECIAL.error(t?.name), error: true });
      if (ok && t) {
        const n = kiroEditLines(t.name, t.input);
        if (n && (n.added || n.removed)) {
          state.stats.linesAdded = (state.stats.linesAdded ?? 0) + n.added;
          state.stats.linesRemoved = (state.stats.linesRemoved ?? 0) + n.removed;
          r.statsChanged = true;
        }
      }
      if (t && KIRO_SHELL_TOOLS.has(t.name)) r.shells.push({ type: 'result', toolUseId: id, error: !ok });
      state.approvals.delete(id);
      Object.assign(r, afterApproval(state));
      return r;
    }
    case 'pending_interaction': {
      const id = str(payload.toolCallId);
      if (str(payload.interactionType) === 'tool_approval') {
        if (id) state.approvals.add(id);
        r.status = 'waiting';
        r.waitingFor = tr('aprovar uma permissão');
      } else {
        r.status = 'waiting'; // outro tipo de pergunta: o Office usa "responder no terminal"
      }
      return r;
    }
    case 'interaction_resolved': {
      const id = str(payload.toolCallId);
      const t = state.tools.get(id);
      const answer = `${str(payload.outcome)} ${str(obj(payload.selectedOption).id) || str(obj(payload.selectedOption).label) || str(payload.selectedOption)}`;
      state.approvals.delete(id);
      if (REJECTED.test(answer) && !/allow|approv|accept|\byes\b|trust/i.test(answer)) {
        act('rej', SPECIAL.rejected(t?.label));
        if (t && KIRO_SHELL_TOOLS.has(t.name)) r.shells.push({ type: 'result', toolUseId: id, error: true });
      }
      Object.assign(r, afterApproval(state));
      return r;
    }
    case 'turn_start':
      state.inTurn = true;
      r.status = 'working';
      return r;
    case 'turn_end': {
      const reason = str(payload.stopReason);
      if (INTERRUPTED.test(reason)) act('end', SPECIAL.interrupted());
      else if (FAILED.test(reason)) act('end', { ...SPECIAL.error(), error: true });
      state.approvals.clear();
      state.inTurn = false;
      r.shells.push({ type: 'turnEnd' });
      r.status = 'idle';
      return r;
    }
    case 'session_metadata': {
      if (str(payload.key) !== 'displayError') return undefined; // contextUsage: sem campo no escritório
      const v = obj(payload.value);
      act('err', { ...SPECIAL.error(undefined, str(v.message) || str(v.errorType)), error: true });
      return r;
    }
    case 'sub_agent_start': {
      state.subagentStarts++;
      state.stats.subagents = Math.max(state.subagentCalls, state.subagentStarts);
      r.statsChanged = true;
      const subSessionId = str(payload.subSessionId);
      if (subSessionId) {
        const role = kiroRole(str(payload.subAgentName) || undefined);
        const title = kiroSubTitle(str(payload.prompt), str(payload.explanation));
        r.subStart = { subSessionId, ...(role ? { role } : {}), ...(title ? { title } : {}) };
      }
      return r;
    }
    case 'sub_agent_complete': {
      const subSessionId = str(payload.subSessionId);
      if (subSessionId) {
        // Status visto: "success" / "error" (com errorMessage); qualquer outro valor com cara de falha conta como erro.
        const errorMessage = str(payload.errorMessage);
        const error = FAILED.test(str(payload.status)) || !!errorMessage;
        const text = (error ? errorMessage || kiroV3Text(payload.response) : kiroV3Text(payload.response)).trim();
        r.subComplete = { subSessionId, error, ...(text ? { text } : {}) };
      }
      return r;
    }
    case 'usage_summary': // créditos: AgentStats não tem campo para eles
      return r;
    default:
      return undefined; // ContextualHookInvoked, steering_inclusion, session_event, agent_note…
  }
}
