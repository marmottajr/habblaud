// Histórico do terminal do Antigravity CLI (HistoryProvider 'antigravity', ver sources/source.ts): as conversas
// recentes de cada conta do Antigravity (abertas ou já encerradas), listadas a partir dos transcripts em
// `brain/<id>/.system_generated/logs/transcript.jsonl` modificados nos últimos 7 dias, cruzados com os resumos de
// `jetbox_summaries_proto.pb`, `annotations/` e `history.jsonl`. Subagentes (`parentConversationId`) ficam de fora.
import { realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { sep } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { findTranscriptPath, isConversationId, recentlyModifiedTranscripts, SummariesCache, type ConversationSummary } from './files';
import { createAntigravityTerminalParser } from './terminal';
import { cleanPromptText } from './transcript';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_MAX = 90;
const READ_CONCURRENCY = 8;

export interface AntigravityHistoryAccount {
  id: string;
  dir: string;
}

export interface AntigravityHistoryOptions {
  accounts: () => readonly AntigravityHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export interface TranscriptFileSummary {
  title?: string;
  cwd?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  conversationId: string;
  path: string;
  dir: string;
  mtimeMs: number;
  size: number;
  meta?: ConversationSummary;
}

export class AntigravityHistory implements HistoryProvider {
  readonly provider = 'antigravity' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: TranscriptFileSummary }>();
  private summariesByDir = new Map<string, SummariesCache>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: AntigravityHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  private summariesFor(dir: string): Map<string, ConversationSummary> {
    let c = this.summariesByDir.get(dir);
    if (!c) {
      c = new SummariesCache(dir);
      this.summariesByDir.set(dir, c);
    }
    return c.read();
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) {
      const summaries = this.summariesFor(acc.dir);
      for (const item of recentlyModifiedTranscripts(acc.dir, this.maxAgeMs, now)) {
        const meta = summaries.get(item.conversationId);
        if (meta?.parentConversationId) continue;
        all.push({ account: acc.id, conversationId: item.conversationId, path: item.path, dir: acc.dir, mtimeMs: item.mtimeMs, size: item.size, meta });
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const fileSummaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    const keep = new Set(picked.map((c) => c.path));
    for (const p of this.cache.keys()) if (!keep.has(p)) this.cache.delete(p);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const fs = fileSummaries[i];
      const agentId = this.opts.openAgentOf(c.account, c.conversationId);
      const firstAt = c.meta?.createdAt ?? fs.firstAt;
      const lastAt = fs.lastAt ?? c.meta?.lastModifiedAt ?? c.mtimeMs;
      if (!agentId && firstAt === undefined && fs.lastAt === undefined && !c.meta?.title && !fs.title) return;
      const cwd = c.meta?.cwd ?? fs.cwd;
      const title = c.meta?.title ?? fs.title;
      const r: RecentSession = {
        account: c.account,
        provider: 'antigravity',
        sessionId: c.conversationId,
        projectDir: cwd ? encodeCwd(cwd) : 'brain',
        lastAt,
        size: c.size,
        open: !!agentId,
      };
      if (cwd) r.project = cwd;
      if (title) r.title = title;
      if (firstAt !== undefined) r.firstAt = firstAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isConversationId(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
    const found = findTranscriptPath(acc.dir, sessionId.toLowerCase());
    if (!found) return { status: 404, error: tr('sessão não encontrada') };
    try {
      const real = realpathSync(found);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return { status: 404, error: tr('sessão não encontrada') };
      return { path: real, createParser: createAntigravityTerminalParser };
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
  }

  private async summaryOf(c: Candidate): Promise<TranscriptFileSummary> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary;
    let summary: TranscriptFileSummary;
    try {
      summary = await readTranscriptSummary(c.path, c.size);
    } catch (err) {
      log.warnOnce(`agy-history:${errMsg(err)}`, tr('Histórico do Antigravity: transcript ilegível ({0}).', [errMsg(err)]));
      summary = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

export async function readTranscriptSummary(path: string, size: number): Promise<TranscriptFileSummary> {
  const fh = await open(path, 'r');
  try {
    const read = async (start: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    };
    const headBuf = await read(0, HEAD_BYTES);
    const headLines = headBuf.toString('utf8').split('\n');
    if (headBuf.length < size) headLines.pop();
    const summary: TranscriptFileSummary = {};
    for (const line of headLines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (typeof j.created_at === 'string') {
          const ms = Date.parse(j.created_at);
          if (!Number.isNaN(ms) && (summary.firstAt === undefined || ms < summary.firstAt)) summary.firstAt = ms;
        }
        if (summary.title === undefined && j.source === 'USER_EXPLICIT' && j.type === 'USER_INPUT' && typeof j.content === 'string') {
          const clean = cleanPromptText(j.content);
          if (clean) summary.title = truncate(maskSecrets(clean.slice(0, 1_000)), TITLE_MAX);
        }
      } catch {
        // linha cortada
      }
    }
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tailLines = (await read(tailStart, TAIL_BYTES)).toString('utf8').split('\n');
    if (tailStart > 0) tailLines.shift();
    for (const line of tailLines) {
      const at = /"created_at":"([^"]+)"/.exec(line.slice(0, 300))?.[1];
      const ms = at ? Date.parse(at) : NaN;
      if (!Number.isNaN(ms) && (summary.lastAt === undefined || ms > summary.lastAt)) summary.lastAt = ms;
    }
    if (summary.lastAt === undefined && summary.firstAt !== undefined) summary.lastAt = summary.firstAt;
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
