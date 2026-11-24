// Histórico do terminal do Pi (HistoryProvider 'pi', ver sources/source.ts): lista as sessões recentes
// (<piDir>/sessions/*/*.jsonl) modificadas nos últimos 7 dias e resolve arquivos com segurança.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { isPiSessionId, parsePiSessionName, piSessionDirs } from './files';
import { createPiState, parsePiHeaderLine, parsePiLine, toMs, type PiMeta } from './session';
import { createPiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

const HEAD_BYTES = 64 * 1024;
const PROMPT_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const READ_CONCURRENCY = 8;

export interface PiHistoryAccount {
  id: string;
  /** Pasta do agente Pi lida por este processo. */
  dir: string;
}

export interface PiHistoryOptions {
  accounts: () => readonly PiHistoryAccount[];
  /** Agente principal da sessão, se ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export interface PiSessionSummary {
  meta?: PiMeta;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  sessionId: string;
  path: string;
  projectDir: string;
  mtimeMs: number;
  size: number;
}

export class PiHistory implements HistoryProvider {
  readonly provider = 'pi' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: PiSessionSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: PiHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) all.push(...(await this.candidates(acc, now)));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const summaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const s = summaries[i];
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      if (!agentId && s.firstAt === undefined && s.lastAt === undefined) return;
      const cwd = s.meta?.cwd;
      const r: RecentSession = {
        account: c.account,
        provider: 'pi',
        sessionId: c.sessionId,
        projectDir: cwd ? encodeCwd(cwd) : c.projectDir,
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
    if (!isPiSessionId(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
    let best: { path: string; mtimeMs: number } | undefined;
    for (const dir of piSessionDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const parsed = parsePiSessionName(name);
        if (!parsed || parsed.sessionId !== sessionId) continue;
        try {
          const real = realpathSync(join(dir, name));
          if (!real.startsWith(root + sep)) continue;
          const st = statSync(real);
          if (!st.isFile()) continue;
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: real, mtimeMs: st.mtimeMs };
        } catch {
          // arquivo sumiu entre a listagem e a leitura
        }
      }
    }
    if (best) return { path: best.path, createParser: createPiTerminalParser };
    return { status: 404, error: tr('sessão não encontrada') };
  }

  private async candidates(acc: PiHistoryAccount, now: number): Promise<Candidate[]> {
    const byId = new Map<string, Candidate>();
    for (const dir of piSessionDirs(acc.dir)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      const projectDir = basename(dir);
      for (const name of names) {
        const parsed = parsePiSessionName(name);
        if (!parsed) continue;
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
          const prev = byId.get(parsed.sessionId);
          if (!prev || st.mtimeMs > prev.mtimeMs) {
            byId.set(parsed.sessionId, {
              account: acc.id,
              sessionId: parsed.sessionId,
              path,
              projectDir,
              mtimeMs: st.mtimeMs,
              size: st.size,
            });
          }
        } catch {
          // apagado durante a listagem
        }
      }
    }
    return [...byId.values()];
  }

  private async summaryOf(c: Candidate): Promise<PiSessionSummary> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary;
    let summary: PiSessionSummary;
    try {
      summary = await readPiSessionSummary(c.path, c.size);
    } catch (err) {
      log.warnOnce(`pi-history:${errMsg(err)}`, tr('Histórico do Pi: sessão ilegível ({0}).', [errMsg(err)]));
      summary = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

/** Lê cabeçalho, primeiro prompt/título e último timestamp do arquivo JSONL do Pi. */
export async function readPiSessionSummary(path: string, size: number): Promise<PiSessionSummary> {
  const fh = await open(path, 'r');
  try {
    const read = async (start: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    };
    const head = await read(0, HEAD_BYTES);
    const nl = head.indexOf(0x0a);
    const firstLine = head.toString('utf8', 0, nl === -1 ? head.length : nl);
    const meta = parsePiHeaderLine(firstLine);
    const summary: PiSessionSummary = {};
    if (meta) summary.meta = meta;

    const state = createPiState(meta);
    const ctx = { idPrefix: '', now: 0, activities: false };
    if (nl !== -1) {
      const after = await read(nl + 1, PROMPT_BYTES);
      const lines = after.toString('utf8').split('\n');
      if (nl + 1 + after.length < size) lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        parsePiLine(state, line, ctx);
        if (state.explicitTitle) break;
      }
    }

    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = (await read(tailStart, TAIL_BYTES)).toString('utf8').split('\n');
    if (tailStart > 0) tail.shift();
    for (const line of tail) {
      if (!line.trim()) continue;
      if (line.includes('"session_info"')) parsePiLine(state, line, ctx);
      const m = /"timestamp":"([^"]+)"/.exec(line.slice(0, 260))?.[1];
      const ms = m ? toMs(m) : undefined;
      if (ms !== undefined && (summary.lastAt === undefined || ms > summary.lastAt)) summary.lastAt = ms;
    }

    const first = meta?.startedAt ?? state.firstAt;
    if (first !== undefined) summary.firstAt = first;
    if (summary.lastAt === undefined && state.lastAt !== undefined) summary.lastAt = state.lastAt;
    if (state.title) summary.title = state.title;
    return summary;
  } finally {
    await fh.close();
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
