// Início real dos processos vivos, lido do sistema operacional, para saber se o PID de um registro de sessões
// (<conta>/sessions/<pid>.json) ainda é o do Claude Code que o gravou. O registro pode ficar para trás (crash,
// computador reiniciado) e o PID ser reaproveitado por outro processo: aí `process.kill(pid, 0)` diz "vivo" e a
// sessão ficaria no escritório para sempre. Só funciona onde os processos do host aparecem: o servidor fora do Docker
// e o `npm run docker:up`, que roda no host. Node puro e sem dependências (o docker:up importa via tsx).
//
// Uma consulta só para todos os PIDs: `ps` no macOS e no Linux; no Windows, o PowerShell (Get-Process e, para os
// processos cujo início ele não deixa ler sem ser administrador, o WMI).
import { execFile, execFileSync } from 'node:child_process';

export interface ProcStart {
  /** Início do processo, em ms desde 1970. */
  startMs: number;
  /** Windows: o início como FILETIME, o formato do `procStart` do registro. */
  fileTime?: string;
}

/**
 * PID → início de cada processo que existe; `null` = existe, mas o início não pôde ser lido. Um PID pedido que não
 * está no mapa não existe mais.
 */
export type ProcStarts = Map<number, ProcStart | null>;

/** Como consultar: bloqueando (ao ligar o servidor e no docker:up) ou não. `undefined` = não deu para consultar. */
export interface ProcLookup {
  sync(pids: readonly number[]): ProcStarts | undefined;
  async(pids: readonly number[]): Promise<ProcStarts | undefined>;
}

/** Diferença entre 1601 (FILETIME) e 1970, em ms. */
const FILETIME_EPOCH_MS = 11_644_473_600_000n;
/** Folga entre o `procStart` do registro e o FILETIME lido: o WMI arredonda para microssegundos. */
const FILETIME_SLACK = 10_000n;
/**
 * Sem `procStart` igual: o processo só é outro se nasceu bem depois da última gravação do registro (quem gravou
 * existia naquela hora). A folga cobre a resolução do `ps` (1 s) e pequenos acertos do relógio.
 */
export const BORN_AFTER_MS = 60_000;
const SYNC_TIMEOUT_MS = 5_000;
const ASYNC_TIMEOUT_MS = 10_000;

/** O que o registro diz do processo que o gravou. */
export interface RegisteredStart {
  /** `procStart` do registro (no Windows, o FILETIME do início do processo). */
  procStart?: string;
  /** Última vez que o registro foi gravado (ms desde 1970). */
  lastWriteMs: number;
}

/**
 * O processo que tem o PID hoje é o que gravou o registro (`same`) ou outro, que ficou com o PID depois (`other`)?
 * `procStart` igual ao início lido: é o mesmo, sem depender de relógio. Senão, só é outro se nasceu depois da última
 * gravação do registro; na dúvida, é o mesmo (mostrar uma sessão a mais é melhor que esconder uma que existe).
 */
export function pidOwner(reg: RegisteredStart, proc: ProcStart): 'same' | 'other' {
  if (reg.procStart && proc.fileTime && /^\d{17,19}$/.test(reg.procStart) && /^\d{17,19}$/.test(proc.fileTime)) {
    const diff = BigInt(reg.procStart) - BigInt(proc.fileTime);
    if ((diff < 0n ? -diff : diff) <= FILETIME_SLACK) return 'same';
  }
  return proc.startMs > reg.lastWriteMs + BORN_AFTER_MS ? 'other' : 'same';
}

function validPids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((p) => Number.isSafeInteger(p) && p > 0))];
}

/** Script do PowerShell: uma linha "<pid> <FILETIME>" por processo que existe ("<pid> ?" se o início não sai). */
function windowsScript(pids: readonly number[]): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `foreach ($p in Get-Process -Id ${pids.join(',')}) {`,
    '  $t = $null',
    '  try { $t = $p.StartTime.ToFileTimeUtc() } catch {}',
    '  if ($null -eq $t) { try { $t = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").CreationDate.ToFileTimeUtc() } catch {} }',
    '  if ($null -eq $t) { "$($p.Id) ?" } else { "$($p.Id) $t" }',
    '}',
  ].join('\n');
}

/** O comando da consulta (os PIDs já conferidos: só inteiros positivos entram na linha de comando). */
export function procStartCommand(pids: readonly number[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (platform === 'win32') {
    // -EncodedCommand (UTF-16LE em base64): nada de aspas para o Windows reinterpretar.
    const encoded = Buffer.from(windowsScript(pids), 'utf16le').toString('base64');
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded] };
  }
  // lstart em inglês (LC_ALL=C): "Mon Oct 12 22:46:14 2026".
  return { file: 'ps', args: ['-o', 'pid=', '-o', 'lstart=', '-p', pids.join(',')], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
}

/** Saída da consulta → PID e início de cada processo. */
export function parseProcStarts(out: string, platform: NodeJS.Platform = process.platform): ProcStarts {
  const map: ProcStarts = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (platform === 'win32') {
      const m = /^\s*(\d+)\s+(\d{17,19}|\?)\s*$/.exec(line);
      if (!m) continue;
      map.set(Number(m[1]), m[2] === '?' ? null : { startMs: Number(BigInt(m[2]) / 10_000n - FILETIME_EPOCH_MS), fileTime: m[2] });
    } else {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
      if (!m) continue;
      const startMs = Date.parse(m[2]);
      map.set(Number(m[1]), Number.isFinite(startMs) ? { startMs } : null);
    }
  }
  return map;
}

/**
 * Falhou porque o programa saiu com erro (o `ps` sai com 1 quando nenhum dos PIDs existe) ou porque nem rodou
 * (não achado, prazo esgotado)? No primeiro caso a saída vale; no segundo, não deu para consultar.
 */
function ranToTheEnd(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; killed?: boolean; signal?: unknown } | null;
  if (!e || e.killed || e.signal) return false;
  return typeof e.code === 'number' || typeof e.status === 'number';
}

/** Início dos processos, bloqueando até a resposta (uma consulta para todos). */
export function readProcStartsSync(pids: readonly number[], platform: NodeJS.Platform = process.platform): ProcStarts | undefined {
  const list = validPids(pids);
  if (!list.length) return new Map();
  const cmd = procStartCommand(list, platform);
  try {
    const out = execFileSync(cmd.file, cmd.args, { encoding: 'utf8', timeout: SYNC_TIMEOUT_MS, windowsHide: true, env: cmd.env, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseProcStarts(out, platform);
  } catch (err) {
    if (platform === 'win32' || !ranToTheEnd(err)) return undefined;
    return parseProcStarts(String((err as { stdout?: unknown }).stdout ?? ''), platform);
  }
}

/** A mesma consulta, sem bloquear. */
export function readProcStarts(pids: readonly number[], platform: NodeJS.Platform = process.platform): Promise<ProcStarts | undefined> {
  const list = validPids(pids);
  if (!list.length) return Promise.resolve(new Map());
  const cmd = procStartCommand(list, platform);
  return new Promise((ok) => {
    execFile(cmd.file, cmd.args, { encoding: 'utf8', timeout: ASYNC_TIMEOUT_MS, windowsHide: true, env: cmd.env }, (err, stdout) => {
      if (err && (platform === 'win32' || !ranToTheEnd(err))) return ok(undefined);
      ok(parseProcStarts(String(stdout ?? ''), platform));
    });
  });
}

/** A consulta de verdade, no sistema operacional deste computador. */
export const systemProcLookup: ProcLookup = {
  sync: (pids) => readProcStartsSync(pids),
  async: (pids) => readProcStarts(pids),
};
