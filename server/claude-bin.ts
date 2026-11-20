// Onde está o `claude` do Claude Code neste computador. Usado pelo terminal interativo (pty/manager.ts), pelo Novo
// agente (spawn/spawn.ts) e pelo auxiliar do host (scripts/codex-bridge.ts). Node puro e sem dependências.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

/** O arquivo existe e pode ser executado (no Windows basta existir: lá não há permissão de execução). */
export function isExecutableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Procura um executável no PATH (no Windows, também com as extensões de PATHEXT, se o nome não tiver uma). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const sep = platform === 'win32' ? ';' : ':';
  const exts =
    platform === 'win32' && !extname(name) ? ['.exe', ...(env.PATHEXT ?? '.COM;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = resolve(dir, name + ext);
      if (isExecutableFile(file, platform)) return file;
    }
  }
  return undefined;
}

/**
 * O executável do Claude Code: HABBLAUD_CLAUDE_BIN (um caminho, ou um nome procurado
 * no PATH) ou o `claude` do PATH. undefined se não achar.
 */
export function claudeBinFrom(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const set = env.HABBLAUD_CLAUDE_BIN?.trim();
  if (!set) return findExecutable('claude', env, platform);
  return /[\\/]/.test(set) ? resolve(set) : findExecutable(set, env, platform);
}

/** O `claude` que dá para rodar: o de claudeBinFrom, se o arquivo existe e é executável. */
export function runnableClaudeBin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const bin = claudeBinFrom(env, platform);
  return bin && isExecutableFile(bin, platform) ? bin : undefined;
}

/** Como rodar o `claude`: programa, argumentos e se a linha já vai escapada para o cmd.exe (windowsVerbatimArguments). */
export interface ClaudeLaunch {
  file: string;
  args: string[];
  verbatim: boolean;
}

const SHIM_TARGET = /\.(exe|[cm]?js)$/i;
const DP0 = /%~?dp0%?/gi;

function readOrUndefined(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

/**
 * O programa que um lançador do Windows roda, ou undefined se `bin` não é um lançador conhecido (ou o alvo sumiu):
 * - `claude.cmd` do npm: a linha com `%*` ("%dp0%\..\pacote\bin\claude.exe" %*, ou o node com o cli.js);
 * - `claude.exe` do bun: o caminho (UTF-16, relativo ao node_modules) gravado no `claude.bunx` ao lado.
 */
function shimTarget(bin: string): string | undefined {
  const ext = extname(bin).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const line = readOrUndefined(bin)
      ?.toString('utf8')
      .split(/\r?\n/)
      .findLast((l) => l.includes('%*'));
    if (!line) return undefined;
    const dir = dirname(bin);
    const paths = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((t) => t.match(DP0));
    return paths
      .map((t) => join(dir, t.replace(DP0, '').replace(/[\\/]+/g, sep)))
      .findLast((p) => SHIM_TARGET.test(p) && existsSync(p));
  }
  if (ext === '.exe') {
    const rel = readOrUndefined(`${bin.slice(0, -ext.length)}.bunx`)?.toString('utf16le').split('"')[0].replace(/\0/g, '').trim();
    if (!rel) return undefined;
    const target = join(dirname(dirname(bin)), rel.replace(/[\\/]+/g, sep));
    return SHIM_TARGET.test(target) && existsSync(target) ? target : undefined;
  }
  return undefined;
}

/** Um argumento entre aspas para o cmd.exe: `"` vira `\"`, `\` antes de aspas dobra e `%` não expande variável. */
function cmdArg(arg: string): string {
  let out = '"';
  let slashes = 0;
  // O cmd.exe encerra o comando na quebra de linha: um pedido de várias linhas vira uma linha só.
  for (const c of arg.replace(/\r?\n/g, ' ')) {
    if (c === '\\') {
      slashes++;
      out += c;
      continue;
    }
    if (c === '"') out += '\\'.repeat(slashes) + '"';
    // %cd:~,% expande para nada: separa o % do nome e %PATH% chega como texto.
    else if (c === '%') out += '%%cd:~,';
    slashes = 0;
    out += c;
  }
  return `${out}${'\\'.repeat(slashes)}"`;
}

/**
 * Como rodar `bin` com `args`. Os lançadores do npm e do bun no Windows viram o programa de verdade: sem o cmd.exe
 * no meio, o pedido vai inteiro (com quebras de linha) e o PID do processo aberto é o do Claude Code (o mesmo do
 * registro de sessões). Um .cmd/.bat desconhecido roda pelo cmd.exe, com cada parte entre aspas, sem deixar ele
 * interpretar &, |, %, ! nem aspas do texto do usuário (aí um pedido de várias linhas chega numa linha só).
 */
export function claudeLaunch(bin: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ClaudeLaunch {
  const target = shimTarget(bin);
  if (target && /\.exe$/i.test(target)) return { file: target, args: [...args], verbatim: false };
  if (target) {
    // O cli.js do pacote npm: o node.exe ao lado do lançador (como o próprio .cmd faria) ou o que roda o Habblaud.
    const local = join(dirname(bin), 'node.exe');
    return { file: existsSync(local) ? local : process.execPath, args: [target, ...args], verbatim: false };
  }
  if (/\.(cmd|bat)$/i.test(bin)) {
    return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', `"${[bin, ...args].map(cmdArg).join(' ')}"`], verbatim: true };
  }
  return { file: bin, args: [...args], verbatim: false };
}
