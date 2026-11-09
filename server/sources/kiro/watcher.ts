// Observador das sessões abertas do Kiro CLI (<pasta>/sessions/cli/<uuid>.lock, .json e .jsonl).
// - Aberta = o .lock aponta para um processo do Kiro vivo (liveness.ts; PID reaproveitado não conta).
// - Ao achar uma sessão, relê o transcript (até REPLAY_MAX_BYTES do fim) com os horários reais: o Prompt tem
//   meta.timestamp e o .json traz o fim e a duração de cada turno (user_turn_metadatas), que cobrem os message_ids
//   das linhas. A releitura vai só para o histórico (sem feed ao vivo, sem avisos) e o status sai da última linha.
// - Depois, cada linha nova vira atividade ao vivo. O .json mudar fecha o turno que ficou aberto (Ctrl+C, ferramenta
//   recusada, erro) e atualiza tokens, modelo e título.
// - Ferramenta pendente (toolUse sem ToolResults) com o processo do Kiro parado (sem I/O e sem processo novo debaixo
//   dele) vira "Precisa de você: aprovar uma permissão" (só com /proc, Linux/WSL; HABBLAUD_KIRO_APPROVAL=0 desliga).
//   Ver checkApproval.
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStats, AgentStatus } from '../../../shared/types';
import { describePrompt, SPECIAL, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { FileTail } from '../tail';
import { chooseLivenessMode, createLiveness, pidAlive, type KiroLiveness, type KiroLivenessMode } from './liveness';
import type { KiroHookPayload } from './live';
import { cleanKiroPrompt, cleanKiroTitle, KIRO_SHELL_TOOLS, parseKiroJsonlLine, sameKiroTool, type KiroParsedLine, type KiroToolUse } from './parser';

export { pidAlive };

export const STALE_LOCK_MS = 12 * 3600_000;
/** Quanto do fim de um transcript grande reler ao achar a sessão. */
export const REPLAY_MAX_BYTES = 4 * 1024 * 1024;
/** Atividades da releitura que entram no histórico do agente. */
const REPLAY_MAX_ACTIVITIES = 200;
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'use_subagent', 'delegate']);

/** Quanto esperar o ToolResults antes de achar que a ferramenta espera aprovação (Infinity = nunca). */
export function approvalGraceMs(tool: string): number {
  return SUBAGENT_TOOLS.has(tool) ? Infinity : 2_500;
}
/** Processo sem ler nem escrever nada por este tempo = parado esperando você. */
export const APPROVAL_QUIET_MS = 2_000;
/** I/O mexendo sem parar por este tempo = o Kiro voltou a trabalhar (sai do "esperando aprovação"). */
// Medido num Kiro 2.16 parado no pedido de aprovação: surtos soltos de até ~1,5 s (a tela redesenhando) a cada
// poucos segundos; trabalhando, o spinner e a rede mexem a cada 500 ms sem parar.
const IO_BUSY_MS = 4_000;

// ------------------------------------------------------------------ .json da sessão

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface KiroTurn {
  ids: string[];
  start: number;
  end: number;
  reason: string;
}

export interface KiroMeta {
  cwd: string;
  title?: string;
  role?: string;
  model?: string;
  turns: KiroTurn[];
  /** Ferramenta MCP -> servidor (das ferramentas confiáveis da sessão). */
  mcpServers: Map<string, string>;
  tokensIn: number;
  tokensOut: number;
}

export function readKiroMeta(path: string): KiroMeta | undefined {
  let m: Obj;
  try {
    m = obj(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
  const state = obj(m.session_state);
  const conv = obj(state.conversation_metadata);
  const list = Array.isArray(conv.user_turn_metadatas) ? conv.user_turn_metadatas.map(obj) : [];
  const turns: KiroTurn[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | undefined;
  let loopAgent: string | undefined;
  for (const t of list) {
    const end = Date.parse(str(t.end_timestamp));
    const dur = obj(t.turn_duration);
    const ms = num(dur.secs) * 1000 + num(dur.nanos) / 1e6;
    const ids = Array.isArray(t.message_ids) ? t.message_ids.filter((x): x is string => typeof x === 'string') : [];
    if (!Number.isNaN(end)) turns.push({ ids, end, start: end - ms, reason: str(t.end_reason) });
    tokensIn += num(t.input_token_count) + num(t.cache_read_input_token_count) + num(t.cache_write_input_token_count);
    tokensOut += num(t.output_token_count);
    if (str(t.model)) model = str(t.model);
    loopAgent ??= str(obj(obj(t.loop_id).agent_id).name) || undefined;
  }
  const info = obj(obj(state.rts_model_state).model_info);
  model = str(info.model_name) || str(info.model_id) || model;
  const agent = kiroRole(str(state.agent_name) || loopAgent);
  const mcpServers = new Map<string, string>();
  const trusted = obj(state.permissions).trusted_tools;
  for (const t of Array.isArray(trusted) ? trusted : []) {
    const mcp = obj(obj(t).Mcp);
    if (str(mcp.tool_name) && str(mcp.server_name)) mcpServers.set(str(mcp.tool_name), str(mcp.server_name));
  }
  return {
    cwd: str(m.cwd),
    ...(str(m.title) ? { title: str(m.title) } : {}),
    ...(agent ? { role: agent } : {}),
    ...(model ? { model } : {}),
    turns,
    mcpServers,
    tokensIn,
    tokensOut,
  };
}

/** Papel do agente: "kiro_default" -> "default"; agente gerado pelo Kiro Crew ("kirocrew-x-<hash>") -> "x". */
export function kiroRole(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const r = name
    .replace(/^kiro_/, '')
    .replace(/^kirocrew-/, '')
    .replace(/-[0-9a-f]{16,}$/i, '');
  return r || undefined;
}

/** Horário de cada message_id: os do turno espalhados entre o início e o fim dele (a última no fim). */
export function turnTimes(turns: readonly KiroTurn[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of turns) {
    const n = t.ids.length;
    t.ids.forEach((id, k) => out.set(id, n > 1 ? t.start + ((t.end - t.start) * k) / (n - 1) : t.end));
  }
  return out;
}

/** Turno já fechado que contém a mensagem (a última lida): a sessão não está mais trabalhando nele. */
export function closingTurn(turns: readonly KiroTurn[], messageId: string | undefined): KiroTurn | undefined {
  if (!messageId) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].ids.includes(messageId)) return turns[i];
  return undefined;
}

// ------------------------------------------------------------------ watcher

export interface KiroWatcherDeps {
  office: Office;
  sessionsDir: string;
  /** Id da conta (AccountsService) dos agentes desta pasta. */
  account?: string;
  pollMs?: number;
  now?: () => number;
  inDocker?: boolean;
  /** true = só process.kill(pid, 0); false = só mtime. Ausente = o melhor da plataforma (liveness.ts). */
  checkPid?: boolean;
  liveness?: KiroLiveness;
  /** Detecta "esperando aprovação" (padrão: ligado, HABBLAUD_KIRO_APPROVAL=0 desliga). */
  approval?: boolean;
  staleMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface Paths {
  lock: string;
  json: string;
  jsonl: string;
}

interface ActiveKiroSession {
  sessionId: string;
  pid: number;
  startedAt: number;
  paths: Paths;
  role: string;
  title?: string;
  tail?: FileTail;
  lineCount: number;
  metaMtime: number;
  lastMessageId?: string;
  pending: Map<string, KiroToolUse>;
  pendingSince?: number;
  /** "Precisa de você" que nós deduzimos (ferramenta parada): sai sozinho quando o processo volta a trabalhar. */
  approvalWait: boolean;
  /** Última leitura do I/O do processo e quando ele mudou por último. */
  io?: { r: number; w: number };
  ioChangedAt: number;
  /** Desde quando o I/O mexe sem parar (leituras seguidas com mudança); undefined = parado na última leitura. */
  ioBusySince?: number;
  status: AgentStatus;
  mcpServers: Map<string, string>;
  stats: AgentStats;
  model?: string;
  /** A sessão manda eventos do hook (mod/habblaud-kiro): o PostToolUse diz quando cada ferramenta terminou. */
  hooks: boolean;
  hookSeq: number;
  /** O pedido já entrou pelo UserPromptSubmit: o Prompt do transcript não vira outra atividade. */
  hookPrompt: boolean;
  /** toolUseIds que o PostToolUse já fechou (o ToolResults só vem com a resposta seguinte). */
  finished: Set<string>;
  /** PostToolUse que chegou antes de a linha do toolUse ser lida (nome da ferramenta). */
  doneEarly: string[];
  /** Stop do hook: se a resposta final não aparecer no transcript logo, fecha o turno assim mesmo. */
  stopAt?: number;
}

/** Ferramentas que rodam dentro do Kiro em milissegundos: paradas sem PostToolUse = esperando aprovação. */
export const QUICK_TOOLS: ReadonlySet<string> = new Set([
  'read', 'fs_read', 'read_file', 'write', 'fs_write', 'write_file', 'str_replace', 'fs_append', 'delete_file', 'glob', 'grep', 'file_search',
  'grep_search', 'list_directory', 'todo_list', 'introspect', 'knowledge', 'summary',
]);
/** Ferramenta rápida sem PostToolUse por este tempo = pedido de aprovação na tela. */
export const HOOK_QUICK_GRACE_MS = 2_500;
/** Depois do Stop, quanto esperar a resposta final no transcript antes de fechar o turno pelo hook. */
const STOP_GRACE_MS = 1_500;

function freshest(p: Paths): number {
  let best = 0;
  for (const f of [p.lock, p.json, p.jsonl]) {
    try {
      best = Math.max(best, statSync(f).mtimeMs);
    } catch {
      // ainda não existe
    }
  }
  return best;
}

export class KiroWatcher {
  readonly liveness: KiroLiveness;
  private readonly office: Office;
  private readonly sessionsDir: string;
  private readonly account: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly approval: boolean;
  private readonly staleMs: number;
  private active = new Map<string, ActiveKiroSession>();
  private timer?: NodeJS.Timeout;
  private fsWatcher?: FSWatcher;
  private running = false;

  constructor(deps: KiroWatcherDeps) {
    const env = deps.env ?? process.env;
    this.office = deps.office;
    this.sessionsDir = deps.sessionsDir;
    this.account = deps.account ?? '.kiro';
    this.pollMs = deps.pollMs ?? 2_000;
    this.now = deps.now ?? Date.now;
    this.staleMs = deps.staleMs ?? STALE_LOCK_MS;
    this.approval = deps.approval ?? env.HABBLAUD_KIRO_APPROVAL?.trim() !== '0';
    const forced: KiroLivenessMode | undefined = deps.checkPid === true ? 'pid' : deps.checkPid === false ? 'mtime' : undefined;
    this.liveness = deps.liveness ?? createLiveness(forced ?? chooseLivenessMode({ env, sessionsDir: deps.sessionsDir, inDocker: deps.inDocker }));
  }

  /** Como as sessões abertas são reconhecidas (para o log do início). */
  livenessLabel(): string {
    const m = this.liveness.mode;
    if (m === 'mtime') return tr('arquivos mexidos nas últimas {0} h', [Math.round(this.staleMs / 3600_000)]);
    if (m !== 'pid' && this.liveness.isKiro(-1) === undefined) return tr('{0} indisponível, arquivos mexidos nas últimas {1} h', [m, Math.round(this.staleMs / 3600_000)]);
    return m === 'pid' ? 'PID' : tr('processo ({0})', [m === 'proc' ? '/proc' : m]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (existsSync(this.sessionsDir)) {
      this.office.beginBoot();
      try {
        this.scan();
      } finally {
        this.office.endBoot();
      }
      this.watchDir();
    } else {
      log.info(tr('Kiro: diretório de sessões não encontrado ({0}), aguardando...', [this.sessionsDir]));
    }

    this.timer = setInterval(() => {
      if (!this.fsWatcher && existsSync(this.sessionsDir)) this.watchDir();
      this.scan();
    }, this.pollMs);
    this.timer.unref();
  }

  private watchDir(): void {
    try {
      this.fsWatcher = watch(this.sessionsDir, () => this.scan());
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = undefined; // segue no polling
      });
    } catch (err) {
      log.warnOnce(`kiro-watch:${this.sessionsDir}`, tr('Kiro: falha ao criar watcher fs ({0}), usando polling.', [errMsg(err)]));
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignora
      }
      this.fsWatcher = undefined;
    }
    this.active.clear();
  }

  sessionCount(): number {
    return this.active.size;
  }

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  transcriptPathOf(sessionId: string): string | undefined {
    const candidate = join(this.sessionsDir, `${sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : undefined;
  }

  private pathsOf(sessionId: string): Paths {
    return {
      lock: join(this.sessionsDir, `${sessionId}.lock`),
      json: join(this.sessionsDir, `${sessionId}.json`),
      jsonl: join(this.sessionsDir, `${sessionId}.jsonl`),
    };
  }

  private alive(pid: number, paths: Paths, now: number): boolean {
    if (this.liveness.mode !== 'mtime') {
      const v = this.liveness.isKiro(pid);
      if (v !== undefined) return v;
      if (this.liveness.mode === 'pid') return false;
      // a lista de processos não veio (método falhou): o mtime decide
    }
    return now - freshest(paths) <= this.staleMs;
  }

  scan(): void {
    if (!existsSync(this.sessionsDir)) return;

    let entries: string[] = [];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch (err) {
      log.warn(tr('Kiro: erro ao listar sessões ({0})', [errMsg(err)]));
      return;
    }

    const now = this.now();
    const locks = entries.filter((f) => f.endsWith('.lock'));
    if (locks.length) this.liveness.refresh?.(now);
    const live = new Set<string>();

    for (const file of locks) {
      const sessionId = file.slice(0, -5);
      const paths = this.pathsOf(sessionId);
      if (!existsSync(paths.json)) continue;

      let lock: { pid?: unknown; started_at?: unknown };
      try {
        lock = JSON.parse(readFileSync(paths.lock, 'utf8')) as typeof lock;
      } catch {
        if (this.active.has(sessionId)) live.add(sessionId); // lock sendo reescrito: fica como está
        continue;
      }
      const pid = typeof lock.pid === 'number' ? lock.pid : 0;
      const startedAt = (typeof lock.started_at === 'string' && Date.parse(lock.started_at)) || now;
      if (!this.alive(pid, paths, now)) continue;

      live.add(sessionId);
      const cur = this.active.get(sessionId);
      if (cur) cur.pid = pid; // a mesma sessão retomada por outro processo
      else this.track(sessionId, pid, startedAt, paths);
    }

    for (const s of this.active.values()) this.pump(s);

    for (const id of [...this.active.keys()]) {
      if (live.has(id)) continue;
      this.active.delete(id);
      this.office.closeMain(id);
    }
  }

  private parse(s: ActiveKiroSession, line: string, now: number): KiroParsedLine | undefined {
    s.lineCount++;
    return parseKiroJsonlLine(line, s.lineCount, now, { idPrefix: s.sessionId, mcpServers: s.mcpServers });
  }

  /** Pendências, contagens e erros de uma linha. Devolve atividades extras (ferramenta que falhou). */
  private note(s: ActiveKiroSession, p: KiroParsedLine, at: number): Activity[] {
    const extra: Activity[] = [];
    if (p.messageId) s.lastMessageId = p.messageId;
    if (p.kind === 'Prompt' || p.turnEnd) {
      s.pending.clear();
      s.finished.clear();
      if (p.turnEnd) s.doneEarly = [];
    }
    if (p.turnEnd) s.stopAt = undefined;
    if (p.tools?.length) {
      for (const t of p.tools) {
        s.pending.set(t.id, t);
        const early = s.doneEarly.findIndex((n) => sameKiroTool(n, t.name));
        if (early >= 0) {
          s.doneEarly.splice(early, 1);
          s.finished.add(t.id);
        }
      }
      s.pendingSince = at;
      s.stats.toolCalls += p.tools.length;
      s.stats.subagents += p.tools.filter((t) => SUBAGENT_TOOLS.has(t.name)).length;
    }
    for (const r of p.results ?? []) {
      const t = s.pending.get(r.id);
      s.pending.delete(r.id);
      s.finished.delete(r.id);
      if (r.error) extra.push({ id: `${s.sessionId}#${r.id}:err`, at, ...SPECIAL.error(t?.name), error: true });
    }
    if (!s.pending.size) s.pendingSince = undefined;
    return extra;
  }

  /** Atividade de um turno que fechou sem resposta final (Ctrl+C, ferramenta recusada, erro). */
  private closedTurnActivity(s: ActiveKiroSession, turn: { reason: string; end: number }): Activity | undefined {
    const id = `${s.sessionId}#end:${turn.end}`;
    const first = s.pending.values().next().value as KiroToolUse | undefined;
    if (turn.reason === 'Cancelled') return { id, at: turn.end, ...SPECIAL.interrupted() };
    if (turn.reason === 'ToolUseRejected') return { id, at: turn.end, ...SPECIAL.rejected(first?.label) };
    if (turn.reason === 'Error') return { id, at: turn.end, ...SPECIAL.error(), error: true };
    return undefined;
  }

  private track(sessionId: string, pid: number, startedAt: number, paths: Paths): void {
    const meta = readKiroMeta(paths.json);
    if (!meta?.cwd) return;
    let metaMtime = 0;
    try {
      metaMtime = statSync(paths.json).mtimeMs;
    } catch {
      return;
    }

    const s: ActiveKiroSession = {
      sessionId,
      pid,
      startedAt,
      paths,
      role: meta.role || tr('Agente do Kiro'),
      lineCount: 0,
      metaMtime,
      pending: new Map(),
      approvalWait: false,
      ioChangedAt: 0,
      status: 'idle',
      mcpServers: meta.mcpServers,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      hooks: false,
      hookSeq: 0,
      hookPrompt: false,
      finished: new Set(),
      doneEarly: [],
    };

    // Releitura com os horários dos turnos; o status sai da última linha (ou do turno fechado no .json).
    const tail = new FileTail(paths.jsonl);
    if (existsSync(paths.jsonl)) tail.seekTail(REPLAY_MAX_BYTES);
    const times = turnTimes(meta.turns);
    const acts: Activity[] = [];
    let status: AgentStatus = 'idle';
    let waitingFor: string | undefined;
    // Sessão retomada (--resume) ganha lock novo: as linhas antigas são de antes do started_at dele.
    let lastAt = 0;
    let firstPrompt: string | undefined;
    for (let res = tail.read(); ; res = tail.read()) {
      for (const line of res.lines) {
        const p = this.parse(s, line, lastAt || startedAt);
        if (!p) continue;
        const at = p.promptAt ?? (p.messageId !== undefined ? times.get(p.messageId) : undefined) ?? (lastAt || startedAt);
        if (at > lastAt) lastAt = at;
        for (const a of p.activities) acts.push(a.kind === 'prompt' ? a : { ...a, at });
        acts.push(...this.note(s, p, at));
        if (p.status) {
          status = p.status;
          waitingFor = p.waitingFor;
        }
        if (!firstPrompt && p.promptText) firstPrompt = p.promptText;
      }
      if (!res.more) break;
    }
    const closed = status !== 'idle' ? closingTurn(meta.turns, s.lastMessageId) : undefined;
    if (closed) {
      const a = this.closedTurnActivity(s, closed);
      if (a) acts.push(a);
      s.pending.clear();
      s.pendingSince = undefined;
      status = 'idle';
      waitingFor = undefined;
    }
    // A ferramenta pendente começou quando a última linha foi escrita.
    if (s.pending.size) {
      try {
        s.pendingSince = statSync(paths.jsonl).mtimeMs;
      } catch {
        s.pendingSince = this.now();
      }
    }

    s.status = status;
    s.tail = tail;
    this.active.set(sessionId, s);
    this.office.addMain({
      id: sessionId,
      provider: 'kiro',
      account: this.account,
      sessionId,
      cwd: meta.cwd,
      role: s.role,
      startedAt,
      status,
      ...(waitingFor ? { waitingFor } : {}),
    });
    this.applyMeta(s, meta, firstPrompt, lastAt);
    const keep = acts.slice(-REPLAY_MAX_ACTIVITIES);
    keep.forEach((a, i) => this.office.addActivity(sessionId, a, i === keep.length - 1, { feed: false }));
  }

  private applyMeta(s: ActiveKiroSession, meta: KiroMeta, firstPrompt?: string, lastAt?: number): void {
    if (meta.mcpServers.size) s.mcpServers = meta.mcpServers;
    s.title = cleanKiroTitle(meta.title) ?? (firstPrompt ? truncate(firstPrompt, 90) : undefined) ?? s.title;
    s.model = meta.model ?? s.model;
    s.stats.tokensIn = meta.tokensIn;
    s.stats.tokensOut = meta.tokensOut;
    this.publish(s, lastAt);
  }

  /** Título, números e modelo no Office (as contagens de ferramentas mudam a cada linha; os tokens, com o .json). */
  private publish(s: ActiveKiroSession, lastAt?: number): void {
    this.office.applyTranscript(s.sessionId, {
      ...(s.title ? { title: s.title } : {}),
      tasks: [],
      stats: { ...s.stats },
      ...(s.model ? { model: s.model } : {}),
      ...(lastAt ? { lastAt } : {}),
    });
  }

  private setStatus(s: ActiveKiroSession, status: AgentStatus, waitingFor?: string): void {
    s.status = status;
    this.office.setStatus(s.sessionId, status, waitingFor);
  }

  private pump(s: ActiveKiroSession): void {
    if (s.tail) {
      const calls = s.stats.toolCalls;
      for (let res = s.tail.read(); ; res = s.tail.read()) {
        for (const line of res.lines) {
          const now = this.now();
          const p = this.parse(s, line, now);
          if (!p) continue;
          const extra = this.note(s, p, now);
          if (p.status) s.approvalWait = false;
          if (!s.title && p.promptText) s.title = truncate(p.promptText, 90);
          // O pedido que o UserPromptSubmit já mostrou não entra de novo.
          const fromHook = p.kind === 'Prompt' && s.hookPrompt;
          if (fromHook) s.hookPrompt = false;
          for (const a of [...p.activities, ...extra]) if (!(fromHook && a.kind === 'prompt')) this.office.addActivity(s.sessionId, a, true);
          if (p.status && !(fromHook && s.status === 'working')) this.setStatus(s, p.status, p.waitingFor);
        }
        if (!res.more) break;
      }
      if (s.stats.toolCalls !== calls) this.publish(s);
    }
    this.refreshMeta(s);
    if (s.stopAt !== undefined && s.status !== 'idle' && this.now() - s.stopAt >= STOP_GRACE_MS) this.endTurn(s);
    this.checkApproval(s);
  }

  private endTurn(s: ActiveKiroSession): void {
    s.pending.clear();
    s.finished.clear();
    s.doneEarly = [];
    s.pendingSince = undefined;
    s.approvalWait = false;
    s.stopAt = undefined;
    this.setStatus(s, 'idle');
  }

  /**
   * Evento do hook (mod/habblaud-kiro) de uma sessão que este watcher acompanha. O transcript continua sendo a fonte
   * das atividades; o hook adianta o começo do turno (o Kiro só grava o pedido junto com a primeira resposta), diz quando
   * cada ferramenta terminou e fecha o turno no Stop. false = sessão desconhecida.
   */
  applyHook(sessionId: string, e: KiroHookPayload): boolean {
    const s = this.active.get(sessionId);
    if (!s) return false;
    s.hooks = true;
    this.pump(s);
    const now = this.now();
    switch (e.hook_event_name) {
      case 'UserPromptSubmit': {
        const text = cleanKiroPrompt(e.prompt ?? '');
        s.pending.clear();
        s.finished.clear();
        s.doneEarly = [];
        s.pendingSince = undefined;
        s.approvalWait = false;
        s.stopAt = undefined;
        s.hookPrompt = true;
        if (!s.title && text) {
          s.title = truncate(text, 90);
          this.publish(s);
        }
        const d = text ? describePrompt(text) : { kind: 'prompt' as const, icon: '📨', text: tr('Recebeu um pedido') };
        this.office.addActivity(sessionId, { id: `${sessionId}#hp${++s.hookSeq}`, at: now, ...d }, true);
        this.setStatus(s, 'working');
        break;
      }
      case 'PostToolUse': {
        const name = e.tool_name ?? '';
        const t = [...s.pending.values()].find((x) => !s.finished.has(x.id) && sameKiroTool(x.name, name));
        if (t) s.finished.add(t.id);
        else if (name) s.doneEarly.push(name);
        this.checkApproval(s);
        break;
      }
      case 'Stop':
        if (s.status !== 'idle') s.stopAt = now;
        break;
      default:
        break; // AgentSpawn e PreToolUse: o transcript já mostra
    }
    return true;
  }

  /** O .json mudou: tokens, modelo e título novos; um turno fechado sem resposta final encerra o trabalho. */
  private refreshMeta(s: ActiveKiroSession): void {
    let mtime: number;
    try {
      mtime = statSync(s.paths.json).mtimeMs;
    } catch {
      return;
    }
    if (mtime === s.metaMtime) return;
    const meta = readKiroMeta(s.paths.json);
    if (!meta) return; // escrita pela metade: tenta na próxima
    s.metaMtime = mtime;
    this.applyMeta(s, meta);
    if (s.status === 'idle') return;
    const closed = closingTurn(meta.turns, s.lastMessageId);
    if (!closed) return;
    const a = this.closedTurnActivity(s, closed);
    if (a) this.office.addActivity(s.sessionId, a, true);
    s.pending.clear();
    s.pendingSince = undefined;
    s.approvalWait = false;
    this.setStatus(s, 'idle');
  }

  /**
   * Esperando aprovação? O Kiro grava o ToolResults só junto com a resposta seguinte do modelo, então "toolUse sem
   * resultado" também é "a ferramenta já rodou e o modelo está pensando". O que separa os dois é o processo: pedindo
   * aprovação ele fica parado (nem lê, nem escreve); esperando o modelo, lê da rede e mexe no spinner. Um comando de
   * shell calado (sleep) não faz I/O no Kiro, mas aparece como processo novo debaixo dele. Só com /proc (Linux/WSL).
   */
  private checkApproval(s: ActiveKiroSession): void {
    if (!this.approval || !s.pending.size || s.pendingSince === undefined) return;
    if (s.status !== 'working' && !(s.status === 'waiting' && s.approvalWait)) return;
    const now = this.now();
    const tools = [...s.pending.values()].filter((t) => !s.finished.has(t.id));
    if (s.hooks) {
      // Com o hook não há dúvida entre "a ferramenta já rodou e o modelo está pensando" e "esperando você": o
      // PostToolUse fecha cada uma. Ferramenta rápida sem PostToolUse = pedido de aprovação (em qualquer sistema).
      if (!tools.length) {
        if (s.approvalWait) {
          s.approvalWait = false;
          this.setStatus(s, 'working');
        }
        return;
      }
      if (tools.every((t) => QUICK_TOOLS.has(t.name))) {
        if (!s.approvalWait && now - s.pendingSince >= HOOK_QUICK_GRACE_MS) {
          s.approvalWait = true;
          this.setStatus(s, 'waiting', tr('aprovar uma permissão'));
        }
        return;
      }
    }
    if (!this.liveness.io) return;
    const io = this.liveness.io(s.pid);
    if (!io) return;
    const moved = s.io ? io.r - s.io.r + (io.w - s.io.w) : 0;
    if (!s.io || moved > 0) s.ioChangedAt = now; // a primeira leitura conta como mudança
    if (moved > 0) s.ioBusySince ??= now;
    else s.ioBusySince = undefined;
    s.io = io;
    // Para sair da espera, o I/O tem de continuar mexendo (o modelo de volta, o spinner): um surto solto durante o
    // pedido de aprovação (telemetria, tela redesenhada) não tira dela.
    let running = s.ioBusySince !== undefined && now - s.ioBusySince >= IO_BUSY_MS;
    if (tools.some((t) => KIRO_SHELL_TOOLS.has(t.name))) {
      for (const started of this.liveness.descendants?.(s.pid)?.values() ?? []) if (started >= s.pendingSince - 1_500) running = true;
    }
    if (s.approvalWait) {
      if (running) {
        s.approvalWait = false;
        this.setStatus(s, 'working');
      }
      return;
    }
    const grace = Math.max(...tools.map((t) => approvalGraceMs(t.name)));
    if (running || now - s.pendingSince < grace || now - s.ioChangedAt < APPROVAL_QUIET_MS) return;
    s.approvalWait = true;
    this.setStatus(s, 'waiting', tr('aprovar uma permissão'));
  }
}
