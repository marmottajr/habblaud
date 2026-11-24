// Fonte de agentes do Pi coding agent (AgentSource 'pi', ver sources/source.ts):
// combina observação dos arquivos de sessão (`<piDir>/sessions/*/*.jsonl`) com eventos ao vivo vindos da
// extensão do Pi (`mod/habblaud-pi/habblaud.ts` via POST /api/pi/events -> PiLive.applyLiveEvent).
//
// Presença:
// - com extensão instalada: `session_start` e `heartbeat` mantêm a sessão aberta por LIVE_PRESENCE_MS (90 s),
//   e `session_shutdown` encerra imediatamente (com registro de encerramento para não reabrir pelo mtime);
// - sem extensão (somente arquivos): qualquer `.jsonl` modificado nos últimos FALLBACK_RECENT_MS (30 min)
//   entra no escritório e é acompanhado ao vivo com FileTail.
import { createReadStream, existsSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { describePrompt, describeShellJob, SPECIAL } from '../../../shared/activity';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail, LineBuffer, warnOversizedLine } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectPiAccounts } from './accounts';
import { isPiSessionId, PI_SESSIONS_DIR, PiSessionIndex, readPiHeader } from './files';
import type { PiLive } from './live';
import { createPiState, describePiTool, parsePiLine, piTitleFromPrompt, type PiState } from './session';
import { createPiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Modo somente arquivo: sessão ativa = JSONL modificado nos últimos 30 min. */
export const PI_FALLBACK_RECENT_MS = 30 * 60_000;
/** Um evento ao vivo/heartbeat da extensão segura o agente presente por este tempo. */
export const PI_LIVE_PRESENCE_MS = 90_000;
/** 'working' sem escrita nem evento ao vivo por este tempo cai para 'idle'. */
export const PI_WORKING_QUIET_MS = 30 * 60_000;
/** Folga curta antes de marcar como offline após sair da janela. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** Atividades recuperadas do começo de sessões longas em segundo plano. */
const PREFIX_HISTORY = 120;
const MAIN_ROLE = tr('Agente principal (Pi)');

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export interface PiSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Pi lidas por este processo (ex.: ~/.pi/agent). */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  tailBytes?: number;
  /** Desliga fs.watch (testes). */
  watch?: boolean;
}

interface PiAccount {
  id: string;
  dir: string;
  configDir: string;
  index: PiSessionIndex;
  watcher?: FSWatcher;
  ok: boolean;
  error?: string;
}

interface TrackedSession {
  id: string;
  account: PiAccount;
  sessionId: string;
  path?: string;
  tail?: FileTail;
  state: PiState;
  cwd?: string;
  added: boolean;
  /** Último instante em que o status foi definido (evento mais novo vence). */
  statusAt: number;
  /** Status em vigor no Office. */
  status: AgentStatus;
  waitingFor?: string;
  /** Última vez que um evento ao vivo/heartbeat da extensão confirmou presença. */
  liveSeenAt: number;
  /** Última escrita vista no arquivo ou evento ao vivo. */
  lastActivityAt: number;
  /** Se a extensão mandou `session_shutdown` (não reabre só pelo mtime antigo). */
  shutdownAt?: number;
  /** Quando deixou de ser visto ativo. */
  missingSince?: number;
  /** Leitura do começo do arquivo em segundo plano já iniciada. */
  prefixStarted?: boolean;
}

export class PiSource implements AgentSource, PiLive {
  readonly provider = 'pi' as const;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private readonly accountsList: PiAccount[] = [];
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly shutdownHistory = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly opts: PiSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 1_000;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch !== false;

    const existing = opts.accounts.allEntries();
    const detected = detectPiAccounts(opts.dirs, {
      env: opts.env,
      home: opts.home,
      taken: { shorts: existing.map((e) => e.detected.short), colors: existing.map((e) => e.detected.color) },
    });
    const entries = opts.accounts.setProviderAccounts(
      'pi',
      opts.dirs.map((dir, i) => ({ dir, detected: detected[i] })),
    );
    for (const e of entries) {
      this.accountsList.push({
        id: e.id,
        dir: e.dir,
        configDir: e.detected.configDir,
        index: new PiSessionIndex(e.dir),
        ok: existsSync(e.dir),
      });
    }
  }

  accountEntries(): readonly AccountEntry[] {
    return this.opts.accounts.entriesOf('pi');
  }

  start(): void {
    this.stopped = false;
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    if (this.useWatch) this.setupWatchers();
    this.timer = setInterval(() => {
      try {
        this.poll(false);
      } catch (err) {
        log.warnOnce(`pi-poll:${errMsg(err)}`, tr('Pi: falha ao atualizar sessões ({0}).', [errMsg(err)]));
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const acc of this.accountsList) {
      try {
        acc.watcher?.close();
      } catch {
        // ignora
      }
      acc.watcher = undefined;
    }
  }

  sources(): SourceInfo[] {
    return this.accountsList.map((acc) => {
      let count = 0;
      for (const s of this.sessions.values()) if (s.account.id === acc.id && s.added) count++;
      return {
        label: acc.id,
        provider: 'pi',
        path: acc.configDir,
        sessions: count,
        ok: acc.ok,
        ...(acc.error ? { error: acc.error } : {}),
      };
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const s = this.sessions.get(agentId);
    if (!s) return undefined;
    if (s.path) return s.path;
    const found = s.account.index.find(s.sessionId, this.now());
    if (found) s.path = found;
    return found;
  }

  terminalParser(): TerminalParser {
    return createPiTerminalParser();
  }

  // ---------------------------------------------------------------- eventos ao vivo da extensão

  applyLiveEvent(accountId: string | undefined, input: Record<string, unknown>): boolean {
    if (this.stopped) return false;
    const type = str(input.type);
    const sessionId = str(input.sessionId);
    if (!type || !sessionId || !isPiSessionId(sessionId)) return false;

    const sessionFile = str(input.sessionFile);
    const acc = this.resolveAccount(accountId, str(input.piDir), sessionFile);
    if (!acc) return false;

    const now = this.now();
    const id = `${acc.id}:${sessionId}`;

    if (type === 'session_shutdown') {
      this.shutdownHistory.set(id, now);
      const existing = this.sessions.get(id);
      if (existing) {
        existing.shutdownAt = now;
        this.closeSession(existing);
      }
      return true;
    }

    // Novo evento de vida cancela shutdown anterior (ex.: sessão retomada com /resume).
    this.shutdownHistory.delete(id);

    const cwd = str(input.cwd);
    const s = this.getOrCreate(acc, sessionId, sessionFile, cwd, now);
    s.liveSeenAt = now;
    s.missingSince = undefined;
    s.shutdownAt = undefined;
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      s.state.meta.cwd = cwd;
    }
    if (sessionFile && !s.path) {
      s.path = sessionFile;
      acc.index.remember(sessionId, sessionFile);
    }

    const model = str(input.model);
    if (model && model !== s.state.model) {
      s.state.model = model;
    }
    const sessionName = str(input.sessionName);
    if (sessionName && sessionName !== s.state.explicitTitle) {
      s.state.explicitTitle = sessionName;
      s.state.title = sessionName;
    }

    switch (type) {
      case 'session_start':
      case 'heartbeat': {
        const idle = input.idle === true;
        if (!s.added) {
          this.ensureAdded(s, idle ? 'idle' : 'working', now, false);
        } else {
          this.pushSummary(s);
        }
        // Drena o arquivo se já existir (ex.: sessão retomada).
        if (s.path) this.drainFile(s, false);
        return true;
      }

      case 'before_agent_start': {
        s.lastActivityAt = now;
        const prompt = str(input.prompt);
        if (prompt && !s.state.explicitTitle && !s.state.title) {
          s.state.title = piTitleFromPrompt(prompt);
        }
        this.ensureAdded(s, 'working', now, false);
        this.applyStatus(s, 'working', now);
        if (prompt) {
          const act: Activity = { id: `${s.id}:live-u:${now}`, ...describePrompt(prompt), at: now };
          this.opts.office.addActivity(s.id, act, true);
        }
        this.pushSummary(s);
        return true;
      }

      case 'agent_start': {
        s.lastActivityAt = now;
        this.ensureAdded(s, 'working', now, false);
        this.applyStatus(s, 'working', now);
        this.pushSummary(s);
        return true;
      }

      case 'tool_execution_start': {
        s.lastActivityAt = now;
        this.ensureAdded(s, 'working', now, false);
        this.applyStatus(s, 'working', now);
        const toolName = str(input.toolName) ?? 'tool';
        const callId = str(input.toolCallId) ?? `${now}`;
        const args = rec(input.args) ?? {};
        const act: Activity = {
          id: `${s.id}:tool:${callId}`,
          ...describePiTool(toolName, args),
          tool: toolName,
          at: now,
        };
        this.opts.office.addActivity(s.id, act, true);
        const lower = toolName.toLowerCase();
        if (lower === 'bash' || lower === 'powershell' || lower === 'shell') {
          const info = describeShellJob('Bash', { command: args.command ?? args.cmd ?? '', description: args.description });
          s.state.shells.set(callId, {
            id: callId,
            label: info.label,
            ...(info.command ? { command: info.command } : {}),
            startedAt: now,
            background: false,
            kind: 'shell',
          });
          this.opts.office.setShells(s.id, [...s.state.shells.values()]);
        }
        return true;
      }

      case 'tool_execution_end': {
        s.lastActivityAt = now;
        const callId = str(input.toolCallId);
        if (callId && s.state.shells.delete(callId) && s.added) {
          this.opts.office.setShells(s.id, [...s.state.shells.values()]);
        }
        if (input.isError === true && s.added) {
          const toolName = str(input.toolName);
          const act: Activity = {
            id: `${s.id}:terr:${callId ?? now}`,
            ...SPECIAL.error(toolName, str(input.error)),
            tool: toolName,
            error: true,
            at: now,
          };
          this.opts.office.addActivity(s.id, act, true);
        }
        if (s.path) this.drainFile(s, false);
        return true;
      }

      case 'ui_prompt_start': {
        s.lastActivityAt = now;
        const reason = str(input.title) ?? tr('responder no terminal');
        this.ensureAdded(s, 'waiting', now, false, reason);
        this.applyStatus(s, 'waiting', now, reason);
        return true;
      }

      case 'ui_prompt_end': {
        s.lastActivityAt = now;
        const next: AgentStatus = input.idle === true ? 'idle' : 'working';
        if (s.added) this.applyStatus(s, next, now);
        return true;
      }

      case 'model_select':
      case 'session_info_changed': {
        if (s.added) this.pushSummary(s);
        return true;
      }

      case 'session_compact': {
        s.lastActivityAt = now;
        if (s.added) {
          this.opts.office.addActivity(s.id, { id: `${s.id}:live-compact:${now}`, ...SPECIAL.compact(), tool: 'Compact', at: now }, true);
        }
        return true;
      }

      case 'agent_end':
      case 'agent_settled': {
        s.lastActivityAt = now;
        if (s.state.shells.size) {
          s.state.shells.clear();
          if (s.added) this.opts.office.setShells(s.id, []);
        }
        if (s.path) this.drainFile(s, false);
        if (s.added) {
          if (input.aborted === true) {
            this.opts.office.addActivity(s.id, { id: `${s.id}:live-abort:${now}`, ...SPECIAL.interrupted(), at: now }, true);
          }
          this.applyStatus(s, 'idle', now);
          this.pushSummary(s);
        }
        return true;
      }

      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- varredura / acompanhamento

  private setupWatchers(): void {
    for (const acc of this.accountsList) {
      const sessionsDir = join(acc.dir, PI_SESSIONS_DIR);
      if (!existsSync(sessionsDir)) continue;
      try {
        acc.watcher = watch(sessionsDir, { recursive: true }, () => {
          if (this.stopped) return;
          try {
            this.poll(false);
          } catch {
            // próximo poll recupera
          }
        });
        acc.watcher.on('error', () => {
          // polling continua funcionando mesmo sem fs.watch
        });
      } catch {
        // recursive watch indisponível neste FS: fica só no polling
      }
    }
  }

  private poll(boot: boolean): void {
    const now = this.now();
    const activeIds = new Set<string>();

    for (const acc of this.accountsList) {
      acc.ok = existsSync(acc.dir);
      const recent = acc.index.listRecent(now, PI_FALLBACK_RECENT_MS);
      for (const file of recent) {
        const id = `${acc.id}:${file.sessionId}`;
        const shutAt = this.shutdownHistory.get(id);
        // Se a sessão encerrou explicitamente via extensão e o arquivo não mudou depois disso, não reabre.
        if (shutAt !== undefined && file.mtimeMs <= shutAt + 2_000) continue;
        if (shutAt !== undefined && file.mtimeMs > shutAt + 2_000) this.shutdownHistory.delete(id);

        activeIds.add(id);
        const s = this.getOrCreate(acc, file.sessionId, file.path, undefined, now);
        s.path = file.path;
        s.missingSince = undefined;
        this.drainFile(s, boot);
      }
    }

    // Mantém também sessões vivas via extensão (mesmo antes de gravar a 1ª linha ou ociosas há > 30 min).
    for (const s of this.sessions.values()) {
      if (s.liveSeenAt > 0 && now - s.liveSeenAt <= PI_LIVE_PRESENCE_MS) {
        activeIds.add(s.id);
        s.missingSince = undefined;
        if (s.path) this.drainFile(s, boot);
      } else if (!activeIds.has(s.id)) {
        if (s.missingSince === undefined) s.missingSince = now;
        if (now - s.missingSince >= CLOSE_AFTER_MISSING_MS) this.closeSession(s);
      }

      // Sessão presa em 'working' sem nenhuma escrita nem evento há 30 min → idle.
      if (s.added && s.status === 'working' && now - Math.max(s.lastActivityAt, s.liveSeenAt) > PI_WORKING_QUIET_MS) {
        if (s.state.shells.size) {
          s.state.shells.clear();
          this.opts.office.setShells(s.id, []);
        }
        this.applyStatus(s, 'idle', now);
      }
    }
  }

  private resolveAccount(accountId: string | undefined, piDir: string | undefined, sessionFile: string | undefined): PiAccount | undefined {
    if (accountId) {
      const byId = this.accountsList.find((a) => a.id === accountId);
      if (byId) return byId;
    }
    if (piDir) {
      const abs = resolve(piDir);
      const byDir = this.accountsList.find((a) => resolve(a.dir) === abs || resolve(a.configDir) === abs);
      if (byDir) return byDir;
    }
    if (sessionFile) {
      try {
        const realFile = realpathSync(sessionFile);
        const byPath = this.accountsList.find((a) => {
          try {
            return realFile.startsWith(realpathSync(a.dir) + sep);
          } catch {
            return false;
          }
        });
        if (byPath) return byPath;
      } catch {
        const absFile = resolve(sessionFile);
        const byPath = this.accountsList.find((a) => absFile.startsWith(resolve(a.dir) + sep) || absFile.startsWith(resolve(a.configDir) + sep));
        if (byPath) return byPath;
      }
    }
    return this.accountsList.length === 1 ? this.accountsList[0] : undefined;
  }

  private getOrCreate(acc: PiAccount, sessionId: string, path: string | undefined, cwd: string | undefined, now: number): TrackedSession {
    const id = `${acc.id}:${sessionId}`;
    const existing = this.sessions.get(id);
    if (existing) {
      if (path && !existing.path) existing.path = path;
      if (cwd && !existing.cwd) {
        existing.cwd = cwd;
        existing.state.meta.cwd = cwd;
      }
      return existing;
    }
    const meta = path ? readPiHeader(path) : undefined;
    const state = createPiState(meta);
    if (cwd && !state.meta.cwd) state.meta.cwd = cwd;
    const s: TrackedSession = {
      id,
      account: acc,
      sessionId,
      path,
      state,
      cwd: cwd ?? meta?.cwd,
      added: false,
      statusAt: 0,
      status: 'idle',
      liveSeenAt: 0,
      lastActivityAt: now,
    };
    this.sessions.set(id, s);
    return s;
  }

  private drainFile(s: TrackedSession, boot: boolean): void {
    if (!s.path) return;
    let isInitial = false;
    if (!s.tail) {
      try {
        statSync(s.path);
      } catch {
        return;
      }
      if (!s.cwd) {
        const meta = readPiHeader(s.path);
        if (meta?.cwd) {
          s.cwd = meta.cwd;
          s.state.meta.cwd = meta.cwd;
        }
        if (meta?.startedAt && s.state.firstAt === undefined) s.state.firstAt = meta.startedAt;
      }
      s.tail = new FileTail(s.path);
      const startOffset = s.tail.seekTail(this.tailBytes);
      isInitial = true;
      if (startOffset > 0 && !s.prefixStarted) {
        s.prefixStarted = true;
        this.readPrefixAsync(s, startOffset);
      }
    }

    const r = s.tail.read();
    if (!r.lines.length && !r.reset) return;
    const now = this.now();
    isInitial = isInitial || r.reset;

    let latestStatus: AgentStatus | undefined;
    let latestStatusAt = 0;
    let summaryChanged = false;
    let shellsChanged = false;
    const activities: Activity[] = [];

    for (const line of r.lines) {
      const parsed = parsePiLine(s.state, line, { idPrefix: s.id, now });
      if (parsed.activities.length) activities.push(...parsed.activities);
      if (parsed.status && (parsed.statusAt ?? now) >= latestStatusAt) {
        latestStatus = parsed.status;
        latestStatusAt = parsed.statusAt ?? now;
      }
      if (parsed.summaryChanged) summaryChanged = true;
      if (parsed.shellsChanged) shellsChanged = true;
    }

    if (!s.cwd && s.state.meta.cwd) s.cwd = s.state.meta.cwd;
    if (!s.cwd) return;

    const initialStatus: AgentStatus = latestStatus ?? s.state.lastStatus ?? 'idle';
    this.ensureAdded(s, initialStatus, now, boot);

    for (let i = 0; i < activities.length; i++) {
      const act = activities[i];
      const isLast = i === activities.length - 1;
      // Na leitura inicial de arquivo já existente, entra só no histórico (não inunda o feed).
      this.opts.office.addActivity(s.id, act, isLast, { feed: !isInitial && !boot });
    }

    if (latestStatus) {
      // Só atualiza status se a linha for mais recente do que o último evento ao vivo.
      this.applyStatus(s, latestStatus, latestStatusAt);
    }

    if (shellsChanged) {
      this.opts.office.setShells(s.id, [...s.state.shells.values()]);
    }
    if (summaryChanged || isInitial) {
      this.pushSummary(s);
    }
    if (!isInitial) {
      s.lastActivityAt = now;
    } else if (s.state.lastAt) {
      s.lastActivityAt = Math.max(s.lastActivityAt, s.state.lastAt);
    }
  }

  private ensureAdded(s: TrackedSession, initialStatus: AgentStatus, now: number, boot: boolean, waitingFor?: string): void {
    if (s.added || !s.cwd) return;
    s.added = true;
    s.status = initialStatus;
    s.statusAt = Math.max(s.statusAt, now);
    s.waitingFor = waitingFor;
    this.opts.office.addMain({
      id: s.id,
      provider: 'pi',
      account: s.account.id,
      sessionId: s.sessionId,
      cwd: s.cwd,
      role: MAIN_ROLE,
      startedAt: s.state.firstAt ?? s.state.meta.startedAt ?? now,
      status: initialStatus,
      ...(waitingFor ? { waitingFor } : {}),
    });
    if (!boot) this.pushSummary(s);
  }

  private applyStatus(s: TrackedSession, status: AgentStatus, at: number, waitingFor?: string): void {
    if (!s.added) return;
    if (at < s.statusAt) return;
    s.statusAt = at;
    s.status = status;
    s.waitingFor = waitingFor;
    this.opts.office.setStatus(s.id, status, waitingFor);
  }

  private pushSummary(s: TrackedSession): void {
    if (!s.added) return;
    const summary: TranscriptSummary = {
      tasks: [],
      stats: { ...s.state.stats },
      ...(s.state.title ? { title: s.state.title } : {}),
      ...(s.state.model ? { model: s.state.model } : {}),
      ...(s.state.firstAt !== undefined ? { firstAt: s.state.firstAt } : {}),
      ...(s.state.lastAt !== undefined ? { lastAt: s.state.lastAt } : {}),
    };
    this.opts.office.applyTranscript(s.id, summary);
  }

  private closeSession(s: TrackedSession): void {
    this.sessions.delete(s.id);
    if (s.added) this.opts.office.closeMain(s.id);
  }

  /** Lê o começo de um arquivo de sessão grande em segundo plano para completar título/estatísticas/histórico. */
  private readPrefixAsync(s: TrackedSession, endByte: number): void {
    const path = s.path;
    if (!path || endByte <= 0) return;
    const prefixState = createPiState(s.state.meta);
    const older: Activity[] = [];
    const buf = new LineBuffer();
    const stream = createReadStream(path, { start: 0, end: endByte - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      if (this.stopped) {
        stream.destroy();
        return;
      }
      const { lines, discarded } = buf.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      if (discarded) warnOversizedLine(path);
      for (const lineBuf of lines) {
        const res = parsePiLine(prefixState, lineBuf.toString('utf8'), { idPrefix: s.id, now: this.now() });
        if (res.activities.length) {
          older.push(...res.activities);
          if (older.length > PREFIX_HISTORY) older.splice(0, older.length - PREFIX_HISTORY);
        }
      }
    });
    stream.on('end', () => {
      if (this.stopped || !this.sessions.has(s.id)) return;
      if (!s.state.explicitTitle && !s.state.title && prefixState.title) s.state.title = prefixState.title;
      if (!s.state.model && prefixState.model) s.state.model = prefixState.model;
      s.state.stats.toolCalls += prefixState.stats.toolCalls;
      s.state.stats.tokensIn += prefixState.stats.tokensIn;
      s.state.stats.tokensOut += prefixState.stats.tokensOut;
      if (prefixState.stats.costUSD) s.state.stats.costUSD = (s.state.stats.costUSD ?? 0) + prefixState.stats.costUSD;
      if (prefixState.firstAt !== undefined && (s.state.firstAt === undefined || prefixState.firstAt < s.state.firstAt)) {
        s.state.firstAt = prefixState.firstAt;
      }
      if (older.length) this.opts.office.mergeHistory(s.id, older);
      this.pushSummary(s);
    });
    stream.on('error', () => {
      // arquivo removido durante leitura em segundo plano
    });
  }
}
