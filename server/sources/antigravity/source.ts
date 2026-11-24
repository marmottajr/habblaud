// Fonte de agentes do Google Antigravity CLI (`agy`, AgentSource 'antigravity', ver sources/source.ts). Observa as
// sessões ABERTAS de cada conta do Antigravity CLI (~/.gemini/antigravity-cli) e alimenta o Office; os eventos dos
// hooks (AntigravityLive, via POST /api/antigravity/events) chegam por applyHookEvent e adiantam o que ainda não foi
// gravado nos arquivos.
//
// Presença:
// - enquanto uma conversa está aberta no `agy`, o banco SQLite em modo WAL mantém `conversations/<id>.db-wal` (e
//   `.db-shm`), que desaparecem assim que a conversa fecha;
// - em `jetbox_summaries_proto.pb`, conversas com `status` `running`/`busy` ou `notFullyIdle` também contam como
//   abertas; o mesmo resumo traz o projeto (`cwd`), o título, `waiting_steps`, `killed` e o pai de subagentes
//   (`parentConversationId`);
// - sem a pasta `conversations/` (ex.: montagem parcial ou fixture simples): transcripts modificados nos últimos
//   30 min (`FALLBACK_RECENT_MS`);
// - um evento de hook segura o agente presente por `HOOK_PRESENCE_MS` (60 s).
import { createReadStream, realpathSync, watch, type FSWatcher } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { tr } from '../../../shared/i18n';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import { pathFromUri } from '../codex/rollout';
import type { AgentSource } from '../source';
import { FileTail, LineBuffer, warnOversizedLine } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectAntigravityAccounts } from './accounts';
import {
  CONVERSATIONS_DIR,
  findTranscriptPath,
  isConversationId,
  readOpenWals,
  readTranscriptHead,
  recentlyModifiedTranscripts,
  SUMMARIES_PROTO,
  SummariesCache,
  type ConversationSummary,
  type WalInfo,
} from './files';
import type { AntigravityLive } from './live';
import { createAntigravityTerminalParser } from './terminal';
import {
  createAntigravityState,
  describeAntigravityPrompt,
  describeAntigravityTool,
  parseAntigravityLine,
  type AntigravityLineResult,
  type AntigravityState,
} from './transcript';

/** WAL presente com conversa parada há mais que isto e sem sinal de vida: WAL órfão de um crash antigo. */
export const STALE_WAL_MS = 12 * 3600_000;
/** Sem `conversations/`: presença = transcript modificado nos últimos 30 min. */
export const FALLBACK_RECENT_MS = 30 * 60_000;
/** Um evento de hook segura o agente presente por este tempo. */
export const HOOK_PRESENCE_MS = 60_000;
/** Tempo que a conversa precisa ficar ausente para ser dada como encerrada. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** 'working' sem nenhuma escrita no transcript nem evento de hook por este tempo: o turno morreu (crash). */
export const WORKING_QUIET_MS = 30 * 60_000;
/** Atividades recuperadas do começo de um transcript grande para a linha do tempo longa. */
const PREFIX_HISTORY = 120;
const BACKLOG_MAX = 400;
const MAIN_ROLE = tr('Agente principal (Antigravity)');
const SUB_ROLE = tr('Subagente (Antigravity)');

const HOOK_EVENTS = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  tailBytes?: number;
  watch?: boolean;
}

interface AntigravityAccount {
  id: string;
  dir: string;
  configDir: string;
  summaries: SummariesCache;
  wals: Map<string, WalInfo> | null;
  recent: Map<string, number>;
  recentAt: number;
  error?: string;
}

interface ConversationTracker {
  key: string;
  acc: AntigravityAccount;
  conversationId: string;
  kind: 'main' | 'sub';
  parentConversationId?: string;
  summary?: ConversationSummary;
  transcriptPath?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: AntigravityState;
  backlog: AntigravityLineResult[];
  inOffice: boolean;
  hookCwd?: string;
  hookRole?: string;
  hookModel?: string;
  hookTitle?: string;
  headCwd?: string;
  status: AgentStatus;
  statusAt: number;
  waitingFor?: string;
  lastHookAt?: number;
  lastWriteAt?: number;
  missingSince?: number;
  subDone: boolean;
  hookSpawned?: boolean;
  watcher?: FSWatcher;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function roleOf(raw: string | undefined): string {
  if (!raw) return SUB_ROLE;
  const r = raw.trim();
  return r ? `${r[0].toUpperCase()}${r.slice(1)}` : SUB_ROLE;
}

export class AntigravitySource implements AgentSource, AntigravityLive {
  readonly provider = 'antigravity' as const;
  private accs: AntigravityAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private convs = new Map<string, ConversationTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    const existing = opts.accounts.allEntries();
    this.detected = detectAntigravityAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: existing.map((e) => e.detected.short), colors: existing.map((e) => e.detected.color) },
    });
    this.register();
  }

  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'antigravity',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => {
      const old = prev.get(e.dir);
      if (old) {
        old.id = e.id;
        old.configDir = e.detected.configDir;
        return old;
      }
      return {
        id: e.id,
        dir: e.dir,
        configDir: e.detected.configDir,
        summaries: new SummariesCache(e.dir),
        wals: null,
        recent: new Map(),
        recentAt: -Infinity,
      };
    });
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.convs.values()) this.unwatch(t);
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.convs.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'antigravity', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.convs.get(agentId);
    return t?.inOffice ? t.transcriptPath : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.convs.has(agentId) ? createAntigravityTerminalParser() : undefined;
  }

  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`agy-poll:${errMsg(err)}`, tr('Antigravity: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const seen = new Set<string>();
    for (const acc of this.accs) {
      const summaries = acc.summaries.read();
      const present = this.presentConversations(acc, summaries, now);
      for (const [conversationId, via] of present) {
        const key = `${acc.id}:${conversationId}`;
        let t = this.convs.get(key);
        if (!t) {
          t = this.newTracker(acc, conversationId);
          this.convs.set(key, t);
        }
        const sum = summaries.get(conversationId);
        if (sum) this.applySummaryMeta(t, sum, !boot);
        try {
          this.syncConversation(t, via, now, boot);
        } catch (err) {
          log.warnOnce(`agy-conv:${key}:${errMsg(err)}`, tr('Antigravity: conversa {0}: {1}', [key, errMsg(err)]));
        }
        seen.add(key);
      }
    }
    for (const [key, t] of [...this.convs]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.unwatch(t);
      this.convs.delete(key);
    }
    for (const t of this.convs.values()) if (t.kind === 'sub' && !t.inOffice && seen.has(t.key)) this.reconcile(t, now);
  }

  private presentConversations(
    acc: AntigravityAccount,
    summaries: Map<string, ConversationSummary>,
    now: number,
  ): Map<string, 'wal' | 'summary' | 'recent' | 'hook'> {
    const out = new Map<string, 'wal' | 'summary' | 'recent' | 'hook'>();
    this.watchDir(acc.dir);
    acc.wals = readOpenWals(acc.dir);
    if (acc.wals) {
      this.watchDir(`${acc.dir}${sep}${CONVERSATIONS_DIR}`);
      for (const wal of acc.wals.values()) out.set(wal.conversationId, 'wal');
    } else {
      if (now - acc.recentAt >= 5_000) {
        acc.recentAt = now;
        acc.recent = new Map(recentlyModifiedTranscripts(acc.dir, FALLBACK_RECENT_MS, now).map((r) => [r.conversationId, r.mtimeMs]));
      }
      for (const [id, mtime] of acc.recent) {
        const t = this.convs.get(`${acc.id}:${id}`);
        const last = Math.max(mtime, t?.lastWriteAt ?? 0);
        if (now - last <= FALLBACK_RECENT_MS) out.set(id, 'recent');
      }
    }
    for (const [id, sum] of summaries) {
      if (out.has(id)) continue;
      const active = sum.status === 'running' || sum.status === 'busy' || sum.waiting === true || sum.notFullyIdle === true;
      if (active && !sum.killed && (sum.lastModifiedAt === undefined || now - sum.lastModifiedAt <= STALE_WAL_MS)) {
        out.set(id, 'summary');
      }
    }
    for (const t of this.convs.values()) {
      if (t.acc !== acc || out.has(t.conversationId)) continue;
      if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) out.set(t.conversationId, 'hook');
    }
    return out;
  }

  private newTracker(acc: AntigravityAccount, conversationId: string): ConversationTracker {
    return {
      key: `${acc.id}:${conversationId}`,
      acc,
      conversationId,
      kind: 'main',
      nextResolveAt: 0,
      state: createAntigravityState(),
      backlog: [],
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      subDone: false,
    };
  }

  private applySummaryMeta(t: ConversationTracker, sum: ConversationSummary, live: boolean): void {
    t.summary = sum;
    if (sum.parentConversationId) {
      if (t.kind === 'main' && t.inOffice) {
        this.opts.office.closeMain(t.key);
        t.inOffice = false;
      }
      t.kind = 'sub';
      t.parentConversationId = sum.parentConversationId;
    }
    const at = sum.lastModifiedAt ?? this.now();
    if (sum.killed && t.kind === 'sub') {
      this.decide(t, 'idle', at, undefined, live);
      return;
    }
    if (sum.waiting) {
      this.decide(t, 'waiting', at, tr('responder no Antigravity'), live);
    } else if (sum.status === 'running' || sum.status === 'busy') {
      this.decide(t, 'working', at, undefined, live);
    } else if (sum.status === 'idle') {
      const next: AgentStatus = sum.notFullyIdle || t.state.shells.size > 0 ? 'shell' : 'idle';
      this.decide(t, next, at, undefined, live);
    }
  }

  private syncConversation(t: ConversationTracker, via: 'wal' | 'summary' | 'recent' | 'hook', now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    this.pump(t, boot);
    this.reconcile(t, now, via);
    if (t.inOffice) {
      this.syncShells(t);
      if (t.kind === 'main') {
        this.quietCheck(t, now);
        this.opts.office.fillWorkingActivity(t.key);
      }
    }
  }

  private reconcile(t: ConversationTracker, now: number, via?: 'wal' | 'summary' | 'recent' | 'hook'): void {
    const want = this.wanted(t, now, via);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
  }

  private wanted(t: ConversationTracker, now: number, via?: 'wal' | 'summary' | 'recent' | 'hook'): boolean {
    if (t.summary?.killed) return false;
    const hookRecent = t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS;
    if (!hookRecent && via === 'wal') {
      const wal = t.acc.wals?.get(t.conversationId);
      const lastAct = Math.max(t.lastWriteAt ?? 0, t.summary?.lastModifiedAt ?? 0, wal?.mtimeMs ?? 0);
      if (wal && now - lastAct > STALE_WAL_MS && t.summary?.status !== 'running' && t.summary?.status !== 'busy') return false;
    }
    if (t.kind === 'main' && !this.cwdOf(t)) return false;
    if (t.kind === 'sub') {
      const parent = this.parentKey(t);
      if (!parent || !this.opts.office.has(parent) || this.opts.office.isSubDone(parent) || this.opts.office.get(parent)?.status === 'offline') return false;
      if (!t.inOffice && t.status !== 'working' && t.status !== 'waiting' && !t.hookSpawned) return false;
    }
    return true;
  }

  private parentKey(t: ConversationTracker): string | undefined {
    return t.parentConversationId ? `${t.acc.id}:${t.parentConversationId}` : undefined;
  }

  private cwdOf(t: ConversationTracker): string | undefined {
    return t.summary?.cwd ?? t.hookCwd ?? t.headCwd;
  }

  private titleOf(t: ConversationTracker): string | undefined {
    return t.summary?.title ?? t.state.title ?? t.hookTitle;
  }

  private enter(t: ConversationTracker, now: number): void {
    const office = this.opts.office;
    const startedAt = t.summary?.createdAt ?? t.state.firstAt ?? now;
    if (t.kind === 'main') {
      const cwd = this.cwdOf(t)!;
      office.addMain({
        id: t.key,
        provider: 'antigravity',
        account: t.acc.id,
        sessionId: t.conversationId,
        cwd,
        role: MAIN_ROLE,
        startedAt,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const parent = this.parentKey(t)!;
      const added = office.addSub({
        id: t.key,
        parentId: parent,
        sessionId: t.conversationId,
        role: roleOf(t.summary?.agentRole ?? t.hookRole),
        title: this.titleOf(t),
        background: true,
        startedAt,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
      delete t.hookSpawned;
      if (t.status === 'waiting') office.setStatus(t.key, 'waiting', t.waitingFor);
    }
    this.flushBacklog(t);
    this.applySummary(t);
    this.syncShells(t);
  }

  private leave(t: ConversationTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }

  private statusToOffice(t: ConversationTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    if (t.status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  private syncShells(t: ConversationTracker): void {
    if (!t.inOffice) return;
    this.opts.office.setShells(t.key, [...t.state.shells.values()]);
  }

  // ---------------------------------------------------------------- transcript

  private pump(t: ConversationTracker, boot: boolean): void {
    const now = this.now();
    if (now >= t.nextResolveAt) {
      t.nextResolveAt = now + (boot ? 0 : 2_000);
      const path = findTranscriptPath(t.acc.dir, t.conversationId);
      if (path && !samePath(path, t.tail?.path)) {
        this.load(t, path);
        return;
      }
    }
    if (!t.tail) return;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`agy-read:${t.key}`, tr('Antigravity: transcript de {0} ilegível ({1}).', [t.key, errMsg(err)]));
        return;
      }
      if (r.missing) {
        this.unwatch(t);
        delete t.tail;
        delete t.transcriptPath;
        t.nextResolveAt = 0;
        return;
      }
      t.lastWriteAt = t.tail.mtimeMs;
      if (r.reset) {
        this.load(t, t.tail.path);
        return;
      }
      for (const line of r.lines) this.apply(t, parseAntigravityLine(t.state, line, { idPrefix: t.key, now: this.now() }), true);
      if (r.lines.length) this.applySummary(t);
      if (!r.more) break;
    }
  }

  private load(t: ConversationTracker, path: string): void {
    this.unwatch(t);
    const head = readTranscriptHead(path);
    if (head.cwd) t.headCwd = head.cwd;
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.transcriptPath = path;
    t.state = createAntigravityState();
    if (head.title) t.state.title = head.title;
    if (head.firstAt !== undefined) t.state.firstAt = head.firstAt;
    t.backlog = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) this.apply(t, parseAntigravityLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
      this.syncShells(t);
    }
    this.applySummary(t);
    this.watchFile(t, path);
    if (start > 0) this.queuePrefix(t, path, start);
  }

  private settleStatus(t: ConversationTracker): void {
    const s = t.state;
    const at = Math.max(s.lastAt ?? 0, t.summary?.lastModifiedAt ?? 0);
    if (at < t.statusAt) return;
    let status: AgentStatus;
    let waitingFor: string | undefined;
    if (t.summary?.waiting || s.waitingQuestions) {
      status = 'waiting';
      waitingFor = s.waitingQuestions ? tr('responder uma pergunta') : tr('responder no Antigravity');
    } else if (t.summary?.status === 'running' || t.summary?.status === 'busy' || s.turnOpen) {
      status = 'working';
    } else if (t.summary?.notFullyIdle || s.shells.size > 0) {
      status = 'shell';
    } else {
      status = 'idle';
    }
    if (status === 'working' && this.now() - Math.max(t.lastWriteAt ?? 0, at) > WORKING_QUIET_MS) status = 'idle';
    t.status = status;
    t.statusAt = at;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
  }

  private apply(t: ConversationTracker, r: AntigravityLineResult, live: boolean): void {
    for (const sig of r.signals) {
      switch (sig.type) {
        case 'turnStart':
          this.decide(t, 'working', r.at, undefined, live);
          break;
        case 'turnEnd':
          this.decide(t, t.state.shells.size > 0 || t.summary?.notFullyIdle ? 'shell' : 'idle', r.at, undefined, live);
          break;
        case 'ask':
          this.decide(t, 'waiting', r.at, tr('responder uma pergunta'), live);
          break;
        case 'progress':
          if (t.status === 'waiting') this.decide(t, 'working', r.at, undefined, live);
          break;
      }
    }
    if (!live || !t.inOffice) {
      if (r.activities.length || r.signals.some((s) => s.type === 'github')) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: ConversationTracker, r: AntigravityLineResult, live: boolean): void {
    const office = this.opts.office;
    for (const a of r.activities) office.addActivity(t.key, a.activity, a.current, { feed: live });
    for (const sig of r.signals) {
      if (sig.type === 'github') office.githubEvent(t.key, sig.event, { key: sig.key, at: r.at, live });
    }
  }

  private flushBacklog(t: ConversationTracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
  }

  private decide(t: ConversationTracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (live) this.statusToOffice(t);
  }

  private quietCheck(t: ConversationTracker, now: number): void {
    if (t.status !== 'working') return;
    const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.statusAt);
    if (now - last > WORKING_QUIET_MS) this.decide(t, 'idle', now, undefined, true);
  }

  private applySummary(t: ConversationTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    const title = this.titleOf(t);
    if (title) summary.title = title;
    const model = s.model ?? t.hookModel;
    if (model) summary.model = model;
    if (s.gitBranch) summary.gitBranch = s.gitBranch;
    const firstAt = t.summary?.createdAt ?? s.firstAt;
    if (firstAt !== undefined) summary.firstAt = firstAt;
    const lastAt = Math.max(s.lastAt ?? 0, t.summary?.lastModifiedAt ?? 0);
    if (lastAt > 0) summary.lastAt = lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  private queuePrefix(t: ConversationTracker, path: string, end: number): void {
    const state = t.state;
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY);
        if (this.convs.get(t.key) !== t || t.state !== state) return;
        for (const [step, tok] of prefix.state.stepTokens) {
          if (!state.stepTokens.has(step)) {
            state.stepTokens.set(step, tok);
            state.stats.tokensIn += tok.in;
            state.stats.tokensOut += tok.out;
          }
        }
        for (const step of prefix.state.countedSteps) {
          if (!state.countedSteps.has(step)) {
            state.countedSteps.add(step);
          }
        }
        state.stats.toolCalls += prefix.state.stats.toolCalls;
        state.stats.subagents += prefix.state.stats.subagents;
        state.title ??= prefix.state.title;
        state.model ??= prefix.state.model;
        if (!state.tasks.length && prefix.state.tasks.length) state.tasks = prefix.state.tasks;
        if (prefix.state.firstAt !== undefined && (state.firstAt === undefined || prefix.state.firstAt < state.firstAt)) {
          state.firstAt = prefix.state.firstAt;
        }
        this.applySummary(t);
        if (t.inOffice) this.opts.office.mergeHistory(t.key, prefix.activities);
      })
      .catch((err) => log.warnOnce(`agy-prefix:${path}`, tr('Antigravity: não foi possível ler o início de um transcript ({0}).', [errMsg(err)])));
  }

  // ---------------------------------------------------------------- hooks (AntigravityLive)

  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(account, input);
    } catch (err) {
      log.warnOnce(`agy-hook:${errMsg(err)}`, tr('Antigravity: evento de hook ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private hookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    const event = str(input.hookEventName ?? input.hook_event_name);
    if (!event || !HOOK_EVENTS.has(event)) return false;
    const convId = str(input.conversationId ?? input.conversation_id)?.toLowerCase();
    if (!isConversationId(convId)) return false;
    const parentRaw = str(input.parentConversationId ?? input.parent_conversation_id)?.toLowerCase();
    const parentId = parentRaw && isConversationId(parentRaw) && parentRaw !== convId ? parentRaw : undefined;
    const acc = this.accountFor(account, input, convId);
    if (!acc) return false;
    const now = this.now();
    const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
    const firstWs = typeof workspaces[0] === 'string' ? pathFromUri(workspaces[0]) : undefined;
    const cwd = str(input.cwd) ?? firstWs;
    const agentName = str(input.agentName ?? input.agent_name);
    const modelName = str(input.modelName ?? input.model_name);
    const lastUserInput = str(input.lastUserInput ?? input.last_user_input);

    if (parentId) {
      const rootT = this.touch(acc, parentId, now, cwd);
      this.reconcile(rootT, now, 'hook');
    }
    const t = this.touch(acc, convId, now, cwd, parentId, agentName, modelName, lastUserInput);
    this.hintTranscript(acc, convId, str(input.transcriptPath ?? input.transcript_path));
    this.reconcile(t, now, 'hook');

    switch (event) {
      case 'SessionStart':
        break;
      case 'PreInvocation': {
        if (parentId) t.hookSpawned = true;
        this.decide(t, 'working', now, undefined, true);
        if (lastUserInput && t.inOffice) {
          const act: Activity = { id: `${t.key}#hook-u:${now.toString(36)}`, at: now, ...describeAntigravityPrompt(lastUserInput) };
          this.opts.office.addActivity(t.key, act, true);
        }
        break;
      }
      case 'PostInvocation':
      case 'PostToolUse':
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'PreToolUse': {
        if (parentId) t.hookSpawned = true;
        this.decide(t, 'working', now, undefined, true);
        this.reconcile(t, now, 'hook');
        const tc = rec(input.toolCall ?? input.tool_call);
        const toolName = str(tc?.name ?? input.tool_name) ?? 'ferramenta';
        const toolArgs = rec(tc?.args ?? input.tool_input) ?? {};
        const { desc, tool } = describeAntigravityTool(toolName, toolArgs);
        const callId = str(tc?.id ?? input.tool_use_id) ?? `hook${now.toString(36)}`;
        const act: Activity = { id: `${t.key}#${callId}`, at: now, ...desc, tool };
        if (t.inOffice) this.opts.office.addActivity(t.key, act, true);
        if (tool === 'AskUserQuestion') this.decide(t, 'waiting', now, tr('responder uma pergunta'), true);
        break;
      }
      case 'Stop':
        this.decide(t, t.state.shells.size > 0 || t.summary?.notFullyIdle ? 'shell' : 'idle', now, undefined, true);
        break;
    }
    this.applySummary(t);
    this.reconcile(t, now, 'hook');
    return true;
  }

  private touch(
    acc: AntigravityAccount,
    conversationId: string,
    now: number,
    cwd?: string,
    parent?: string,
    agentRole?: string,
    modelName?: string,
    lastUserInput?: string,
  ): ConversationTracker {
    const key = `${acc.id}:${conversationId}`;
    let t = this.convs.get(key);
    if (!t) {
      t = this.newTracker(acc, conversationId);
      this.convs.set(key, t);
    }
    t.lastHookAt = now;
    delete t.missingSince;
    if (cwd) t.hookCwd ??= cwd;
    if (parent && t.kind === 'main') {
      t.kind = 'sub';
      t.parentConversationId = parent;
    }
    if (agentRole) t.hookRole ??= agentRole;
    if (modelName && modelName !== 'auto') t.hookModel = modelName;
    if (lastUserInput && !t.hookTitle) t.hookTitle = lastUserInput.slice(0, 90);
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    this.pump(t, false);
    return t;
  }

  private hintTranscript(acc: AntigravityAccount, conversationId: string, path: string | undefined): void {
    if (!path) return;
    const t = this.convs.get(`${acc.id}:${conversationId}`);
    try {
      const real = realpathSync(path);
      const root = realpathSync(acc.dir);
      if (!real.startsWith(root + sep)) return;
      if (samePath(real, t?.tail?.path)) return;
      if (t) this.load(t, real);
    } catch {
      // não existe aqui (Docker) ou ainda não foi criado
    }
  }

  private accountFor(account: string | undefined, input: Record<string, unknown>, conversationId: string): AntigravityAccount | undefined {
    const norm = (p: string) => {
      try {
        return resolve(p);
      } catch {
        return p;
      }
    };
    if (account) {
      const byId = this.accs.find((a) => a.id === account);
      if (byId) return byId;
      const abs = norm(account);
      const byDir = this.accs.find((a) => norm(a.dir) === abs || norm(a.configDir) === abs);
      if (byDir) return byDir;
    }
    for (const raw of [str(input.transcriptPath ?? input.transcript_path), str(input.artifactDirectoryPath)]) {
      if (!raw) continue;
      const p = norm(raw);
      const byPath = this.accs.find((a) => p.startsWith(norm(a.dir) + sep) || p.startsWith(norm(a.configDir) + sep));
      if (byPath) return byPath;
    }
    const known = this.accs.filter((a) => this.convs.has(`${a.id}:${conversationId}`));
    if (known.length === 1) return known[0];
    if (account) {
      const byName = this.accs.find((a) => basename(a.dir) === basename(account) || basename(a.configDir) === basename(account));
      if (byName) return byName;
    }
    return this.accs.length === 1 ? this.accs[0] : undefined;
  }

  // ---------------------------------------------------------------- fs.watch

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, (_ev, filename) => {
        if (!filename || filename === SUMMARIES_PROTO || filename.endsWith('.db-wal') || filename.endsWith('.db-shm')) this.schedule();
      });
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private watchFile(t: ConversationTracker, path: string): void {
    if (!this.useWatch) return;
    this.unwatch(t);
    try {
      const w = watch(path, { persistent: false }, () => this.schedule());
      w.on('error', () => w.close());
      t.watcher = w;
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private unwatch(t: ConversationTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}

function samePath(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number): Promise<{ state: AntigravityState; activities: Activity[] }> {
  const state = createAntigravityState();
  let activities: Activity[] = [];
  if (end <= 0) return { state, activities };
  const ctx = { idPrefix, now: Date.now(), activities: keep > 0 };
  const take = (line: string) => {
    const r = parseAntigravityLine(state, line, ctx);
    for (const a of r.activities) activities.push(a.activity);
    if (activities.length > keep * 2) activities = activities.slice(-keep);
  };
  const pending = new LineBuffer();
  let discarded = 0;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const fed = pending.push(chunk);
    discarded += fed.discarded;
    for (const buf of fed.lines) {
      const line = buf.toString('utf8');
      if (line) take(line);
    }
  }
  const rest = pending.flush();
  if (rest?.length) take(rest.toString('utf8'));
  if (discarded) warnOversizedLine(path);
  return { state, activities: activities.slice(-keep) };
}
