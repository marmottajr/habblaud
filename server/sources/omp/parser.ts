// Parser do transcript do omp (oh-my-pi): `~/.omp/agent/sessions/<pasta>/<início>_<uuidv7>.jsonl`, append-only.
//
// Formato (omp 18.12, conferido em sessões reais; ver fixtures/):
// - linha 1: o slot `title` ({type:"title", title, pad}), reescrito NO LUGAR com largura fixa (o `FileTail` o vê como
//   mudança do começo do arquivo e relê tudo: ver source.ts); linha 2: o cabeçalho {type:"session", id, timestamp, cwd,
//   parentSession?}. Subagentes ficam em `<arquivo sem .jsonl>/<Nome>.jsonl`, com `parentSession` no cabeçalho;
// - `message` com `role`: `user` (conteúdo em blocos {type:"text"}), `assistant` (blocos `text`, `thinking`, `toolCall`
//   {id, name, arguments}; `usage` {input, output, cacheRead, cacheWrite}; `stopReason` stop | toolUse | error |
//   aborted | length) e `toolResult` ({toolCallId, toolName, content, isError});
// - `model_change` ({model: "provedor/modelo"}), `title_change` ({title}), `compaction`, `custom` com `customType`
//   `session_exit` (saída limpa; crash não grava nada) e `tool_execution_start`; o resto é ignorado.
// Nada aqui lê o conteúdo para outra coisa além de atividade (mascarada e cortada, como as outras fontes).
import type { Activity, AgentStats, TaskItem } from '../../../shared/types';
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { ParsedActivity } from '../transcript';

type Rec = Record<string, unknown>;

const TITLE_MAX = 90;
const MAX_PENDING = 128;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function firstLine(s: string, max = 140): string | undefined {
  const line = s.split('\n').find((l) => l.trim());
  return line ? truncate(line, max) : undefined;
}

// ------------------------------------------------------------------ cabeçalho

export interface OmpHeader {
  /** Id da sessão (uuidv7). */
  id: string;
  cwd: string;
  /** Subagente: caminho do arquivo da sessão que o criou. */
  parentSession?: string;
  startedAt?: number;
}

export interface OmpHead {
  header?: OmpHeader;
  /** Título do slot da linha 1 (vazio = ainda sem título). */
  title?: string;
  /** Bytes das duas primeiras linhas (com as quebras): o `FileTail` começa daí. */
  bytes: number;
}

/** O cabeçalho (`session`, linha 2) de uma linha JSON, ou undefined. */
export function headerFromLine(raw: string): OmpHeader | undefined {
  try {
    const j = rec(JSON.parse(raw));
    if (j?.type !== 'session') return undefined;
    const id = str(j.id);
    const cwd = str(j.cwd);
    if (!id || !cwd) return undefined;
    const header: OmpHeader = { id, cwd };
    const parent = str(j.parentSession);
    const at = toMs(j.timestamp);
    if (parent) header.parentSession = parent;
    if (at !== undefined) header.startedAt = at;
    return header;
  } catch {
    return undefined;
  }
}

/**
 * Lê o começo do arquivo (texto das primeiras linhas): título do slot e cabeçalho. Com menos de duas linhas completas
 * (sessão recém-criada) o cabeçalho vem undefined e `bytes` = 0.
 */
export function parseOmpHead(text: string): OmpHead {
  const nl1 = text.indexOf('\n');
  if (nl1 < 0) return { bytes: 0 };
  const nl2 = text.indexOf('\n', nl1 + 1);
  if (nl2 < 0) return { bytes: 0 };
  let title: string | undefined;
  try {
    const slot = rec(JSON.parse(text.slice(0, nl1)));
    if (slot?.type === 'title') title = cleanTitle(slot.title);
  } catch {
    // slot ilegível: sem título
  }
  const header = headerFromLine(text.slice(nl1 + 1, nl2).replace(/\r$/, ''));
  const out: OmpHead = { bytes: Buffer.byteLength(text.slice(0, nl2 + 1)) };
  if (header) out.header = header;
  if (title) out.title = title;
  return out;
}

function cleanTitle(v: unknown): string | undefined {
  const t = str(v);
  return t ? truncate(maskSecrets(t.slice(0, 1_000)), TITLE_MAX) : undefined;
}

// ------------------------------------------------------------------ ferramentas

/** Remove o seletor de linhas do `read` do omp (`arquivo.ts:50-80`, `arquivo.ts:raw`). */
function pathOf(v: unknown): string | undefined {
  const p = str(v);
  return p?.replace(/:(?:raw|\d[\d,+-]*)(?::raw)?$/, '');
}

/** Arquivos de um `edit` do omp: o `input` abre cada seção com `[caminho#TAG]`. */
function editFiles(input: unknown): string[] {
  const text = typeof input === 'string' ? input : '';
  const out: string[] = [];
  for (const m of text.matchAll(/^\[([^\]\r\n]+?)(?:#[0-9A-Za-z]{2,8})?\]\s*$/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Chamada de ferramenta do omp no vocabulário do escritório (shared/activity.ts): bash → Bash, edit/write/ast_edit →
 * Edit/Write, read → Read, grep/glob → Grep/Glob, web_search/fetch → WebSearch/WebFetch, task → Agent; as sem
 * correspondente (eval, ask, lsp...) ganham descrições próprias ou o nome cru.
 */
export function describeOmpTool(rawName: string, rawInput: unknown): { desc: ActivityDescription; tool: string } {
  const input = rec(rawInput) ?? {};
  const name = rawName.trim();
  switch (name) {
    case 'bash':
      return { desc: describeTool('Bash', { command: str(input.command), description: input.i }), tool: 'Bash' };
    case 'eval': {
      const what = str(input.title) ?? str(input.i);
      return { desc: { kind: 'run', icon: '⚙️', text: tr('Executando código'), ...(what ? { detail: truncate(maskSecrets(what), 300) } : {}) }, tool: 'eval' };
    }
    case 'edit': {
      const files = editFiles(input.input);
      const desc = describeTool('Edit', { file_path: files[0] });
      if (files.length > 1) desc.detail = truncate(files.join(', '), 300);
      return { desc, tool: 'Edit' };
    }
    case 'ast_edit':
      return { desc: describeTool('Edit', { file_path: pathOf(input.path) }), tool: 'Edit' };
    case 'write':
      return { desc: describeTool('Write', { file_path: pathOf(input.path) }), tool: 'Write' };
    case 'read':
      return { desc: describeTool('Read', { file_path: pathOf(input.path) }), tool: 'Read' };
    case 'grep':
      return { desc: describeTool('Grep', { pattern: input.pattern }), tool: 'Grep' };
    case 'glob':
      // No omp o `path` do glob é o próprio padrão.
      return { desc: describeTool('Glob', { pattern: input.path ?? input.pattern }), tool: 'Glob' };
    case 'ls':
      return { desc: describeTool('LS', { path: pathOf(input.path) }), tool: 'LS' };
    case 'web_search':
      return { desc: describeTool('WebSearch', { query: input.query }), tool: 'WebSearch' };
    case 'fetch':
      return { desc: describeTool('WebFetch', { url: input.url }), tool: 'WebFetch' };
    case 'task': {
      const tasks = Array.isArray(input.tasks) ? input.tasks.map(rec).filter((t): t is Rec => !!t) : [];
      const names = tasks.map((t) => str(t.name)).filter((n): n is string => !!n);
      const desc = describeTool('Agent', { description: str(input.i), subagent_type: names.join(', ') || undefined });
      return { desc, tool: 'Agent' };
    }
    case 'wait':
      return { desc: { kind: 'delegate', icon: '⏳', text: tr('Esperando os subagentes') }, tool: 'wait' };
    case 'ask': {
      // O omp pergunta no terminal: a pergunta aparece, a resposta não vem pelo escritório (sem `questions`).
      const questions = Array.isArray(input.questions) ? input.questions : input.question !== undefined ? [{ question: input.question }] : [];
      const { questions: _answerable, ...desc } = describeTool('AskUserQuestion', { questions });
      return { desc, tool: 'ask' };
    }
    default:
      return { desc: describeTool(name || 'ferramenta', input), tool: name || 'ferramenta' };
  }
}

// ------------------------------------------------------------------ estado

export interface OmpState {
  /** `provedor/modelo` do último model_change (ou o `provider`/`model` da última resposta). */
  model?: string;
  /** `thinkingLevel` do último thinking_level_change. */
  thinking?: string;
  /** Título: title_change > slot da linha 1 > primeira instrução. */
  title?: string;
  /** O título veio de uma fonte explícita (slot ou title_change): a primeira instrução não o troca. */
  titleExplicit?: boolean;
  tasks: TaskItem[];
  stats: AgentStats;
  /** Turno aberto (instrução ou ferramenta em andamento); undefined = nenhum evento de turno visto. */
  turnOpen?: boolean;
  /** `session_exit` visto e nada de conversa depois dele. */
  exited?: boolean;
  firstAt?: number;
  lastAt?: number;
  /** Quando o turno atual começou (para "Concluiu em X"). */
  turnStartAt?: number;
  /** Chamadas de ferramenta sem resultado ainda (id → nome). */
  pending: Map<string, string>;
  /** Atividade atual (para não repetir "Pensando…"). */
  current?: { kind: Activity['kind']; at: number };
  /** Pastas/arquivos citados pelas últimas ferramentas (mais nova no fim), para a sala seguir o projeto (projectDir). */
  paths: { path: string; dir: boolean }[];
}

const PATHS_WINDOW = 5;

/** Caminhos que uma chamada de ferramenta do omp toca: `cwd` (pasta), `path`/`file`/`file_path` e os `[arquivo#TAG]` do edit. */
export function toolPaths(args: Record<string, unknown>): { path: string; dir: boolean }[] {
  const out: { path: string; dir: boolean }[] = [];
  if (typeof args.cwd === 'string' && args.cwd.trim()) out.push({ path: args.cwd.trim(), dir: true });
  for (const k of ['path', 'file', 'file_path']) {
    const v = args[k];
    // read aceita "arquivo:50-80" e listas "a;b": vale o primeiro, sem seletor
    if (typeof v === 'string' && v.trim()) out.push({ path: v.split(';')[0]!.trim().replace(/:[^/]*$/, ''), dir: false });
  }
  if (typeof args.input === 'string') {
    const m = /^\[([^\]#\n]+)#[0-9A-Fa-f]{4}\]/m.exec(args.input);
    if (m) out.push({ path: m[1]!.trim(), dir: false });
  }
  return out;
}

/**
 * Pasta do projeto em que o agente está trabalhando: o subdiretório imediato de `cwd` mais citado nas últimas ferramentas
 * (empate: o mais recente). Caminho fora de `cwd`, arquivo solto na raiz ou nada citado: `cwd`. Aceita `\` (Windows).
 */
export function projectDir(cwd: string, paths: readonly { path: string; dir: boolean }[]): string {
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const count = new Map<string, number>();
  let best: string | undefined;
  for (const p of paths) {
    // URL e URIs internas do omp (https://, skill://, local://...) não são pasta
    if (/^[A-Za-z][\w+.-]*:\/\//.test(p.path)) continue;
    const raw = p.path.replace(/\\/g, '/');
    const abs = raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:/.test(raw) ? raw : `${root}/${raw}`;
    if (!abs.startsWith(`${root}/`)) continue;
    const segs = abs.slice(root.length + 1).split('/').filter((s) => s && s !== '.');
    if (!segs.length || segs[0] === '..' || (!p.dir && segs.length < 2)) continue;
    const seg = segs[0]!;
    count.set(seg, (count.get(seg) ?? 0) + 1);
    if (!best || count.get(seg)! >= count.get(best)!) best = seg;
  }
  return best ? `${cwd.replace(/[\\/]+$/, '')}${sep}${best}` : cwd;
}

export function createOmpState(head?: OmpHead): OmpState {
  const s: OmpState = { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, pending: new Map(), paths: [] };
  if (head?.title) {
    s.title = head.title;
    s.titleExplicit = true;
  }
  return s;
}

/** Sinais de uma linha para quem acompanha a sessão. */
export type OmpSignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  /** `session_exit`: saída limpa do omp. */
  | { type: 'exit' }
  /** Uso de uma resposta (já somado em `stats`). */
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'model'; model: string }
  | { type: 'title'; title: string };

export interface OmpLineResult {
  activities: ParsedActivity[];
  signals: OmpSignal[];
  /** Título, números ou modelo mudaram. */
  changed: boolean;
  /** Epoch ms da linha (o `timestamp` dela ou o `now` do contexto). */
  at: number;
}

export interface OmpParseContext {
  /** Prefixo dos ids de atividade (o id do agente). */
  idPrefix: string;
  now: number;
  /** false = só atualiza o estado (sem montar atividades). */
  activities?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof rec(b)?.text === 'string' ? (rec(b)!.text as string) : ''))
    .join('');
}

class OmpLineParser {
  readonly out: OmpLineResult;
  private readonly withActivities: boolean;
  private n = 0;

  constructor(
    private readonly s: OmpState,
    private readonly ctx: OmpParseContext,
    private readonly j: Rec,
    private readonly at: number,
  ) {
    this.withActivities = ctx.activities !== false;
    this.out = { activities: [], signals: [], changed: false, at };
  }

  /** Chave estável: o id da entrada (`id` de 8 hex) e a posição dentro dela; uma releitura gera as mesmas chaves. */
  private key(suffix?: string): string {
    const base = str(this.j.id) ?? `t${this.at.toString(36)}`;
    const i = this.n++;
    return suffix ? `${base}:${suffix}` : i ? `${base}:${i}` : base;
  }

  private push(desc: ActivityDescription, opts: { key?: string; tool?: string; current?: boolean; durationMs?: number; callId?: string } = {}): void {
    if (!this.withActivities) return;
    const activity: Activity = { id: `${this.ctx.idPrefix}#${opts.key ?? this.key()}`, at: this.at, ...desc };
    if (opts.tool) activity.tool = opts.tool;
    if (opts.durationMs !== undefined) activity.durationMs = opts.durationMs;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    this.out.activities.push(opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current });
    if (current) this.s.current = { kind: desc.kind, at: this.at };
  }

  private startTurn(): void {
    if (this.s.turnOpen !== true) this.s.turnStartAt = this.at;
    this.s.turnOpen = true;
    this.out.signals.push({ type: 'turnStart' });
  }

  private endTurn(aborted: boolean): void {
    this.s.turnOpen = false;
    this.s.pending.clear();
    this.out.signals.push({ type: 'turnEnd', aborted });
  }

  run(): void {
    switch (this.j.type) {
      case 'message':
        return this.message(rec(this.j.message));
      case 'model_change': {
        const model = str(this.j.model);
        if (model) this.setModel(model);
        return;
      }
      case 'thinking_level_change': {
        const thinking = str(this.j.thinkingLevel);
        if (thinking && thinking !== this.s.thinking) {
          this.s.thinking = thinking;
          this.out.changed = true;
        }
        return;
      }
      case 'title_change': {
        const title = cleanTitle(this.j.title);
        if (!title) return;
        this.s.title = title;
        this.s.titleExplicit = true;
        this.out.signals.push({ type: 'title', title });
        this.out.changed = true;
        return;
      }
      case 'compaction':
        this.push(SPECIAL.compact());
        return;
      case 'custom':
        if (this.j.customType === 'session_exit') {
          this.s.exited = true;
          this.s.turnOpen = false;
          this.s.pending.clear();
          this.out.signals.push({ type: 'exit' });
        }
        return;
      default:
        return;
    }
  }

  private setModel(model: string): void {
    if (model === this.s.model) return;
    this.s.model = model;
    this.out.signals.push({ type: 'model', model });
    this.out.changed = true;
  }

  private message(m: Rec | undefined): void {
    if (!m) return;
    // Conversa depois de um session_exit: a sessão foi retomada.
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') this.s.exited = false;
    switch (m.role) {
      case 'user':
        return this.user(m);
      case 'assistant':
        return this.assistant(m);
      case 'toolResult':
        return this.toolResult(m);
      default:
        return;
    }
  }

  private user(m: Rec): void {
    this.startTurn();
    // `attribution: "agent"` = texto injetado pelo próprio omp (lembretes, resultados de subagentes), não instrução sua.
    if (m.attribution === 'agent') return;
    const text = textOf(m.content).trim();
    if (!text) return;
    if (this.s.title === undefined) {
      this.s.title = truncate(maskSecrets(text.slice(0, 1_000)), TITLE_MAX);
      this.out.changed = true;
    }
    this.push(describePrompt(text));
  }

  private assistant(m: Rec): void {
    const model = str(m.model);
    const provider = str(m.provider);
    // O modelo que respondeu vale mais que o model_change (trocas temporárias, como o modo plano, voltam sem aviso).
    // A resposta traz provedor e modelo separados: juntos, como no model_change (`provedor/modelo`).
    if (model) this.setModel(provider && !model.includes('/') ? `${provider}/${model}` : model);
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const raw of blocks) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'thinking') {
        const cur = this.s.current;
        // Um único "Pensando…" seguido (o raciocínio vem em vários blocos).
        if (!(cur?.kind === 'think' && this.at - cur.at < 30_000)) this.push(SPECIAL.think(), { key: this.key('t') });
      } else if (b.type === 'text') {
        const text = textOf([b]).trim();
        if (text) this.push(SPECIAL.respond(text), { key: this.key('r') });
      } else if (b.type === 'toolCall') this.toolCall(b);
    }
    const usage = rec(m.usage);
    if (usage) {
      const tokensIn = (num(usage.input) ?? 0) + (num(usage.cacheRead) ?? 0) + (num(usage.cacheWrite) ?? 0);
      const tokensOut = num(usage.output) ?? 0;
      if (tokensIn || tokensOut) {
        this.s.stats.tokensIn += tokensIn;
        this.s.stats.tokensOut += tokensOut;
        this.out.signals.push({ type: 'usage', tokensIn, tokensOut });
        this.out.changed = true;
      }
    }
    switch (m.stopReason) {
      case 'toolUse':
        this.startTurn();
        return;
      case 'error': {
        this.endTurn(false);
        const msg = str(m.errorMessage);
        this.push(SPECIAL.error(undefined, msg ? firstLine(msg) : undefined), { key: this.key('err'), current: false });
        return;
      }
      case 'aborted':
        this.endTurn(true);
        this.push(SPECIAL.interrupted(), { key: this.key('int') });
        return;
      case 'stop':
      case 'length': {
        const ms = this.s.turnStartAt !== undefined && this.at > this.s.turnStartAt ? this.at - this.s.turnStartAt : undefined;
        this.endTurn(false);
        this.push(SPECIAL.turnDone(ms), { key: this.key('d'), durationMs: ms });
        return;
      }
      default:
        return;
    }
  }

  private toolCall(b: Rec): void {
    const id = str(b.id);
    const name = str(b.name) ?? 'ferramenta';
    const args = rec(b.arguments) ?? {};
    this.s.stats.toolCalls++;
    this.out.changed = true;
    if (id) {
      this.s.pending.set(id, name);
      if (this.s.pending.size > MAX_PENDING) this.s.pending.delete(this.s.pending.keys().next().value as string);
    }
    if (name === 'task' && Array.isArray(args.tasks)) this.s.stats.subagents += args.tasks.length;
    const paths = toolPaths(args);
    if (paths.length) this.s.paths = [...this.s.paths, ...paths].slice(-PATHS_WINDOW);
    const { desc, tool } = describeOmpTool(name, args);
    this.push(desc, { key: id ?? this.key(), tool, callId: id });
  }

  private toolResult(m: Rec): void {
    const id = str(m.toolCallId);
    const name = str(m.toolName) ?? (id ? this.s.pending.get(id) : undefined) ?? 'ferramenta';
    if (id) this.s.pending.delete(id);
    if (m.isError !== true) return;
    const { tool } = describeOmpTool(name, {});
    this.push(SPECIAL.error(tool, firstLine(textOf(m.content))), { key: `${id ?? this.key()}:e`, tool, current: false });
  }
}

/** Interpreta uma linha do transcript (da 3ª em diante). Linhas inválidas ou de tipo desconhecido não geram nada. */
export function parseOmpLine(state: OmpState, raw: string, ctx: OmpParseContext): OmpLineResult {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { activities: [], signals: [], changed: false, at: ctx.now };
  }
  const r = rec(j);
  if (!r) return { activities: [], signals: [], changed: false, at: ctx.now };
  const at = toMs(r.timestamp);
  if (at !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const p = new OmpLineParser(state, ctx, r, at ?? ctx.now);
  try {
    p.run();
  } catch {
    // linha estranha demais: fica o que já tiver saído dela
  }
  return p.out;
}
