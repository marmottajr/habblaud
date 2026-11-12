// Habblaud rodando no WSL e observando também o Claude Code do Windows da mesma máquina: as sessões dele ficam em
// /mnt/<unidade>/Users/<perfil>/.claude*, com caminhos (`C:\...`) e PIDs do Windows. Aqui fica a tradução entre os
// dois lados: reconhecer o WSL, converter caminhos e saber quais PIDs do Windows estão vivos (pelo tasklist.exe,
// já que um PID do Windows não existe no Linux). Node puro e sem dependências.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Onde o WSL monta as unidades do Windows (padrão do automount; ver /etc/wsl.conf). */
export const WSL_MOUNTS = '/mnt';

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.WSL_DISTRO_NAME?.trim();
}

/** `pidDomain` do registro de uma sessão cujo processo roda no Windows (ex.: "win32:arthur"). */
export function isWindowsPidDomain(pidDomain: string | undefined): boolean {
  return !!pidDomain?.startsWith('win32');
}

/** `C:\Users\x` -> `/mnt/c/Users/x`. Sem letra de unidade (UNC, POSIX), devolve como veio. */
export function windowsPathToWsl(path: string, mounts: string = WSL_MOUNTS): string {
  const m = /^([A-Za-z]):(?:[\\/]+(.*))?$/.exec(path);
  if (!m) return path;
  const rest = (m[2] ?? '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return rest ? `${mounts}/${m[1].toLowerCase()}/${rest}` : `${mounts}/${m[1].toLowerCase()}`;
}

/** PIDs de `tasklist /FO CSV /NH` (uma linha por processo: "nome","pid",...). */
export function parseTasklistPids(csv: string): Set<number> {
  const pids = new Set<number>();
  for (const m of csv.matchAll(/^"[^"]*","(\d+)"/gm)) pids.add(Number(m[1]));
  return pids;
}

const TASKLIST_ARGS = ['/FO', 'CSV', '/NH'];
const TASKLIST_TIMEOUT_MS = 5_000;

/** O tasklist.exe pelo caminho montado (um serviço pode não ter o PATH do Windows); senão, pelo PATH. */
function tasklistBin(mounts: string = WSL_MOUNTS): string {
  const abs = join(mounts, 'c', 'Windows', 'System32', 'tasklist.exe');
  return existsSync(abs) ? abs : 'tasklist.exe';
}

function runTasklistSync(): string {
  return execFileSync(tasklistBin(), TASKLIST_ARGS, { encoding: 'utf8', timeout: TASKLIST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
}

function runTasklist(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(tasklistBin(), TASKLIST_ARGS, { encoding: 'utf8', timeout: TASKLIST_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export interface WindowsPidsOptions {
  /** Saída do tasklist, bloqueante: só na primeira consulta (o boot precisa da resposta na hora). */
  listSync?: () => string;
  /** Saída do tasklist, em segundo plano: as renovações. */
  list?: () => Promise<string>;
  now?: () => number;
  /** Idade a partir da qual a lista é renovada (padrão 3 s). */
  ttlMs?: number;
}

/**
 * Quais PIDs do Windows estão vivos, com cache: a primeira consulta lê a lista na hora; as seguintes respondem pelo
 * cache e o renovam em segundo plano quando envelhece (o polling de 1 s nunca espera o tasklist). Sem uma lista
 * confiável (interop desligado, saída inesperada), todo PID conta como vivo: vale o arquivo de sessão, que o
 * Claude Code apaga ao sair.
 */
export class WindowsPids {
  private pids: Set<number> | undefined;
  private fetchedAt: number | undefined;
  private refreshing: Promise<void> | undefined;
  private readonly listSync: () => string;
  private readonly list: () => Promise<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: WindowsPidsOptions = {}) {
    this.listSync = opts.listSync ?? runTasklistSync;
    this.list = opts.list ?? runTasklist;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 3_000;
  }

  isAlive(pid: number): boolean {
    if (this.fetchedAt === undefined) {
      try {
        this.store(this.listSync());
      } catch {
        this.store(undefined);
      }
    } else if (this.now() - this.fetchedAt >= this.ttlMs) {
      this.refresh();
    }
    return this.pids ? this.pids.has(pid) : true;
  }

  /** Espera a renovação em andamento (testes). */
  async idle(): Promise<void> {
    await this.refreshing;
  }

  private refresh(): void {
    if (this.refreshing) return;
    this.refreshing = this.list()
      .then(
        (csv) => this.store(csv),
        () => this.store(undefined),
      )
      .finally(() => {
        this.refreshing = undefined;
      });
  }

  private store(csv: string | undefined): void {
    const pids = csv === undefined ? undefined : parseTasklistPids(csv);
    // Lista vazia não é o Windows sem processos: é uma saída que não entendemos.
    this.pids = pids?.size ? pids : undefined;
    this.fetchedAt = this.now();
  }
}

let shared: WindowsPids | undefined;

/** Um PID do Windows está vivo? (instância única do processo: um tasklist serve todas as contas). */
export function windowsPidAlive(pid: number): boolean {
  shared ??= new WindowsPids();
  return shared.isAlive(pid);
}
