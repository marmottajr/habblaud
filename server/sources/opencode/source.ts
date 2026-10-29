// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts): a CLI/TUI `opencode` e o
// `opencode serve` gravam tudo num SQLite (<dados>/opencode.db, padrão ~/.local/share/opencode). Lido SÓ para
// leitura (node:sqlite, readOnly), por polling: nada é instalado no OpenCode.
//
// Presença (o OpenCode não grava um registro de sessões abertas, e o `opencode serve` fica ligado o tempo todo):
// - uma sessão (session_v2, não arquivada) está no escritório enquanto trabalha ou se mexeu há menos de
//   PRESENCE_MS; depois disso sai (volta na próxima mensagem);
// - subagentes (session_v2.parent_id, a ferramenta `task`) entram sob o principal enquanto trabalham e entregam ao
//   ficar ociosos.
// Status: 'idle' na mensagem de fim de turno; 'working' num prompt ou passo do modelo; 'waiting' com uma `question`
// aberta. Os pedidos de permissão do OpenCode não ficam no banco: aparecem como 'working'. 'working' sem nenhuma
// escrita há WORKING_QUIET_MS (o processo morreu no meio do turno) vira 'idle'.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { opencodeModel, parseOpencodeMessage, type OpencodeMessageRow, type OpencodeSessionRow } from './parse';
import { tr } from '../../../shared/i18n';

/** Sessão parada há mais que isto (e não trabalhando) sai do escritório. */
export const PRESENCE_MS = 30 * 60_000;
/** 'working' sem nenhuma escrita por este tempo: o turno morreu. */
export const WORKING_QUIET_MS = 30 * 60_000;
/** Mensagens lidas do fim da conversa quando a sessão entra (o resto não vira atividade). */
const BOOT_MESSAGES = 80;
/** Mensagens lidas por sessão a cada ciclo. */
const BATCH = 400;
const CLOSE_AFTER_MISSING_MS = 1_500;
const MAIN_ROLE = tr('Agente principal (OpenCode)');
const SUB_ROLE = tr('Subagente (OpenCode)');

/** Pasta de dados do OpenCode: HABBLAUD_OPENCODE_DIR, senão $XDG_DATA_HOME/opencode, senão ~/.local/share/opencode. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): string {
  const explicit = env.HABBLAUD_OPENCODE_DIR?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg || join(home, '.local', 'share'), 'opencode');
}

/** O banco existe nesta pasta? */
export function hasOpencodeDb(dir: string): boolean {
  return existsSync(join(dir, 'opencode.db'));
}

/** O pedaço do node:sqlite usado aqui (injetável nos testes). */
export interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}
export type OpenDb = (path: string) => SqliteDb;

/** Abre o banco só para leitura pelo node:sqlite (Node 22.13+; antes disso, ou sem o módulo, undefined = fonte desligada). */
export function sqliteOpener(): OpenDb | undefined {
  // Sem o aviso "SQLite is an experimental feature" no console do servidor.
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(typeof w === 'string' ? w : w.message).includes('SQLite')) return;
    (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync?: new (p: string, o: { readOnly: boolean }) => SqliteDb } | undefined;
    const Db = mod?.DatabaseSync;
    return Db ? (path) => new Db(path, { readOnly: true }) : undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emit;
  }
}

export interface OpencodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta de dados do OpenCode (com o opencode.db). */
  dir: string;
  open: OpenDb;
  now?: () => number;
  pollMs?: number;
}

interface SessionTracker {
  key: string;
  row: OpencodeSessionRow;
  kind: 'main' | 'sub';
  inOffice: boolean;
  subDone: boolean;
  /** Maior time_updated de mensagem já lido. */
  cursor: number;
  seen: Set<string>;
  status: AgentStatus;
  waitingFor?: string;
  toolCalls: number;
  lastWriteAt: number;
  missingSince?: number;
}

export class OpencodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private entry: AccountEntry | undefined;
  private db: SqliteDb | undefined;
  private error: string | undefined;
  private sessions = new Map<string, SessionTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: OpencodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    const claude = opts.accounts.entries();
    const used = new Set(claude.map((e) => e.detected.color));
    const shorts = new Set(claude.map((e) => e.detected.short.toUpperCase()));
    const detected: DetectedAccount = {
      id: 'opencode',
      provider: 'opencode',
      configDir: opts.dir,
      short: ['O', 'P', 'N'].find((l) => !shorts.has(l)) ?? 'O',
      name: 'OpenCode',
      color: ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[used.size % ACCOUNT_COLORS.length],
    };
    this.entry = opts.accounts.setProviderAccounts('opencode', [{ dir: opts.dir, detected }])[0];
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entry ? [this.entry] : [];
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.db?.close();
    } catch {
      // já fechado
    }
    this.db = undefined;
  }

  sources(): SourceInfo[] {
    if (!this.entry) return [];
    let sessions = 0;
    for (const t of this.sessions.values()) if (t.kind === 'main' && t.inOffice) sessions++;
    const info: SourceInfo = { label: this.entry.id, provider: 'opencode', path: this.opts.dir, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  /** As conversas do OpenCode ficam num banco, não num arquivo: o terminal do escritório não as abre. */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  // ---------------------------------------------------------------- banco

  private query<T>(sql: string, ...params: unknown[]): T[] {
    if (!this.db) this.db = this.opts.open(join(this.opts.dir, 'opencode.db'));
    try {
      return this.db.prepare(sql).all(...params) as T[];
    } catch (err) {
      // Banco trocado ou corrompido no meio do caminho: reabre no próximo ciclo.
      try {
        this.db.close();
      } catch {
        // ignora
      }
      this.db = undefined;
      throw err;
    }
  }

  private safePoll(): void {
    try {
      this.poll(false);
      this.error = undefined;
    } catch (err) {
      const msg = errMsg(err);
      if (this.error !== msg) log.warnOnce(`opencode-poll:${msg}`, tr('OpenCode: falha ao ler o banco: {0}', [msg]));
      this.error = msg;
    }
  }

  poll(boot = false): void {
    const now = this.now();
    const rows = this.query<OpencodeSessionRow>(
      `select id, parent_id, directory, title, agent, model, time_created, time_updated, time_idle, time_archived, cost,
              tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
         from session_v2
        where time_archived is null and time_updated > ?
        order by time_created`,
      now - PRESENCE_MS,
    );
    const returned = new Set<string>();
    for (const row of rows) {
      let t = this.sessions.get(row.id);
      if (!t) {
        t = this.newTracker(row);
        this.sessions.set(row.id, t);
      }
      t.row = row;
      try {
        this.sync(t, now, boot);
      } catch (err) {
        log.warnOnce(`opencode-session:${row.id}:${errMsg(err)}`, tr('OpenCode: sessão {0}: {1}', [row.id, errMsg(err)]));
      }
      returned.add(row.id);
    }
    // Principais antes dos subagentes (o sub só entra com o pai já no escritório).
    const ordered = [...this.sessions.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
    for (const t of ordered) {
      if (returned.has(t.row.id) && this.wanted(t, now)) {
        delete t.missingSince;
        if (!t.inOffice) this.enter(t, now);
        else this.statusToOffice(t);
        if (t.inOffice && t.kind === 'main' && t.status === 'working') this.opts.office.fillWorkingActivity(t.key);
        continue;
      }
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      if (now - t.lastWriteAt > PRESENCE_MS) this.sessions.delete(t.row.id);
    }
  }

  private newTracker(row: OpencodeSessionRow): SessionTracker {
    return {
      key: `${this.entry?.id ?? 'opencode'}:${row.id}`,
      row,
      kind: row.parent_id ? 'sub' : 'main',
      inOffice: false,
      subDone: false,
      cursor: 0,
      seen: new Set(),
      status: 'idle',
      toolCalls: 0,
      lastWriteAt: row.time_updated,
    };
  }

  /** Lê as mensagens novas da sessão e atualiza status e atividades. */
  private sync(t: SessionTracker, now: number, boot: boolean): void {
    const first = t.cursor === 0;
    const msgs = first
      ? this.query<OpencodeMessageRow>(
          'select * from (select id, seq, type, time_created, time_updated, data from session_message where session_id = ? order by seq desc limit ?) order by seq',
          t.row.id,
          BOOT_MESSAGES,
        )
      : this.query<OpencodeMessageRow>(
          'select id, seq, type, time_created, time_updated, data from session_message where session_id = ? and time_updated > ? order by seq limit ?',
          t.row.id,
          t.cursor,
          BATCH,
        );
    // Sem mensagens: o status vem só da sessão.
    if (first) {
      t.status = t.row.time_idle !== null && t.row.time_idle >= t.row.time_updated ? 'idle' : 'working';
      t.cursor = Math.max(t.row.time_updated, 1);
    }
    for (const m of msgs) {
      t.cursor = Math.max(t.cursor, m.time_updated);
      const r = parseOpencodeMessage(t.row.id, m, t.seen);
      t.toolCalls += r.toolCalls;
      if (r.status) {
        t.status = r.status;
        if (r.waitingFor) t.waitingFor = r.waitingFor;
        else delete t.waitingFor;
      }
      if (t.inOffice) for (const a of r.activities) this.opts.office.addActivity(t.key, a.activity, a.current, { feed: !boot && !first });
      else this.backlog(t, r.activities);
    }
    t.lastWriteAt = Math.max(t.lastWriteAt, t.row.time_updated);
    if (t.status === 'working' && now - t.lastWriteAt > WORKING_QUIET_MS) {
      t.status = 'idle';
      delete t.waitingFor;
    }
    this.applySummary(t);
  }

  private pending = new Map<string, Array<{ activity: Activity; current: boolean }>>();

  private backlog(t: SessionTracker, list: Array<{ activity: Activity; current: boolean }>): void {
    if (!list.length) return;
    const q = this.pending.get(t.key) ?? [];
    q.push(...list);
    if (q.length > BOOT_MESSAGES * 4) q.splice(0, q.length - BOOT_MESSAGES * 4);
    this.pending.set(t.key, q);
  }

  private wanted(t: SessionTracker, now: number): boolean {
    if (t.row.time_archived !== null) return false;
    const active = t.status === 'working' || t.status === 'waiting';
    if (t.kind === 'sub') {
      const parent = this.parentKey(t);
      if (!parent || !this.opts.office.has(parent)) return false;
      return t.inOffice || active;
    }
    return active || now - t.lastWriteAt <= PRESENCE_MS;
  }

  private parentKey(t: SessionTracker): string | undefined {
    return t.row.parent_id ? `${this.entry?.id ?? 'opencode'}:${t.row.parent_id}` : undefined;
  }

  private enter(t: SessionTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: this.entry?.id ?? 'opencode',
        sessionId: t.row.id,
        cwd: t.row.directory,
        role: MAIN_ROLE,
        startedAt: t.row.time_created || now,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const added = office.addSub({
        id: t.key,
        parentId: this.parentKey(t)!,
        sessionId: t.row.id,
        role: t.row.agent ? `${t.row.agent[0].toUpperCase()}${t.row.agent.slice(1)}` : SUB_ROLE,
        title: t.row.title ?? undefined,
        background: false,
        startedAt: t.row.time_created || now,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
      if (t.status === 'waiting') office.setStatus(t.key, 'waiting', t.waitingFor);
    }
    const q = this.pending.get(t.key);
    this.pending.delete(t.key);
    for (const a of q ?? []) office.addActivity(t.key, a.activity, a.current, { feed: false });
    this.applySummary(t);
  }

  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    if (t.kind === 'sub') {
      if (!t.subDone) this.opts.office.completeSub(t.key);
      t.subDone = true;
    } else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  private statusToOffice(t: SessionTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (!office.has(t.key)) {
      t.inOffice = false;
      return;
    }
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

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const r = t.row;
    const model = opencodeModel(r.model);
    this.opts.office.applyTranscript(t.key, {
      ...(r.title ? { title: r.title } : {}),
      ...(model ? { model } : {}),
      tasks: [],
      stats: {
        toolCalls: t.toolCalls,
        tokensIn: r.tokens_input + r.tokens_cache_read + r.tokens_cache_write,
        tokensOut: r.tokens_output + r.tokens_reasoning,
        ...(r.cost ? { costUSD: r.cost } : {}),
        subagents: 0,
      },
      firstAt: r.time_created,
      lastAt: t.lastWriteAt,
    });
  }
}
