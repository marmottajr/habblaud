// Leitura das linhas do banco do OpenCode (opencode.db, tabelas session_v2 e session_message), sem tocar no Office:
// cada mensagem vira atividades e, quando diz, o status da sessão. Puro: testado em parse.test.ts.
//
// O que o OpenCode grava (v2):
// - session_message.type 'user' (prompt), 'assistant' (um passo do modelo: `content` com 'reasoning', 'text' e 'tool'),
//   'idle' (fim do turno: `outcome` succeeded | interrupted | failed), 'synthetic', 'system', 'compaction',
//   'agent-switched', 'model-switched';
// - a parte 'tool' tem `name` (shell, read, edit, write, grep, glob, webfetch, websearch, question, execute, task...)
//   e `state.status` pending | running | completed | error. Uma 'question' rodando = esperando a resposta do usuário;
// - a mensagem 'assistant' é reescrita enquanto o modelo escreve (mesmo `seq`, `time_updated` novo): `time.completed`
//   só aparece no fim do passo.
import type { Activity, AgentStatus } from '../../../shared/types';
import { describePrompt, describeTool, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';

/** Linha de session_message. */
export interface OpencodeMessageRow {
  id: string;
  seq: number;
  type: string;
  time_created: number;
  time_updated: number;
  data: string;
}

/** Linha de session_v2 (só as colunas usadas). */
export interface OpencodeSessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  time_archived: number | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Nome do modelo de session_v2.model (JSON `{id, providerID}`). */
export function opencodeModel(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return str(rec(JSON.parse(raw))?.id);
  } catch {
    return undefined;
  }
}

/** Ferramenta do OpenCode -> descrição (reaproveita as do Claude Code, com os nomes de campo dele). */
export function describeOpencodeTool(name: string, input: Rec): { desc: ActivityDescription; tool: string } {
  const path = str(input.path) ?? str(input.filePath);
  switch (name) {
    case 'shell':
    case 'bash':
      return { desc: describeTool('Bash', { command: input.command, description: input.description }), tool: 'Bash' };
    case 'read':
      return { desc: describeTool('Read', { file_path: path }), tool: 'Read' };
    case 'edit':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return { desc: describeTool('Edit', { file_path: path }), tool: 'Edit' };
    case 'write':
      return { desc: describeTool('Write', { file_path: path }), tool: 'Write' };
    case 'grep':
      return { desc: describeTool('Grep', { pattern: input.pattern }), tool: 'Grep' };
    case 'glob':
      return { desc: describeTool('Glob', { pattern: input.pattern }), tool: 'Glob' };
    case 'list':
    case 'ls':
      return { desc: describeTool('LS', { path }), tool: 'LS' };
    case 'webfetch':
      return { desc: describeTool('WebFetch', { url: input.url }), tool: 'WebFetch' };
    case 'websearch':
      return { desc: describeTool('WebSearch', { query: input.query }), tool: 'WebSearch' };
    case 'todowrite':
      return { desc: describeTool('TodoWrite', { todos: input.todos }), tool: 'TodoWrite' };
    case 'todoread':
      return { desc: describeTool('TaskList', {}), tool: 'TaskList' };
    case 'task':
      return { desc: describeTool('Agent', { description: input.description, subagent_type: input.subagent_type, prompt: input.prompt }), tool: 'Agent' };
    case 'question':
      return { desc: describeTool('AskUserQuestion', { questions: input.questions }), tool: 'AskUserQuestion' };
    case 'execute':
      return { desc: { kind: 'run', icon: '⚙️', text: tr('Executando código') }, tool: name };
    case 'skill':
      return { desc: describeTool('Skill', { skill: input.name ?? input.skill }), tool: 'Skill' };
    default:
      return { desc: describeTool(name, input), tool: name };
  }
}

export interface OpencodeLineResult {
  at: number;
  activities: Array<{ activity: Activity; current: boolean }>;
  /** Status que a mensagem decide (undefined = não muda). */
  status?: AgentStatus;
  waitingFor?: string;
  /** Ferramentas novas vistas nesta mensagem. */
  toolCalls: number;
}

/**
 * Uma mensagem -> atividades e status. `seen` guarda as atividades já emitidas (a mesma mensagem é relida enquanto
 * o modelo escreve): só o que é novo sai de novo.
 */
export function parseOpencodeMessage(sessionId: string, row: OpencodeMessageRow, seen: Set<string>): OpencodeLineResult {
  const out: OpencodeLineResult = { at: row.time_updated || row.time_created, activities: [], toolCalls: 0 };
  let j: Rec;
  try {
    j = rec(JSON.parse(row.data)) ?? {};
  } catch {
    return out;
  }
  const created = num(rec(j.time)?.created) ?? row.time_created;
  const push = (key: string, desc: ActivityDescription, at: number, current: boolean, extra: Partial<Activity> = {}) => {
    const id = `${sessionId}:${row.id}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.activities.push({ activity: { id, ...desc, at, ...extra }, current });
  };
  switch (row.type) {
    case 'user': {
      const text = str(j.text) ?? '';
      push('prompt', describePrompt(text), created, true);
      out.status = 'working';
      break;
    }
    case 'assistant': {
      const done = num(rec(j.time)?.completed) !== undefined;
      const content = Array.isArray(j.content) ? j.content : [];
      let waiting = false;
      content.forEach((raw, i) => {
        const c = rec(raw);
        if (!c) return;
        if (c.type === 'reasoning') push(`r${i}`, SPECIAL.think(), created, !done);
        else if (c.type === 'text') push(`t${i}`, SPECIAL.respond(truncate(str(c.text) ?? '', 300) || undefined), created, !done);
        else if (c.type === 'tool') {
          const name = str(c.name) ?? 'tool';
          const state = rec(c.state);
          const status = str(state?.status);
          const { desc, tool } = describeOpencodeTool(name, rec(state?.input) ?? {});
          const key = `k${str(c.id) ?? i}`;
          const before = seen.size;
          push(key, desc, created, status === 'pending' || status === 'running', { tool });
          if (seen.size > before) out.toolCalls++;
          if (status === 'error') push(`${key}:err`, SPECIAL.error(tool), row.time_updated, false, { error: true });
          if (name === 'question' && (status === 'pending' || status === 'running')) waiting = true;
        }
      });
      if (waiting) {
        out.status = 'waiting';
        out.waitingFor = tr('responder uma pergunta');
      } else out.status = 'working';
      break;
    }
    case 'idle': {
      const outcome = str(j.outcome);
      if (outcome === 'interrupted') push('idle', SPECIAL.interrupted(), created, false);
      else if (outcome === 'failed') push('idle', SPECIAL.error(), created, false, { error: true });
      else push('idle', SPECIAL.turnDone(), created, false);
      out.status = 'idle';
      break;
    }
    case 'compaction':
      push('compact', SPECIAL.compact(), created, false);
      break;
    default:
      break;
  }
  return out;
}
