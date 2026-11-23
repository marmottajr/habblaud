// Fonte de agentes do DeepSeek Harness (AgentSource 'dsh', ver sources/source.ts).
//
// O DSH grava cada sessão em `<dsh>/sessions/<cwd codificado>/session-<uuid>/session.v4.jsonl.zstd`: um JSONL
// comprimido em VÁRIOS quadros zstd independentes, acrescentados ao longo do tempo. O zlib do Node só descomprime o
// primeiro quadro de um buffer, então o arquivo é cortado pelo número mágico (28 B5 2F FD) e cada pedaço é
// descomprimido sozinho (um pedaço que falha é juntado ao próximo: o número mágico pode aparecer dentro dos dados;
// o último quadro, ainda incompleto, fica para o próximo ciclo).
//
// Ligada aqui por padrão (HABBLAUD_DSH=0 desliga, ver server/config.ts).
//
// Presença: o DSH não tem um registro de sessões abertas; vale o arquivo modificado há pouco (RECENT_MS, padrão
// 60 min, HABBLAUD_DSH_RECENT_MIN) ou um turno ainda aberto. Sessões internas (botharness: revisões de aprovação,
// robôs) ficam de fora.
//
// Status: turn/start → working; turn/end → idle; approval/asked sem approval/decided → waiting.
//
// Subagentes: ficam na mesma pasta do projeto, em `<uuid>/` (sem o prefixo `session-`), com `parentSession` e
// `origin: 'subagent'` no cabeçalho e o rótulo em `subagent/descriptor`. Entram como subagente do pai (que precisa
// estar no escritório) só enquanto o turno está aberto; o fim do turno é a entrega (completeSub).
import * as zlib from 'node:zlib';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Activity, AgentStats, AgentStatus, SourceInfo, TaskItem, TaskStatus } from '../../../shared/types';
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, SubInput, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { createDshTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 'working' sem nenhuma escrita por este tempo: o turno morreu. */
const WORKING_QUIET_MS = 30 * 60_000;
/** Atividades antigas levadas ao escritório quando a sessão entra. */
const HISTORY_MAX = 150;
/** A lista de sessões é relida do disco no máximo a cada tanto. */
const SCAN_EVERY_MS = 5_000;
const MAIN_ROLE = tr('Agente principal (DeepSeek Harness)');
const SUB_ROLE = tr('Subagente (DeepSeek Harness)');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface DshSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta do DSH (padrão: HABBLAUD_DSH_DIR ou ~/.dsh). */
  dir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pollMs?: number;
}

/** Pasta do DSH a observar, se existir (HABBLAUD_DSH_DIR ou ~/.dsh). */
export function discoverDshDir(env: NodeJS.ProcessEnv, home = homedir()): string | undefined {
  const dir = resolve(env.HABBLAUD_DSH_DIR?.trim() || join(home, '.dsh'));
  return existsSync(join(dir, 'sessions')) ? dir : undefined;
}

interface DshState {
  title?: string;
  model?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  turnOpen: boolean;
  turnStartAt?: number;
  firstAt?: number;
  lastAt?: number;
  /** approval id → nome da ferramenta. */
  approvals: Map<string, string>;
  /** callId → nome da ferramenta. */
  calls: Map<string, string>;
}

interface Tracker {
  key: string;
  sessionId: string;
  path: string;
  cwd?: string;
  createdAt?: number;
  internal: boolean;
  /** Subagente: chave do agente que o chamou (`parentSession` do cabeçalho). */
  parent?: string;
  /** Rótulo do subagente (`subagent/descriptor`). */
  label?: string;
  /** Bytes do arquivo já descomprimidos. */
  offset: number;
  /** Linha incompleta do último quadro. */
  carry: string;
  size: number;
  mtimeMs: number;
  state: DshState;
  /** Atividades lidas antes de o agente entrar (vão como histórico). */
  backlog: Activity[];
  inOffice: boolean;
  status: AgentStatus;
  waitingFor?: string;
  seq: number;
}

function newState(): DshState {
  return { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, turnOpen: false, approvals: new Map(), calls: new Map() };
}

/** Descomprime os quadros completos de `buf`; devolve o texto e quantos bytes foram consumidos. */
export function decodeFrames(buf: Buffer): { text: string; used: number } {
  const idx: number[] = [];
  for (let p = buf.indexOf(MAGIC, 0); p !== -1; p = buf.indexOf(MAGIC, p + 1)) idx.push(p);
  if (!idx.length) return { text: '', used: 0 };
  let text = '';
  let start = idx[0];
  let used = 0;
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      used = end;
      start = end;
    } catch {
      // Número mágico dentro dos dados (junta com o próximo) ou quadro ainda incompleto (fica para depois).
    }
  }
  return { text, used };
}

/** Nome de ferramenta do DSH → o equivalente do Claude Code que o describeTool conhece. */
export function describeDshTool(name: string, raw: unknown): { desc: ActivityDescription; tool: string } {
  const input = rec(raw) ?? {};
  const map = (tool: string, args: Rec = input) => ({ desc: describeTool(tool, args), tool });
  switch (name) {
    case 'read':
    case 'read_image':
    case 'modlens_read_image':
      return map('Read', { file_path: input.file_path ?? input.path });
    case 'write':
      return map('Write');
    case 'edit':
      return map('Edit');
    case 'pwsh':
    case 'bash':
    case 'shell':
      return map('Bash', { command: input.command, description: input.description });
    case 'grep':
      return map('Grep');
    case 'glob':
      return map('Glob');
    case 'web_fetch':
      return map('WebFetch');
    case 'web_search':
      return map('WebSearch', { query: Array.isArray(input.queries) ? input.queries[0] : input.query });
    case 'todo_write':
      return map('TodoWrite');
    case 'subagent':
    case 'subagent_fork':
      return map('Agent', { description: input.description, prompt: input.prompt });
    case 'workflow':
      return map('Workflow');
    case 'send_message':
      return map('SendMessage', { to: input.agent, message: input.message });
    case 'list_agents':
      return map('ListAgents');
    case 'ask_user_question':
      return map('AskUserQuestion');
    case 'skill':
      return map('Skill', { skill: input.name });
    case 'job_output':
      return map('TaskOutput');
    case 'job_kill':
      return map('TaskStop');
    case 'wait_agent':
      return { desc: { kind: 'delegate', icon: '⏳', text: tr('Esperando os subagentes') }, tool: name };
    default:
      return { desc: describeTool(name, input), tool: name };
  }
}

function textOf(content: unknown, type = 'text'): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => rec(c))
    .filter((c): c is Rec => !!c && c.type === type && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
}

const TASK_STATUS = new Set(['pending', 'in_progress', 'completed']);

export class DshSource implements AgentSource {
  readonly provider = 'dsh' as const;
  private entry: AccountEntry | undefined;
  private trackers = new Map<string, Tracker>();
  private files: Array<{ path: string; sessionId: string; internal: boolean; sub: boolean }> = [];
  private scannedAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private error?: string;
  private readonly now: () => number;
  private readonly recentMs: number;

  constructor(private readonly opts: DshSourceOptions) {
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    const min = Number(env.HABBLAUD_DSH_RECENT_MIN);
    this.recentMs = (Number.isFinite(min) && min > 0 ? min : 60) * 60_000;
    const taken = opts.accounts.allEntries().map((e) => e.detected.color);
    const color = ['#4d6bfe', '#36c5c0', '#e8c547', '#f08a3c'].find((c) => !taken.includes(c)) ?? '#4d6bfe';
    [this.entry] = opts.accounts.setProviderAccounts('dsh', [
      { dir: opts.dir, detected: { id: '.dsh', configDir: opts.dir, short: 'DS', name: 'DeepSeek Harness', color } },
    ]);
    if (typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync !== 'function') {
      this.error = tr('este Node não tem zstd (precisa do Node 22.15 ou mais novo)');
    }
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entry ? [this.entry] : [];
  }

  start(): void {
    if (this.error) {
      log.warn(tr('DeepSeek Harness: {0}.', [this.error]));
      return;
    }
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => {
      try {
        this.poll(false);
      } catch (err) {
        log.warnOnce('dsh-poll', tr('DeepSeek Harness: falha ao ler as sessões ({0}).', [errMsg(err)]));
      }
    }, this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.inOffice && !t.parent) sessions++;
    const info: SourceInfo = { label: this.entry?.id ?? '.dsh', provider: 'dsh', path: this.opts.dir, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return info.label ? [info] : [];
  }

  /** O `session.v4.jsonl.zstd` da sessão: o terminal o lê com o ZstdTail (dsh/terminal.ts). */
  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackers.get(agentId);
    // Subagente concluído continua legível enquanto ainda está na sala (entregando).
    return t && (t.inOffice || this.opts.office.has(agentId)) ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createDshTerminalParser() : undefined;
  }

  // ---------------------------------------------------------------- ciclo

  private scan(now: number): void {
    if (now - this.scannedAt < SCAN_EVERY_MS) return;
    this.scannedAt = now;
    const root = join(this.opts.dir, 'sessions');
    const out: typeof this.files = [];
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      this.files = [];
      return;
    }
    for (const d of dirs) {
      if (d.startsWith('_')) continue; // _archive
      const internal = /-\.dsh-botharness/i.test(d);
      let subs: string[];
      try {
        subs = readdirSync(join(root, d));
      } catch {
        continue;
      }
      for (const s of subs) {
        // `session-<uuid>`: sessão aberta pelo usuário; `<uuid>`: subagente (o pai vem no cabeçalho).
        const main = s.startsWith('session-');
        if (!main && !UUID_RE.test(s)) continue;
        out.push({ path: join(root, d, s, 'session.v4.jsonl.zstd'), sessionId: main ? s.slice('session-'.length) : s, internal, sub: !main });
      }
    }
    // Pais antes dos filhos: o subagente só entra com o agente que o chamou já no escritório.
    out.sort((a, b) => Number(a.sub) - Number(b.sub));
    this.files = out;
  }

  /** Um ciclo: relê a lista de sessões (no máximo a cada SCAN_EVERY_MS) e o que cada arquivo ganhou. Público para os testes. */
  poll(boot = false): void {
    const now = this.now();
    this.scan(now);
    const seen = new Set<string>();
    for (const f of this.files) {
      if (f.internal) continue;
      const key = `${this.entry?.id ?? '.dsh'}:${f.sessionId}`;
      let st;
      try {
        st = statSync(f.path);
      } catch {
        continue;
      }
      let t = this.trackers.get(key);
      const recent = now - st.mtimeMs < this.recentMs;
      if (!t && !recent) continue;
      seen.add(key);
      if (!t) {
        t = { key, sessionId: f.sessionId, path: f.path, internal: false, offset: 0, carry: '', size: 0, mtimeMs: 0, state: newState(), backlog: [], inOffice: false, status: 'idle', seq: 0 };
        this.trackers.set(key, t);
      }
      if (st.size !== t.size || st.mtimeMs !== t.mtimeMs) this.read(t, st.size, boot || !t.inOffice);
      t.size = st.size;
      t.mtimeMs = st.mtimeMs;
      this.settle(t, now);
      // Subagente que o escritório já tirou (concluído há um tempo, ou o pai saiu).
      if (t.parent && t.inOffice && !this.opts.office.has(key)) t.inOffice = false;
      const busy = t.status === 'working' || t.status === 'waiting';
      const want = t.internal || !t.cwd ? false : t.parent ? busy && this.present(t.parent) : recent || busy;
      if (want && !t.inOffice) this.enter(t);
      else if (!want && t.inOffice) this.leave(t);
      if (!want && !t.inOffice && !recent) this.trackers.delete(key);
      if (t.inOffice) this.opts.office.fillWorkingActivity(t.key);
    }
    for (const [key, t] of this.trackers) {
      if (seen.has(key)) continue;
      this.leave(t);
      this.trackers.delete(key);
    }
  }

  /** Lê o que for novo no arquivo (desde t.offset). `history` = sem feed (carga inicial). */
  private read(t: Tracker, size: number, history: boolean): void {
    if (size < t.offset) {
      // Reescrito: começa de novo.
      t.offset = 0;
      t.carry = '';
      t.state = newState();
      t.backlog = [];
    }
    if (size <= t.offset) return;
    const len = size - t.offset;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(t.path, 'r');
    try {
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, t.offset + got);
        if (n <= 0) break;
        got += n;
      }
    } finally {
      closeSync(fd);
    }
    const { text, used } = decodeFrames(buf);
    if (!used) return;
    t.offset += used;
    const lines = (t.carry + text).split('\n');
    t.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: Rec | undefined;
      try {
        ev = rec(JSON.parse(line));
      } catch {
        continue;
      }
      if (ev) this.apply(t, ev, !history && t.inOffice);
    }
    this.summary(t);
  }

  private apply(t: Tracker, ev: Rec, live: boolean): void {
    const s = t.state;
    const type = str(ev.type) ?? '';
    const data = rec(ev.data) ?? {};
    const at = num(ev.time) || this.now();
    if (type === 'session') {
      t.cwd = str(ev.cwd);
      t.createdAt = num(ev.createdAt) || undefined;
      if (t.cwd && /[\\/]\.dsh[\\/]botharness/i.test(t.cwd)) t.internal = true;
      const parent = str(ev.parentSession);
      if (parent) t.parent = `${this.entry?.id ?? '.dsh'}:${parent.replace(/^session-/, '')}`;
      return;
    }
    if (type === 'subagent/descriptor') {
      const label = str(data.label);
      if (label) t.label = truncate(maskSecrets(label), 120);
      return;
    }
    s.firstAt ??= at;
    s.lastAt = at;
    const act = (d: ActivityDescription & { tool?: string; error?: boolean }, current = true) => this.activity(t, { id: `${t.key}#${++t.seq}`, at, ...d }, current, live);
    switch (type) {
      case 'turn/start':
        s.turnOpen = true;
        s.turnStartAt = at;
        s.approvals.clear();
        this.decide(t, 'working', live);
        break;
      case 'turn/end': {
        s.turnOpen = false;
        s.approvals.clear();
        const reason = rec(data.reason);
        const kind = str(reason?.kind);
        if (kind === 'error') act(SPECIAL.error(undefined, str(rec(reason?.error)?.message)));
        else if (kind === 'interrupted' || kind === 'aborted' || kind === 'cancelled') act(SPECIAL.interrupted());
        else act(SPECIAL.turnDone(s.turnStartAt ? at - s.turnStartAt : undefined));
        this.decide(t, 'idle', live);
        break;
      }
      case 'session/title': {
        const title = str(data.title);
        if (title) s.title = truncate(maskSecrets(title), 120);
        break;
      }
      case 'request/context': {
        const model = str(data.model);
        if (model) s.model = model;
        break;
      }
      case 'user/message': {
        if (str(rec(data.source)?.kind) !== 'user') break;
        const text = textOf(data.content);
        if (!text) break;
        s.title ??= truncate(maskSecrets(text.slice(0, 500)), 120);
        act(describePrompt(truncate(maskSecrets(text.slice(0, 1_000)), 300)));
        break;
      }
      case 'assistant/message': {
        const message = rec(data.message);
        const model = str(rec(message?.source)?.model);
        if (model) s.model = model;
        const usage = rec(data.usage);
        if (usage) {
          s.stats.tokensIn += num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
          s.stats.tokensOut += num(usage.outputTokens);
        }
        if (textOf(message?.content, 'reasoning')) act(SPECIAL.think());
        const text = textOf(message?.content);
        if (text) act(SPECIAL.respond(truncate(maskSecrets(text.slice(0, 1_000)), 300)));
        break;
      }
      case 'tool/call': {
        const name = str(data.name) ?? 'tool';
        let args: unknown = data.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const callId = str(data.callId);
        if (callId) s.calls.set(callId, name);
        s.stats.toolCalls++;
        if (name === 'subagent' || name === 'subagent_fork') s.stats.subagents++;
        if (name === 'todo_write') this.todos(t, rec(args)?.todos);
        const { desc, tool } = describeDshTool(name, args);
        act({ ...desc, tool });
        break;
      }
      case 'tool/result': {
        const message = rec(data.message);
        if (message?.isError !== true) break;
        const tool = s.calls.get(str(message.toolCallId) ?? '') ?? undefined;
        act({ ...SPECIAL.error(tool, truncate(maskSecrets(textOf(message.content).slice(0, 600)), 300)), tool }, false);
        break;
      }
      case 'todo/write':
        this.todos(t, data.todos);
        break;
      case 'approval/asked': {
        const id = str(data.id) ?? String(at);
        const tool = str(data.toolName) ?? 'tool';
        s.approvals.set(id, tool);
        act(SPECIAL.waiting(tr('aprovar {0}', [tool])));
        this.decide(t, 'waiting', live, tr('aprovar {0}', [tool]));
        break;
      }
      case 'approval/decided': {
        s.approvals.delete(str(data.id) ?? '');
        if (!s.approvals.size && s.turnOpen) this.decide(t, 'working', live);
        break;
      }
      case 'compaction/start':
        act(SPECIAL.compact());
        break;
      default:
        break;
    }
  }

  private todos(t: Tracker, raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const out: TaskItem[] = [];
    raw.forEach((x, i) => {
      const r = rec(x);
      const title = str(r?.content) ?? str(r?.title);
      if (!r || !title) return;
      const status = typeof r.status === 'string' && TASK_STATUS.has(r.status) ? (r.status as TaskStatus) : 'pending';
      out.push({ id: String(i + 1), title: truncate(maskSecrets(title.slice(0, 480)), 120), status });
    });
    t.state.tasks = out;
  }

  private activity(t: Tracker, a: Activity, current: boolean, live: boolean): void {
    if (live && t.inOffice) {
      this.opts.office.addActivity(t.key, a, current, { feed: true });
      return;
    }
    t.backlog.push(a);
    if (t.backlog.length > HISTORY_MAX) t.backlog.splice(0, t.backlog.length - HISTORY_MAX);
  }

  private decide(t: Tracker, status: AgentStatus, live: boolean, waitingFor?: string): void {
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (!live || !t.inOffice) return;
    const office = this.opts.office;
    if (t.parent) {
      // Subagente: fim do turno = entregou o trabalho; turno novo = voltou a trabalhar.
      if (status === 'idle') return office.completeSub(t.key);
      office.reactivateSub(t.key);
    }
    office.setStatus(t.key, status, t.waitingFor);
  }

  /** O agente `key` (pai de um subagente) está no escritório. */
  private present(key: string): boolean {
    return !!this.trackers.get(key)?.inOffice && this.opts.office.has(key);
  }

  /** Turno aberto sem escrita por muito tempo (crash): vira idle. */
  private settle(t: Tracker, now: number): void {
    if ((t.status === 'working' || t.status === 'waiting') && now - t.mtimeMs > WORKING_QUIET_MS) {
      t.state.turnOpen = false;
      t.state.approvals.clear();
      this.decide(t, 'idle', true);
    }
  }

  private enter(t: Tracker): void {
    const office = this.opts.office;
    if (t.parent) {
      const sub: SubInput = {
        id: t.key,
        parentId: t.parent,
        sessionId: t.sessionId,
        role: SUB_ROLE,
        background: false,
        startedAt: t.createdAt ?? t.state.firstAt ?? this.now(),
      };
      const title = t.label ?? t.state.title;
      if (title) sub.title = title;
      if (!office.addSub(sub)) return;
    } else office.addMain({
      id: t.key,
      provider: 'dsh',
      account: this.entry?.id ?? '.dsh',
      sessionId: t.sessionId,
      cwd: t.cwd!,
      role: MAIN_ROLE,
      startedAt: t.createdAt ?? t.state.firstAt ?? this.now(),
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (!t.inOffice) return;
    office.setStatus(t.key, t.status, t.waitingFor);
    const backlog = t.backlog;
    t.backlog = [];
    for (const a of backlog) office.addActivity(t.key, a, true, { feed: false });
    this.summary(t);
  }

  private leave(t: Tracker): void {
    if (!t.inOffice) return;
    if (t.parent) this.opts.office.completeSub(t.key, { notify: false });
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  private summary(t: Tracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const sum: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) sum.title = s.title;
    if (s.model) sum.model = s.model;
    if (s.firstAt !== undefined) sum.firstAt = s.firstAt;
    if (s.lastAt !== undefined) sum.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.key, sum);
  }
}
