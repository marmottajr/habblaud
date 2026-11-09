// Fonte de agentes do Kiro (AgentSource 'kiro', ver sources/source.ts): um KiroWatcher por pasta (accounts.ts),
// cada pasta é uma conta no AccountsService (no WSL, a do Linux e a do Windows). Também recebe os eventos do hook
// (KiroLive, POST /api/kiro/events): da sessão que um watcher acompanha vão para ele; das outras (Kiro CLI 3.x, ou
// arquivos fora do alcance) nasce um personagem só do hook (hooks.ts).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Provider, SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectKiroAccount, discoverKiroDir, kiroDirOf, type KiroDir } from './accounts';
import { KiroHookSessions } from './hooks';
import type { KiroHookEvent, KiroLive } from './live';
import { isWsl } from './liveness';
import { KiroTerminalParser } from './terminal';
import { KiroWatcher } from './watcher';

export interface KiroSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas a observar (discoverKiroDirs). Sem elas, `dir` ou a descoberta antiga (uma pasta). */
  dirs?: readonly KiroDir[];
  dir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  inDocker?: boolean;
  checkPid?: boolean;
  pollMs?: number;
  now?: () => number;
  /** O servidor roda no WSL (padrão: detecta): caminhos C:\ do hook do Windows viram /mnt/c. */
  wsl?: boolean;
}

interface Watched {
  dir: KiroDir;
  account: string;
  watcher: KiroWatcher;
}

/** Mesmo evento repetido (o 3.x lê os hooks do agente e o arquivo de hooks): ignorado por este tempo. */
const DEDUPE_MS = 1_500;
const SWEEP_MS = 15_000;
/** Sessão do 2.x (uuid): pode estar em sessions/cli e ainda não ter sido lida. */
const CLI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A pasta do Kiro que o hook mandou é a desta conta? Caminho do Windows (C:\Users\x\.kiro) visto do WSL vira
 * /mnt/c/Users/x/.kiro; no Windows a comparação ignora maiúsculas.
 */
export function sameKiroHome(accountDir: string, hookHome: string, opts: { wsl: boolean; platform?: NodeJS.Platform }): boolean {
  const platform = opts.platform ?? process.platform;
  let h = hookHome.trim();
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(h);
  if (win && platform !== 'win32') {
    if (!opts.wsl) return false;
    h = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  }
  const norm = (p: string) => {
    const r = (platform === 'win32' ? p : resolve(p)).replace(/[\\/]+$/, '');
    return platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
  };
  return norm(accountDir) === norm(h);
}

export class KiroSource implements AgentSource, KiroLive {
  readonly provider: Provider = 'kiro';
  private readonly accounts: AccountsService;
  private readonly office: Office;
  private readonly dirs: readonly KiroDir[];
  private readonly env?: NodeJS.ProcessEnv;
  private readonly opts: KiroSourceOptions;
  private readonly now: () => number;
  private readonly wsl: boolean;
  private watched: Watched[] = [];
  private readonly hookSessions: KiroHookSessions;
  private recentEvents = new Map<string, number>();
  private lastForcedScan = -Infinity;
  private sweepTimer?: NodeJS.Timeout;

  constructor(opts: KiroSourceOptions) {
    this.opts = opts;
    this.accounts = opts.accounts;
    this.office = opts.office;
    this.env = opts.env;
    this.now = opts.now ?? Date.now;
    this.wsl = opts.wsl ?? (!opts.inDocker && isWsl(opts.env ?? process.env));
    this.hookSessions = new KiroHookSessions({ office: opts.office, now: this.now, samePidSpace: !opts.inDocker });
    if (opts.dirs?.length) this.dirs = opts.dirs;
    else {
      const base = opts.dir ?? discoverKiroDir(opts.env, opts.home) ?? join(opts.home || process.env.HOME || '', '.kiro');
      this.dirs = [kiroDirOf(base) ?? { dir: base, sessionsDir: join(base, 'sessions', 'cli') }];
    }
  }

  start(): void {
    const present = this.dirs.filter((d) => existsSync(d.dir));
    const entries = present.length
      ? this.accounts.setProviderAccounts(
          'kiro',
          present.map((d) => ({ dir: d.dir, detected: detectKiroAccount(d.dir, this.env, { windows: d.windows }) })),
        )
      : [];
    this.watched = this.dirs.map((dir) => {
      const account = entries.find((e) => e.dir === dir.dir)?.id ?? (dir.windows ? '.kiro-windows' : '.kiro');
      const watcher = new KiroWatcher({
        office: this.office,
        sessionsDir: dir.sessionsDir,
        account,
        inDocker: this.opts.inDocker,
        checkPid: this.opts.checkPid,
        pollMs: this.opts.pollMs,
        env: this.env,
        now: this.opts.now,
      });
      return { dir, account, watcher };
    });
    for (const w of this.watched) w.watcher.start();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    for (const w of this.watched) w.watcher.stop();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.hookSessions.clear();
  }

  /** Sessões só do hook que fecharam saem; as que um watcher passou a acompanhar mudam de dono. */
  sweep(): void {
    for (const id of this.hookSessions.ids()) if (this.ownerOf(id)) this.hookSessions.handOver(id);
    this.hookSessions.sweep();
  }

  accountEntries(): readonly AccountEntry[] {
    return this.accounts.entriesOf('kiro');
  }

  /** Pasta, conta e como as sessões abertas são reconhecidas (para o log do início). */
  describe(): Array<{ account: string; sessionsDir: string; liveness: string }> {
    return this.watched.map((w) => ({ account: w.account, sessionsDir: w.dir.sessionsDir, liveness: w.watcher.livenessLabel() }));
  }

  sources(): SourceInfo[] {
    const list = this.watched.length ? this.watched : this.dirs.map((dir) => ({ dir, account: dir.windows ? '.kiro-windows' : '.kiro', watcher: undefined }));
    return list.map((w, i) => ({
      label: w.account,
      provider: 'kiro',
      path: w.dir.dir,
      sessions: (w.watcher?.sessionCount() ?? 0) + (i === 0 ? this.hookSessions.size() : 0),
      ok: existsSync(w.dir.dir),
    }));
  }

  /** Conta do evento: a pasta do Kiro que o hook mandou; sem ela (ou sem casar), a primeira. */
  private accountFor(kiroHome: string | undefined): string {
    const hit = kiroHome ? this.watched.find((w) => sameKiroHome(w.dir.dir, kiroHome, { wsl: this.wsl })) : undefined;
    return (hit ?? this.watched[0])?.account ?? '.kiro';
  }

  private ownerOf(sessionId: string): KiroWatcher | undefined {
    return this.watched.find((w) => w.watcher.has(sessionId))?.watcher;
  }

  applyHookEvent(e: KiroHookEvent): boolean {
    const ev = e.event;
    const now = this.now();
    const key = [ev.session_id, ev.hook_event_name, ev.tool_name ?? '', (ev.prompt ?? JSON.stringify(ev.tool_input ?? '')).slice(0, 300)].join('|');
    for (const [k, at] of this.recentEvents) if (now - at > DEDUPE_MS) this.recentEvents.delete(k);
    if (this.recentEvents.has(key)) return true;
    this.recentEvents.set(key, now);

    let owner = this.ownerOf(ev.session_id);
    if (!owner && CLI_SESSION_ID.test(ev.session_id) && now - this.lastForcedScan > 500) {
      // A trava pode ter acabado de aparecer: lê as pastas antes de criar um personagem só do hook.
      this.lastForcedScan = now;
      for (const w of this.watched) w.watcher.scan();
      owner = this.ownerOf(ev.session_id);
    }
    if (owner) {
      if (this.hookSessions.has(ev.session_id)) this.hookSessions.handOver(ev.session_id);
      return owner.applyHook(ev.session_id, ev);
    }
    return this.hookSessions.apply(this.accountFor(e.kiroHome), e);
  }

  transcriptPathOf(agentId: string): string | undefined {
    const owner = this.watched.find((w) => w.watcher.has(agentId));
    return (owner ?? this.watched[0])?.watcher.transcriptPathOf(agentId);
  }

  terminalParser(_agentId: string): TerminalParser | undefined {
    return new KiroTerminalParser();
  }
}
