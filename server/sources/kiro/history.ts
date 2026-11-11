// Histórico do terminal do Kiro (o HistoryProvider 'kiro', ver sources/source.ts): as conversas recentes
// de cada conta do Kiro (abertas ou já encerradas), listadas a partir de ~/.kiro/sessions/cli/*.json e *.jsonl (2.x)
// e de ~/.kiro/sessions/<hash>/<sessionId>/session.json + messages.jsonl (3.x), modificados nos últimos 7 dias.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { KiroTerminalParser } from './terminal';
import { cleanKiroPrompt, cleanKiroTitle } from './parser';
import { kiroV3TranscriptPath, listKiroV3Sessions } from './v3paths';
import { tr } from '../../../shared/i18n';

const READ_CONCURRENCY = 8;
const SESSION_ID = /^[0-9a-zA-Z_-]{1,128}$/;

export function isKiroSessionId(v: string): boolean {
  return SESSION_ID.test(v);
}

export interface KiroHistoryAccount {
  id: string;
  dir: string;
}

export interface KiroHistoryOptions {
  accounts: () => readonly KiroHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  dir?: string;
  sessionsDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export interface KiroSessionSummary {
  cwd?: string;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  sessionId: string;
  /** 2.x: <id>.json; 3.x: session.json. */
  jsonPath: string;
  /** 2.x: <id>.jsonl; 3.x: messages.jsonl. */
  jsonlPath?: string;
  dir: string;
  mtimeMs: number;
  size: number;
}

export class KiroHistory implements HistoryProvider {
  readonly provider = 'kiro' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: KiroSessionSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: KiroHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    if (account === '.kiro') return true;
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const accs = this.opts.accounts();
    const list = accs.length ? accs : [{ id: '.kiro', dir: this.opts.dir ?? join(process.env.HOME || '', '.kiro') }];
    const all: Candidate[] = [];
    for (const acc of list) {
      all.push(...(await this.candidates(acc, now)), ...(await this.candidatesV3(acc, now)));
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const summaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    const keep = new Set(picked.map((c) => c.jsonPath));
    for (const p of this.cache.keys()) if (!keep.has(p)) this.cache.delete(p);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const s = summaries[i];
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      const cwd = s.cwd;
      const r: RecentSession = {
        account: c.account,
        provider: 'kiro',
        sessionId: c.sessionId,
        projectDir: cwd ? encodeCwd(cwd) : 'sessions',
        lastAt: s.lastAt ?? c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (cwd) r.project = cwd;
      if (s.title) r.title = s.title;
      if (s.firstAt !== undefined) r.firstAt = s.firstAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isKiroSessionId(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    if (!this.hasAccount(account)) return { status: 404, error: tr('conta desconhecida') };
    const acc = this.opts.accounts().find((a) => a.id === account) ?? { id: account, dir: this.opts.dir ?? join(process.env.HOME || '', '.kiro') };
    return this.resolveV2(acc, sessionId) ?? this.resolveV3(acc, sessionId) ?? { status: 404, error: tr('sessão não encontrada') };
  }

  /** 3.x: o messages.jsonl de <kiroDir>/sessions/<hash>/<sessionId>/, sem sair de <kiroDir>/sessions. */
  private resolveV3(acc: { dir: string }, sessionId: string): HistoryResolveResult | undefined {
    const path = kiroV3TranscriptPath(acc.dir, sessionId);
    if (!path) return undefined;
    try {
      const root = realpathSync(join(acc.dir, 'sessions'));
      const real = realpathSync(path);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return undefined;
      return { path: real, createParser: () => new KiroTerminalParser() };
    } catch {
      return undefined;
    }
  }

  private resolveV2(acc: { dir: string }, sessionId: string): HistoryResolveResult | undefined {
    const dir = this.sessionsDirOf(acc);
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      return undefined;
    }

    const jsonl = join(dir, `${sessionId}.jsonl`);
    if (existsSync(jsonl)) {
      try {
        const real = realpathSync(jsonl);
        if (!real.startsWith(root + sep)) return undefined;
        if (statSync(real).isFile()) {
          return { path: real, createParser: () => new KiroTerminalParser() };
        }
      } catch {
        // sumiu
      }
    }

    const json = join(dir, `${sessionId}.json`);
    if (existsSync(json)) {
      try {
        const real = realpathSync(json);
        if (!real.startsWith(root + sep)) return undefined;
        if (statSync(real).isFile()) {
          return { path: real, createParser: () => new KiroTerminalParser() };
        }
      } catch {
        // sumiu
      }
    }

    return undefined;
  }

  private sessionsDirOf(acc?: { dir: string }): string {
    if (this.opts.sessionsDir && existsSync(this.opts.sessionsDir)) return this.opts.sessionsDir;
    if (acc?.dir) {
      const cliDir = join(acc.dir, 'sessions', 'cli');
      if (existsSync(cliDir)) return cliDir;
      if (existsSync(acc.dir)) return acc.dir;
    }
    if (this.opts.dir) {
      const cliDir = join(this.opts.dir, 'sessions', 'cli');
      if (existsSync(cliDir)) return cliDir;
      if (existsSync(this.opts.dir)) return this.opts.dir;
    }
    return join(process.env.HOME || '', '.kiro', 'sessions', 'cli');
  }

  private async candidates(acc: KiroHistoryAccount, now: number): Promise<Candidate[]> {
    const dir = this.sessionsDirOf(acc);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }

    const out: Candidate[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.lock.json')) continue;
      const sessionId = name.slice(0, -5);
      if (!isKiroSessionId(sessionId)) continue;

      const jsonPath = join(dir, name);
      const jsonlPath = join(dir, `${sessionId}.jsonl`);
      const targetPath = existsSync(jsonlPath) ? jsonlPath : jsonPath;

      try {
        const st = await stat(targetPath);
        if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
        out.push({
          account: acc.id,
          sessionId,
          jsonPath,
          jsonlPath: existsSync(jsonlPath) ? jsonlPath : undefined,
          dir,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // sumiu
      }
    }
    return out;
  }

  /** Sessões do 3.x da conta (a data é a do messages.jsonl). */
  private async candidatesV3(acc: KiroHistoryAccount, now: number): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const ref of await listKiroV3Sessions(acc.dir)) {
      if (!isKiroSessionId(ref.sessionId)) continue;
      const jsonlPath = join(ref.dir, 'messages.jsonl');
      try {
        const st = await stat(jsonlPath);
        if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
        out.push({ account: acc.id, sessionId: ref.sessionId, jsonPath: join(ref.dir, 'session.json'), jsonlPath, dir: ref.dir, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // sumiu
      }
    }
    return out;
  }

  private async summaryOf(c: Candidate): Promise<KiroSessionSummary> {
    const cached = this.cache.get(c.jsonPath);
    if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
      return cached.summary;
    }

    let cwd: string | undefined;
    let title: string | undefined;
    let firstAt: number | undefined;
    let lastAt: number = c.mtimeMs;

    try {
      const raw = await readFile(c.jsonPath, 'utf8');
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (typeof meta.cwd === 'string') cwd = meta.cwd;
      // 3.x: pasta de trabalho = workspacePaths[0]; criação = createdAt.
      else if (Array.isArray(meta.workspacePaths) && typeof meta.workspacePaths[0] === 'string') cwd = meta.workspacePaths[0];
      if (typeof meta.title === 'string') title = cleanKiroTitle(meta.title);
      if (typeof meta.createdAt === 'string') {
        const ms = Date.parse(meta.createdAt);
        if (!Number.isNaN(ms)) firstAt = ms;
      } else if (typeof meta.started_at === 'string') {
        const ms = Date.parse(meta.started_at);
        if (!Number.isNaN(ms)) firstAt = ms;
      } else if (typeof meta.created_at === 'string') {
        const ms = Date.parse(meta.created_at);
        if (!Number.isNaN(ms)) firstAt = ms;
      }
    } catch {
      // ignora
    }

    if (c.jsonlPath) {
      let fh;
      try {
        fh = await open(c.jsonlPath, 'r');
        const st = await fh.stat();
        lastAt = st.mtimeMs;
        if (st.size > 0 && !title) {
          // O primeiro prompt de uma sessão aberta pelo Kiro Crew passa de 70 KB (prompt do agente junto).
          const headLen = Math.min(st.size, 512 * 1024);
          const buf = Buffer.alloc(headLen);
          await fh.read(buf, 0, headLen, 0);
          const lines = buf.toString('utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as {
                kind?: string;
                data?: { content?: Array<{ kind: string; data: unknown }> };
                payload?: { type?: string; content?: unknown };
              };
              // 3.x: o primeiro {payload: {type: 'user', content}}.
              if (p.payload?.type === 'user') {
                const text = typeof p.payload.content === 'string' ? cleanKiroPrompt(p.payload.content) : '';
                if (text) title = text.slice(0, 90);
                break;
              }
              if (p.kind === 'Prompt') {
                const contents = p.data?.content || [];
                const textPart = contents.find((x) => x.kind === 'text');
                const text = typeof textPart?.data === 'string' ? cleanKiroPrompt(textPart.data) : '';
                if (text) title = text.slice(0, 90);
                break;
              }
            } catch {
              // ignora
            }
          }
        }
      } catch {
        // ignora
      } finally {
        await fh?.close();
      }
    }

    const summary: KiroSessionSummary = {
      cwd,
      title,
      firstAt,
      lastAt,
    };

    this.cache.set(c.jsonPath, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
