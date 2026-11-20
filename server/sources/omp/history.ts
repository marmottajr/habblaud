// Histórico do terminal do omp (o HistoryProvider 'omp', ver sources/source.ts): as conversas recentes de cada agent
// dir do omp (abertas ou já encerradas), listadas a partir de sessions/<pasta>/<início>_<uuidv7>.jsonl modificados nos
// últimos 7 dias. De cada arquivo lê só o começo (slot do título e cabeçalho: projeto e início), com cache enquanto o
// mtime e o tamanho não mudam. Subagentes (pasta irmã de cada sessão) ficam de fora, como os do Claude Code.
// As entregas (deliveries/) saem daqui também: elas leem os transcripts do histórico.
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { OmpIndex, readOmpHead } from './files';
import type { OmpHead } from './parser';
import { createOmpTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OmpHistoryAccount {
  id: string;
  /** Agent dir do omp lida por este processo (a que tem sessions/). */
  dir: string;
}

export interface OmpHistoryOptions {
  accounts: () => readonly OmpHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export class OmpHistory implements HistoryProvider {
  readonly provider = 'omp' as const;
  private heads = new Map<string, { mtimeMs: number; size: number; head: OmpHead }>();
  private readonly indexes = new Map<string, OmpIndex>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: OmpHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Array<{ account: string; sessionId: string; path: string; mtimeMs: number; size: number }> = [];
    for (const acc of this.opts.accounts()) {
      for (const f of this.index(acc).scan()) if (now - f.mtimeMs <= this.maxAgeMs) all.push({ account: acc.id, ...f });
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.heads.keys()) if (!keep.has(path)) this.heads.delete(path);

    const out: RecentSession[] = [];
    for (const c of picked) {
      const head = this.headOf(c.path, c.mtimeMs, c.size);
      // Sem cabeçalho ainda (arquivo recém-criado) ou de subagente: não é uma conversa sua para abrir.
      if (!head.header || head.header.parentSession) continue;
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      const cwd = head.header.cwd;
      const r: RecentSession = { account: c.account, provider: 'omp', sessionId: c.sessionId, projectDir: encodeCwd(cwd), project: cwd, lastAt: c.mtimeMs, size: c.size, open: !!agentId };
      if (head.title) r.title = head.title;
      if (head.header.startedAt !== undefined) r.firstAt = head.header.startedAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    }
    return out;
  }

  /** Sessão `sessionId` da conta, validada: conta conhecida, id uuid e o arquivo (links resolvidos) dentro da agent dir. */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    const index = this.index(acc);
    let f = index.find(sessionId);
    if (!f) {
      index.scan(); // sessão criada depois da última listagem
      f = index.find(sessionId);
    }
    if (!f) return { status: 404, error: tr('sessão não encontrada') };
    try {
      const real = realpathSync(f.path);
      if (!real.startsWith(realpathSync(acc.dir) + sep)) return { status: 404, error: tr('sessão não encontrada') };
      return { path: real, createParser: createOmpTerminalParser };
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
  }

  private index(acc: OmpHistoryAccount): OmpIndex {
    let index = this.indexes.get(acc.dir);
    if (!index) this.indexes.set(acc.dir, (index = new OmpIndex(acc.dir)));
    return index;
  }

  /** Começo do arquivo (título e cabeçalho), relido só quando mtime ou tamanho mudam (o slot do título é reescrito no lugar). */
  private headOf(path: string, mtimeMs: number, size: number): OmpHead {
    const hit = this.heads.get(path);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.head;
    const head = readOmpHead(path);
    this.heads.set(path, { mtimeMs, size, head });
    return head;
  }
}
