// Funções dos agentes ("Estrategista", "Roteirista"...), dadas pelo usuário no escritório e persistidas em
// <dataDir>/jobs.json: por sessão (quem faz o quê) e por sala (as funções já usadas naquele projeto, que a
// tela oferece como sugestão). É só um rótulo: nada daqui é enviado às sessões do Claude Code.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';

interface StoredJob {
  job: string;
  room: string;
  at: number;
}

interface JobsFile {
  version: 1;
  sessions: Record<string, StoredJob>;
  rooms: Record<string, string[]>;
}

/** Tamanho máximo do rótulo (cabe no selo ao lado do nome). */
export const JOB_MAX = 40;
/** Funções guardadas por sala. */
const ROOM_MAX = 40;
const MAX_ENTRIES = 4000;
const MAX_AGE_MS = 60 * 24 * 3_600_000;

/**
 * Normaliza o rótulo digitado: uma linha só, sem caracteres de controle, espaços colapsados e no máximo
 * JOB_MAX caracteres. Vazio (ou não texto) = sem função.
 */
export function cleanJob(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? [...s].slice(0, JOB_MAX).join('').trim() : undefined;
}

const sameJob = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }) === 0;

export class JobStore {
  private sessions = new Map<string, StoredJob>();
  private rooms = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  /** `file` null = só em memória (testes ou diretório de dados indisponível). */
  constructor(
    private readonly file: string | null,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<JobsFile>;
      for (const [key, v] of Object.entries(j.sessions ?? {})) {
        const job = cleanJob(v?.job);
        if (job && typeof v.room === 'string') this.sessions.set(key, { job, room: v.room, at: typeof v.at === 'number' ? v.at : 0 });
      }
      for (const [room, list] of Object.entries(j.rooms ?? {})) {
        if (!Array.isArray(list)) continue;
        const jobs: string[] = [];
        for (const item of list) {
          const job = cleanJob(item);
          if (job && !jobs.some((x) => sameJob(x, job))) jobs.push(job);
        }
        if (jobs.length) this.rooms.set(room, jobs.slice(0, ROOM_MAX));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`jobs.json ilegível (${errMsg(err)}); começando do zero.`);
    }
  }

  /** Função da sessão, se houver. */
  get(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    s.at = this.now();
    return s.job;
  }

  /** Define (ou, com `job` vazio, tira) a função da sessão; uma função nova entra nas sugestões da sala. */
  set(sessionId: string, room: string, job: string | undefined): void {
    if (!job) {
      if (!this.sessions.delete(sessionId)) return;
    } else {
      this.sessions.set(sessionId, { job, room, at: this.now() });
      const list = this.rooms.get(room) ?? [];
      if (!list.some((x) => sameJob(x, job))) this.rooms.set(room, [...list, job].slice(-ROOM_MAX));
    }
    this.scheduleFlush();
  }

  /** A sessão nova (depois de um /clear ou /resume) herda a função da anterior. */
  remember(sessionId: string, from: string): void {
    const s = this.sessions.get(from);
    if (!s) return;
    this.sessions.set(sessionId, { ...s, at: this.now() });
    this.scheduleFlush();
  }

  /** Funções já usadas na sala, na ordem em que apareceram. */
  roomJobs(room: string): string[] {
    return [...(this.rooms.get(room) ?? [])];
  }

  /** Tira uma função das sugestões da sala (quem já a tem continua com ela). */
  forget(room: string, job: string): boolean {
    const list = this.rooms.get(room);
    if (!list) return false;
    const next = list.filter((x) => !sameJob(x, job));
    if (next.length === list.length) return false;
    if (next.length) this.rooms.set(room, next);
    else this.rooms.delete(room);
    this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const now = this.now();
    const kept = [...this.sessions]
      .filter(([, v]) => now - v.at < MAX_AGE_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    this.sessions = new Map(kept);
    const data: JobsFile = { version: 1, sessions: Object.fromEntries(kept), rooms: Object.fromEntries(this.rooms) };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.file);
      log.clearOnce('jobs-write');
    } catch (err) {
      log.warnOnce('jobs-write', `Não foi possível gravar ${this.file} (${errMsg(err)}); as funções valem só nesta execução.`);
    }
  }
}
