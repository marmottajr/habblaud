// Fonte de agentes do Kiro (AgentSource 'kiro', ver sources/source.ts): um KiroWatcher por pasta (accounts.ts),
// cada pasta é uma conta no AccountsService (no WSL, a do Linux e a do Windows).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectKiroAccount, discoverKiroDir, kiroDirOf, type KiroDir } from './accounts';
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
}

interface Watched {
  dir: KiroDir;
  account: string;
  watcher: KiroWatcher;
}

export class KiroSource implements AgentSource {
  readonly provider: Provider = 'kiro';
  private readonly accounts: AccountsService;
  private readonly office: Office;
  private readonly dirs: readonly KiroDir[];
  private readonly env?: NodeJS.ProcessEnv;
  private readonly opts: KiroSourceOptions;
  private watched: Watched[] = [];

  constructor(opts: KiroSourceOptions) {
    this.opts = opts;
    this.accounts = opts.accounts;
    this.office = opts.office;
    this.env = opts.env;
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
      });
      return { dir, account, watcher };
    });
    for (const w of this.watched) w.watcher.start();
  }

  stop(): void {
    for (const w of this.watched) w.watcher.stop();
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
    return list.map((w) => ({
      label: w.account,
      provider: 'kiro',
      path: w.dir.dir,
      sessions: w.watcher?.sessionCount() ?? 0,
      ok: existsSync(w.dir.dir),
    }));
  }

  transcriptPathOf(agentId: string): string | undefined {
    const owner = this.watched.find((w) => w.watcher.has(agentId));
    return (owner ?? this.watched[0])?.watcher.transcriptPathOf(agentId);
  }

  terminalParser(_agentId: string): TerminalParser | undefined {
    return new KiroTerminalParser();
  }
}
