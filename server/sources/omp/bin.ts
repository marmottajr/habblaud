// Onde está o `omp` deste computador e como rodar `omp usage --json` (uso do plano das contas do omp, ver usage.ts).
// Sem shell: no Windows o `omp.exe` do bun é binário nativo, então execFile direto serve — e só ele: um `omp.cmd` (ex.: o
// `node_modules/.bin` que o npm põe no PATH) exigiria cmd.exe, e o Node recusa .cmd/.bat sem shell (EINVAL). Sempre com
// `--redact`: o JSON não é guardado, mas uma mensagem de erro pode ecoar trechos dele no log.
import { execFile } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { findExecutable, isExecutableFile } from '../../claude-bin';

/**
 * `omp` deste computador: HABBLAUD_OMP_BIN (caminho, ou nome no PATH) › `omp` no PATH › ~/.bun/bin/omp[.exe]. No
 * Windows, um nome sem extensão é procurado só como `.exe`.
 */
export function ompBinFrom(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const set = env.HABBLAUD_OMP_BIN?.trim();
  if (set && /[\\/]/.test(set)) {
    const file = resolve(set);
    return isExecutableFile(file, platform) ? file : undefined;
  }
  const name = set || 'omp';
  const found = findExecutable(platform === 'win32' && !extname(name) ? `${name}.exe` : name, env, platform);
  if (found || set) return found;
  const bun = join(home, '.bun', 'bin', platform === 'win32' ? 'omp.exe' : 'omp');
  return isExecutableFile(bun, platform) ? bun : undefined;
}

export const OMP_USAGE_TIMEOUT_MS = 20_000;
export const OMP_USAGE_MAX_BYTES = 1024 * 1024;

export type RunOmpUsage = (bin: string, agentDir: string, env: NodeJS.ProcessEnv) => Promise<string>;

/** Roda `omp usage --json --redact` com PI_CODING_AGENT_DIR=agentDir, sem shell. Rejeita com a 1ª linha útil do stderr/erro. */
export const runOmpUsage: RunOmpUsage = (bin, agentDir, env) => {
  const { promise, resolve: ok, reject: fail } = Promise.withResolvers<string>();
  try {
    execFile(
      bin,
      ['usage', '--json', '--redact'],
      {
        env: { ...env, PI_CODING_AGENT_DIR: agentDir },
        timeout: OMP_USAGE_TIMEOUT_MS,
        maxBuffer: OMP_USAGE_MAX_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, out, stderr) => {
        if (!err) return ok(out);
        const line = String(stderr ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        fail(new Error((line ?? (err.killed ? `timeout (${OMP_USAGE_TIMEOUT_MS / 1000} s)` : err.message)).slice(0, 200)));
      },
    );
  } catch (err) {
    // Erro síncrono do spawn (ex.: EINVAL num .cmd apontado por HABBLAUD_OMP_BIN): falha da leitura, não do ciclo.
    fail(err);
  }
  return promise;
};
