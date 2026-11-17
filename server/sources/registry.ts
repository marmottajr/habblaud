// Registro de sessões ABERTAS do Claude Code: <configDir>/sessions/<pid>.json.
// O arquivo existe enquanto o processo vive, mas pode sobrar se o processo morrer sem limpar (crash, computador
// reiniciado). Fora do Docker confirmamos que o PID existe e que ainda é o do processo que gravou o registro (um PID
// reaproveitado por outro processo continua "vivo": sources/procstart.ts). No Docker os PIDs são do host: quem
// confere é o `npm run docker:up`, que roda lá e passa os registros antigos em HABBLAUD_STALE_SESSIONS.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus } from '../../shared/types';
import { describeWaitingFor } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { pidOwner, type ProcLookup, type ProcStarts } from './procstart';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  /** Início do processo como o Claude Code o gravou (no Windows, um FILETIME); identifica o processo junto com o PID. */
  procStart?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  /** 'busy' | 'idle' | 'waiting' | 'shell' (versões antigas não têm; 'shell' = ocioso com shell em segundo plano). */
  status?: string;
  waitingFor?: string;
  /** Agente customizado da sessão (`claude --agent frinus`). */
  agent?: string;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Valida o JSON de um registro. Campos essenciais ausentes -> undefined. */
export function parseRegistryEntry(raw: string): RegistryEntry | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const pid = num(j.pid);
  const sessionId = str(j.sessionId);
  const cwd = str(j.cwd);
  if (pid === undefined || !sessionId || !cwd) return undefined;
  const e: RegistryEntry = { pid, sessionId, cwd };
  const optional: Array<[keyof RegistryEntry, unknown]> = [
    ['startedAt', num(j.startedAt)],
    ['procStart', str(j.procStart)],
    ['version', str(j.version)],
    ['kind', str(j.kind)],
    ['entrypoint', str(j.entrypoint)],
    ['name', str(j.name)],
    ['status', str(j.status)],
    ['waitingFor', str(j.waitingFor)],
    ['agent', str(j.agent)],
    ['updatedAt', num(j.updatedAt)],
    ['statusUpdatedAt', num(j.statusUpdatedAt)],
  ];
  for (const [k, v] of optional) if (v !== undefined) (e as unknown as Record<string, unknown>)[k] = v;
  return e;
}

/**
 * Primeira versão do Claude Code sabidamente gravando "shell" no registro (ocioso com shell em segundo plano).
 * Dela em diante, "idle" é a palavra final sobre shells: nada em segundo plano rodando.
 */
export const SHELL_STATUS_VERSION = '2.1.292';

/** Compara versões "x.y.z" (sufixos como "-beta" são ignorados). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Status do registro -> status do personagem (undefined = desconhecido; o transcript decide). */
export function registryStatus(e: RegistryEntry): { status?: AgentStatus; waitingFor?: string } {
  switch (e.status) {
    case 'busy':
      return { status: 'working' };
    case 'idle':
      return { status: 'idle' };
    // Ocioso, mas com shell(s) em segundo plano rodando (monitores não contam): esperando o shell.
    case 'shell':
      return { status: 'shell' };
    case 'waiting':
      return { status: 'waiting', waitingFor: describeWaitingFor(e.waitingFor) };
    default:
      return {};
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: o processo existe, só não é nosso.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Última gravação do registro: os horários que o próprio Claude Code grava nele ou, se faltarem, a data do arquivo. */
export function registryLastWrite(e: RegistryEntry, mtimeMs: number): number {
  return Math.max(e.updatedAt ?? 0, e.statusUpdatedAt ?? 0, e.startedAt ?? 0) || mtimeMs;
}

/** Um registro que o host conferiu e sabe que é antigo: o processo que o gravou não existe mais. */
export interface StaleSession {
  account: string;
  pid: number;
  sessionId: string;
  startedAt?: number;
}

/**
 * Identidade de um registro antigo. Como o processo morreu, o arquivo não muda mais: conta, PID, sessão e início
 * continuam os mesmos. Um processo novo que receba o mesmo PID grava outra sessão (ou, numa retomada, outro início).
 */
export function staleKey(account: string, e: Pick<RegistryEntry, 'pid' | 'sessionId' | 'startedAt'>): string {
  return `${account}\n${e.pid}\n${e.sessionId}\n${e.startedAt ?? ''}`;
}

/**
 * HABBLAUD_STALE_SESSIONS (JSON, gerado pelo `npm run docker:up`): os registros antigos de cada conta. Devolve o
 * teste "este registro é um deles?", ou undefined se não há nenhum (ou o valor não é o esperado).
 */
export function parseStaleSessions(raw: string | undefined): ((account: string, e: RegistryEntry) => boolean) | undefined {
  if (!raw?.trim()) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const keys = new Set<string>();
  for (const item of list as Array<Record<string, unknown> | null>) {
    if (!item || typeof item !== 'object') continue;
    const account = str(item.account);
    const pid = num(item.pid);
    const sessionId = str(item.sessionId);
    if (!account || pid === undefined || !sessionId) continue;
    keys.add(staleKey(account, { pid, sessionId, startedAt: num(item.startedAt) }));
  }
  return keys.size ? (account, e) => keys.has(staleKey(account, e)) : undefined;
}

export interface RegistryPoll {
  entries: RegistryEntry[];
  ok: boolean;
  error?: string;
}

interface Cached {
  mtimeMs: number;
  size: number;
  entry: RegistryEntry | undefined;
}

/** Um registro com o PID vivo, à espera da conferência do dono do PID. */
interface LiveEntry {
  file: string;
  entry: RegistryEntry;
  lastWriteMs: number;
}

/**
 * O que se sabe do dono do PID de um registro: `checking` = consulta em andamento (ainda não aparece); `same` = é o
 * processo que gravou o registro; `other` = outro processo ficou com o PID (registro antigo: não aparece);
 * `unknown` = não deu para saber (aparece, como sempre apareceu). Vale enquanto o PID existir: quando ele some, a
 * conferência é esquecida e recomeça se o PID voltar.
 */
interface Owner {
  verdict: 'checking' | 'same' | 'other' | 'unknown';
  /** Última gravação do registro quando foi conferido. */
  lastWriteMs: number;
}

export interface RegistryOptions {
  /** Confere se o PID existe (fora do Docker). */
  checkPid: boolean;
  isAlive?: (pid: number) => boolean;
  /**
   * Com `checkPid`: confere também se o PID ainda é o do processo que gravou o registro. A primeira leitura consulta
   * bloqueando (o boot já sai sem os registros antigos); depois, sem bloquear, e o registro só aparece com a resposta.
   */
  procs?: ProcLookup;
  /** Registros que o host já sabe que são antigos (Docker: HABBLAUD_STALE_SESSIONS). */
  isStale?: (entry: RegistryEntry) => boolean;
  /** Chegou a resposta de uma consulta sem bloquear: vale ler de novo. */
  onChange?: () => void;
}

export class RegistryReader {
  private cache = new Map<string, Cached>();
  private owners = new Map<string, Owner>();
  /** Já houve uma leitura (a primeira confere os donos dos PIDs bloqueando). */
  private polled = false;
  private readonly sessionsDir: string;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    readonly configDir: string,
    private readonly opts: RegistryOptions,
  ) {
    this.sessionsDir = join(configDir, 'sessions');
    this.isAlive = opts.isAlive ?? pidAlive;
  }

  poll(): RegistryPoll {
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch (err) {
      this.cache.clear();
      this.owners.clear();
      const code = (err as NodeJS.ErrnoException).code;
      return { entries: [], ok: false, error: code === 'ENOENT' ? tr('pasta sessions/ não encontrada') : tr('sessions/ ilegível ({0})', [code ?? tr('erro')]) };
    }
    const seen = new Set<string>();
    const live: LiveEntry[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.sessionsDir, name);
      seen.add(file);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let cached = this.cache.get(file);
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        let entry: RegistryEntry | undefined;
        try {
          entry = parseRegistryEntry(readFileSync(file, 'utf8'));
        } catch {
          entry = undefined;
        }
        if (entry) cached = { mtimeMs: st.mtimeMs, size: st.size, entry };
        // JSON inválido (arquivo sendo gravado): mantém a última versão boa e tenta de novo no próximo ciclo.
        else cached = cached ? { ...cached } : { mtimeMs: 0, size: -1, entry: undefined };
        this.cache.set(file, cached);
      }
      const e = cached.entry;
      if (!e) continue;
      if (this.opts.isStale?.(e)) continue;
      if (this.opts.checkPid && !this.isAlive(e.pid)) {
        // O processo saiu: se o PID voltar a existir, é outro processo, e a conferência recomeça.
        this.owners.delete(file);
        continue;
      }
      live.push({ file, entry: e, lastWriteMs: registryLastWrite(e, st.mtimeMs) });
    }
    for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.cache.delete(file);
    for (const file of [...this.owners.keys()]) if (!seen.has(file)) this.owners.delete(file);
    const entries = this.opts.checkPid && this.opts.procs ? this.confirmOwners(live, this.opts.procs) : live.map((l) => l.entry);
    this.polled = true;
    return { entries, ok: true };
  }

  /** Só os registros cujo PID ainda é (ou pode ser) o do processo que os gravou; consulta os que faltam conferir. */
  private confirmOwners(live: readonly LiveEntry[], procs: ProcLookup): RegistryEntry[] {
    const pending: Array<LiveEntry & { owner: Owner }> = [];
    for (const l of live) {
      const o = this.owners.get(l.file);
      if (!o) {
        const owner: Owner = { verdict: 'checking', lastWriteMs: l.lastWriteMs };
        this.owners.set(l.file, owner);
        pending.push({ ...l, owner });
      } else if (o.verdict === 'other' && l.lastWriteMs > o.lastWriteMs) {
        // Regravado depois de dado como antigo: só o Claude Code com este PID grava o arquivo, logo ele está vivo.
        o.verdict = 'same';
      }
    }
    if (pending.length) {
      const pids = pending.map((l) => l.entry.pid);
      if (!this.polled) {
        this.judge(pending, procs.sync(pids));
      } else {
        const done = (found: ProcStarts | undefined) => {
          this.judge(pending, found);
          this.opts.onChange?.();
        };
        procs.async(pids).then(done, () => done(undefined));
      }
    }
    return live.filter((l) => {
      const verdict = this.owners.get(l.file)?.verdict;
      return verdict === 'same' || verdict === 'unknown';
    }).map((l) => l.entry);
  }

  /** Aplica a resposta de uma consulta aos registros que a esperavam (o que foi esquecido nesse meio-tempo fica de fora). */
  private judge(pending: ReadonlyArray<LiveEntry & { owner: Owner }>, found: ProcStarts | undefined): void {
    for (const l of pending) {
      if (this.owners.get(l.file) !== l.owner) continue;
      // Sem resposta, processo que sumiu no meio da consulta ou início ilegível: não dá para saber.
      const proc = found?.get(l.entry.pid);
      l.owner.verdict = proc ? pidOwner({ procStart: l.entry.procStart, lastWriteMs: l.lastWriteMs }, proc) : 'unknown';
    }
  }
}
