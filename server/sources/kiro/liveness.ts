// Quais sessões do Kiro CLI estão abertas. O .lock guarda o PID, mas PID é reaproveitado: um lock esquecido (Kiro
// fechado à força) passa a apontar para outro programa (no Windows, meses depois, para um svchost). Então o processo
// tem de ser mesmo o Kiro:
//   proc      Linux: /proc/<pid>/comm ou o executável com "kiro" (e os descendentes, para saber se um shell rodou)
//   tasklist  Windows, e o WSL lendo as sessões do Windows (/mnt/c/...): os kiro-cli.exe vivos (tasklist.exe)
//   ps        macOS: ps -axo pid=,comm=
//   pid       só process.kill(pid, 0) (HABBLAUD_KIRO_LIVENESS=pid)
//   mtime     sem olhar processo (Docker, ou sem como listar): lock, .json ou .jsonl mexido nas últimas 12 h
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export type KiroLivenessMode = 'proc' | 'tasklist' | 'ps' | 'pid' | 'mtime';

export interface KiroLiveness {
  readonly mode: KiroLivenessMode;
  /** O PID é de um Kiro vivo? undefined = sem resposta (lista ainda carregando ou o método falhou: use o mtime). */
  isKiro(pid: number): boolean | undefined;
  /** Descendentes do processo -> quando cada um começou (ms; só no Linux). undefined = sem como saber. */
  descendants?(pid: number): Map<number, number> | undefined;
  /**
   * Bytes lidos e escritos pelo processo até agora (/proc/<pid>/io: rchar, wchar; só no Linux). O Kiro parado
   * pedindo aprovação não lê nem escreve nada; esperando o modelo, lê da rede e mexe no spinner.
   */
  io?(pid: number): { r: number; w: number } | undefined;
  /** Chamado a cada varredura que tem locks: renova a lista de processos, se for a hora. */
  refresh?(now: number): void;
}

const KIRO_NAME = /kiro/i;
/** tasklist.exe visto do WSL (interop). */
export const TASKLIST_WSL = '/mnt/c/Windows/System32/tasklist.exe';
const LIST_TTL_MS = 4_000;
const CLK_TCK = 100;
const EXEC_TIMEOUT_MS = 8_000;

/** PID vivo? EPERM também é vivo (o processo existe, só é de outro usuário). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, readVersion: () => string = () => readFileSync('/proc/version', 'utf8')): boolean {
  if (process.platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readVersion());
  } catch {
    return false;
  }
}

/** Pasta do Windows vista de dentro do WSL (/mnt/c/...). */
export function isWindowsMount(path: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(path);
}

export interface ChooseLivenessOptions {
  env?: NodeJS.ProcessEnv;
  sessionsDir: string;
  inDocker?: boolean;
  platform?: NodeJS.Platform;
  wsl?: boolean;
  tasklistExists?: boolean;
}

/** Método para a pasta de sessões: HABBLAUD_KIRO_LIVENESS=pid|mtime força; senão, o melhor da plataforma. */
export function chooseLivenessMode(o: ChooseLivenessOptions): KiroLivenessMode {
  const env = o.env ?? process.env;
  const want = env.HABBLAUD_KIRO_LIVENESS?.trim().toLowerCase();
  if (want === 'mtime' || want === 'pid') return want;
  if (o.inDocker) return 'mtime';
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') return 'tasklist';
  if (platform === 'darwin') return 'ps';
  if (platform === 'linux') {
    if (isWindowsMount(o.sessionsDir) && (o.wsl ?? isWsl(env))) return (o.tasklistExists ?? existsSync(TASKLIST_WSL)) ? 'tasklist' : 'mtime';
    return 'proc';
  }
  return 'pid';
}

/** Linhas CSV do tasklist (`"kiro-cli.exe","18400",...`) -> PIDs cujo nome tem "kiro". */
export function parseTasklist(out: string): Set<number> {
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && KIRO_NAME.test(m[1])) pids.add(Number(m[2]));
  }
  return pids;
}

/** Saída do `ps -axo pid=,comm=` -> PIDs cujo executável tem "kiro". */
export function parsePs(out: string): Set<number> {
  const pids = new Set<number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m && KIRO_NAME.test(m[2].split('/').pop() ?? '')) pids.add(Number(m[1]));
  }
  return pids;
}

export interface LivenessDeps {
  /** Raiz do /proc (testes). */
  procRoot?: string;
  /** Execução síncrona (a primeira lista, para o boot já sair certo) e assíncrona (as renovações). */
  execSync?: (bin: string, args: string[]) => string;
  exec?: (bin: string, args: string[], done: (err: Error | null, out: string) => void) => void;
  platform?: NodeJS.Platform;
}

const defaultExecSync = (bin: string, args: string[]): string =>
  execFileSync(bin, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const defaultExec = (bin: string, args: string[], done: (err: Error | null, out: string) => void): void => {
  execFile(bin, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, out) => done(err, String(out ?? '')));
};

/** Lista de processos renovada em segundo plano (tasklist/ps): no máximo uma chamada a cada LIST_TTL_MS. */
function listLiveness(mode: 'tasklist' | 'ps', bin: string, args: string[], parse: (out: string) => Set<number>, deps: LivenessDeps): KiroLiveness {
  const execSync = deps.execSync ?? defaultExecSync;
  const exec = deps.exec ?? defaultExec;
  let pids: Set<number> | undefined;
  let at = -Infinity;
  let inflight = false;
  let failures = 0;
  return {
    mode,
    isKiro(pid) {
      if (!pids) return undefined;
      return pids.has(pid);
    },
    refresh(now) {
      if (failures >= 3) return; // desistiu: o watcher cai no mtime
      if (!pids) {
        try {
          pids = parse(execSync(bin, args));
          at = now;
          failures = 0;
        } catch {
          failures++;
        }
        return;
      }
      if (inflight || now - at < LIST_TTL_MS) return;
      inflight = true;
      exec(bin, args, (err, out) => {
        inflight = false;
        at = now;
        if (err) {
          if (++failures >= 3) pids = undefined;
          return;
        }
        failures = 0;
        pids = parse(out);
      });
    },
  };
}

function procLiveness(root: string): KiroLiveness {
  const read = (p: string): string | undefined => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    mode: 'proc',
    io(pid) {
      const s = read(`${root}/${pid}/io`);
      if (!s) return undefined;
      const r = /^rchar: (\d+)/m.exec(s);
      const w = /^wchar: (\d+)/m.exec(s);
      return r && w ? { r: Number(r[1]), w: Number(w[1]) } : undefined;
    },
    isKiro(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const comm = read(`${root}/${pid}/comm`);
      if (comm === undefined) return false;
      if (KIRO_NAME.test(comm)) return true;
      const exe = (read(`${root}/${pid}/cmdline`) ?? '').split('\0')[0] ?? '';
      return KIRO_NAME.test(exe.split('/').pop() ?? '');
    },
    descendants(pid) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        return undefined;
      }
      const btime = Number(/^btime (\d+)/m.exec(read(`${root}/stat`) ?? '')?.[1] ?? NaN);
      if (!Number.isFinite(btime)) return undefined;
      const kids = new Map<number, number[]>();
      const started = new Map<number, number>();
      for (const n of names) {
        if (!/^\d+$/.test(n)) continue;
        const stat = read(`${root}/${n}/stat`);
        if (!stat) continue;
        // "pid (comm) estado ppid … starttime …": o comm pode ter espaços e parênteses, então conta depois do
        // último ")". starttime (campo 22) vem em ticks desde o boot (CLK_TCK = 100 no Linux).
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(f[1]);
        if (!Number.isInteger(ppid)) continue;
        const list = kids.get(ppid);
        if (list) list.push(Number(n));
        else kids.set(ppid, [Number(n)]);
        started.set(Number(n), (btime + Number(f[19]) / CLK_TCK) * 1000);
      }
      const out = new Map<number, number>();
      const queue = [pid];
      while (queue.length) {
        for (const k of kids.get(queue.shift()!) ?? []) {
          if (out.has(k)) continue;
          out.set(k, started.get(k) ?? NaN);
          queue.push(k);
        }
      }
      return out;
    },
  };
}

export function createLiveness(mode: KiroLivenessMode, deps: LivenessDeps = {}): KiroLiveness {
  const platform = deps.platform ?? process.platform;
  switch (mode) {
    case 'proc':
      return procLiveness(deps.procRoot ?? '/proc');
    case 'tasklist':
      return listLiveness('tasklist', platform === 'win32' ? 'tasklist' : TASKLIST_WSL, ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq kiro*'], parseTasklist, deps);
    case 'ps':
      return listLiveness('ps', 'ps', ['-axo', 'pid=,comm='], parsePs, deps);
    case 'pid':
      return { mode, isKiro: pidAlive };
    case 'mtime':
      return { mode, isKiro: () => undefined };
  }
}
