// Instala (ou remove) os hooks do Habblaud no Google Antigravity CLI (`agy`). Roda no HOST, com tsx:
//
//   npm run antigravity:install     # acrescenta o hook "habblaud" em ~/.gemini/config/hooks.json (backup antes)
//   npm run antigravity:uninstall   # tira só o hook "habblaud" (os outros hooks ficam)
//   npm run antigravity:status      # mostra se o hook está instalado e se o Habblaud está respondendo
//   (opções: --dry-run, --port <n>, --node <caminho>)
//
// No Antigravity CLI, `~/.gemini/config/hooks.json` é um objeto `{ "<nome-do-hook>": { SessionStart, PreInvocation,
// PostInvocation, Stop, PreToolUse: [{matcher, hooks}], PostToolUse: [{matcher, hooks}] } }`. O instalador gerencia
// apenas a chave `"habblaud"` (preservando quaisquer outros hooks no arquivo).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from '../shared/i18n';
import { discoverAntigravityDirs } from '../server/sources/antigravity/accounts';
import { chooseNode, hookCommand, MIN_NODE_MAJOR, nodeMajor } from './codex-install';
import { readSettings, tildify, writeSettings, type Settings } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-antigravity', 'hook.mjs');
export const HOOK_KEY = 'habblaud';
export const DEFAULT_PORT = 4747;
export const CONFIG_NAME = 'antigravity-hook.json';
export const FLAT_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'] as const;
export const GROUPED_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export const EVENTS = [...FLAT_EVENTS, ...GROUPED_EVENTS] as const;
export const OBSERVE_TIMEOUT_S = 5;

const USAGE = tr(
  'Uso: npm run antigravity:<install|uninstall|status> [-- opções]\n\n  install     acrescenta o hook do Habblaud em ~/.gemini/config/hooks.json (faz backup antes)\n  uninstall   tira o hook do Habblaud (os outros hooks ficam)\n  status      mostra se o hook está instalado e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --node <caminho> o Node {1}+ que roda os hooks\n  -h, --help       mostra esta ajuda',
  [DEFAULT_PORT, MIN_NODE_MAJOR],
);

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = rec(v);
  if (!r) return JSON.stringify(v) ?? 'null';
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
    .join(',')}}`;
}

/** Especificação do hook `"habblaud"` no formato de `~/.gemini/config/hooks.json` do Antigravity CLI. */
export function buildHabblaudHookSpec(command: string): Rec {
  const handler = { type: 'command', command, timeout: OBSERVE_TIMEOUT_S };
  const grouped = [{ matcher: '*', hooks: [handler] }];
  return {
    SessionStart: [handler],
    PreInvocation: [handler],
    PostInvocation: [handler],
    Stop: [handler],
    PreToolUse: grouped,
    PostToolUse: grouped,
  };
}

export type PlanAction =
  | { action: 'install'; file: Settings; message: string }
  | { action: 'uninstall'; file: Settings; message: string }
  | { action: 'none'; message: string };

export function planInstall(file: Settings, command: string): PlanAction {
  const expected = buildHabblaudHookSpec(command);
  const current = rec(file[HOOK_KEY]);
  if (current && canonical(current) === canonical(expected)) {
    return { action: 'none', message: tr('já instalado') };
  }
  const message = current ? tr('atualizado ({0} eventos)', [EVENTS.length]) : tr('instalado ({0} eventos)', [EVENTS.length]);
  return { action: 'install', file: { ...file, [HOOK_KEY]: expected }, message };
}

export function planUninstall(file: Settings): PlanAction {
  if (!(HOOK_KEY in file)) return { action: 'none', message: tr('não estava instalado') };
  const next: Settings = { ...file };
  delete next[HOOK_KEY];
  return { action: 'uninstall', file: next, message: tr('hooks do Habblaud removidos') };
}

export function hooksFilePath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.HABBLAUD_ANTIGRAVITY_HOOKS_FILE?.trim();
  if (custom) return resolve(custom);
  return join(home, '.gemini', 'config', 'hooks.json');
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  port: number;
  node?: string;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let node: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if (a === '--node') {
      node = argv[++i];
      if (!node || !isAbsolute(node)) throw new FatalError(tr('--node precisa do caminho absoluto de um Node 22+.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, port, ...(node ? { node } : {}) };
}

function writeHookConfig(home: string, port: number): boolean {
  const path = configPath(home);
  try {
    const cur = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown };
    if (cur?.port === port) return false;
  } catch {
    // grava
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ port }, null, 2)}\n`, 'utf8');
  return true;
}

function defaultNodeProbe(bin: string | undefined): string | undefined {
  try {
    if (bin) return execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 }).trim();
    const sh = process.env.SHELL || '/bin/sh';
    return execFileSync(sh, ['-lc', 'node --version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 }).trim();
  } catch {
    return undefined;
  }
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
  nodeProbe?: (bin: string | undefined) => string | undefined;
  nodeCandidates?: readonly string[];
}

export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const say = (msg = '') => ctx.out(msg ? `[antigravity] ${msg}` : '');
  const file = hooksFilePath(ctx.home, ctx.env);
  const dirs = discoverAntigravityDirs(ctx.env, ctx.home);
  const nodeChoice = opts.node
    ? { bin: opts.node, chosen: ctx.nodeProbe?.(opts.node) }
    : ctx.nodeProbe
      ? chooseNode(ctx.nodeProbe, ctx.nodeCandidates ?? ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath])
      : {};
  const cmd = hookCommand(ctx.hookPath, nodeChoice.bin);

  if (opts.command === 'status') {
    say(tr('Pastas do Antigravity CLI detectadas: {0}', [dirs.length ? dirs.map((d) => tildify(d, ctx.home)).join(', ') : tr('nenhuma')]));
    if (!existsSync(file)) {
      say(tr('{0}: arquivo ainda não existe (rode npm run antigravity:install).', [tildify(file, ctx.home)]));
      return 0;
    }
    const read = readSettings(file);
    if ('error' in read) {
      say(tr('{0}: ilegível ({1}).', [tildify(file, ctx.home), read.error]));
      return 1;
    }
    const installed = rec(read.settings[HOOK_KEY]);
    if (!installed) {
      say(tr('{0}: hook do Habblaud não instalado.', [tildify(file, ctx.home)]));
    } else if (canonical(installed) === canonical(buildHabblaudHookSpec(cmd))) {
      say(tr('{0}: instalado ({1} eventos).', [tildify(file, ctx.home), EVENTS.length]));
    } else {
      say(tr('{0}: instalado, mas desatualizado (rode npm run antigravity:install).', [tildify(file, ctx.home)]));
    }
    return 0;
  }

  const read = readSettings(file);
  if ('error' in read) {
    say(tr('{0}: JSON inválido ({1}); nada foi alterado.', [tildify(file, ctx.home), read.error]));
    return 1;
  }

  if (opts.command === 'install') {
    if (opts.node && ctx.nodeProbe && (nodeMajor(nodeChoice.chosen) ?? 0) < MIN_NODE_MAJOR) {
      throw new FatalError(tr('--node {0} não é um Node {1}+ ({2}).', [opts.node, MIN_NODE_MAJOR, nodeChoice.chosen ?? tr('não executou')]));
    }
    const plan = planInstall(read.settings, cmd);
    if (!opts.dryRun) writeHookConfig(ctx.home, opts.port);
    if (plan.action === 'none') {
      say(`${tildify(file, ctx.home)}: ${plan.message}.`);
      return 0;
    }
    if (opts.dryRun) {
      say(`${tildify(file, ctx.home)}: ${plan.message} (dry-run).`);
      return 0;
    }
    mkdirSync(dirname(file), { recursive: true });
    const backup = writeSettings(file, plan.file, read.raw, ctx.now);
    say(`${tildify(file, ctx.home)}: ${plan.message}${backup ? tr(' (backup em {0})', [tildify(backup, ctx.home)]) : ''}.`);
    return 0;
  }

  const plan = planUninstall(read.settings);
  if (plan.action === 'none') {
    say(`${tildify(file, ctx.home)}: ${plan.message}.`);
    return 0;
  }
  if (opts.dryRun) {
    say(`${tildify(file, ctx.home)}: ${plan.message} (dry-run).`);
    return 0;
  }
  const backup = writeSettings(file, plan.file, read.raw, ctx.now);
  say(`${tildify(file, ctx.home)}: ${plan.message}${backup ? tr(' (backup em {0})', [tildify(backup, ctx.home)]) : ''}.`);
  return 0;
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === 'help') {
      console.log(USAGE);
      return;
    }
    const code = await run(parsed, {
      env: process.env,
      home: process.env.HOME || homedir(),
      now: new Date(),
      hookPath: HOOK_SCRIPT,
      out: (line) => console.log(line),
      nodeProbe: defaultNodeProbe,
    });
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    if (err instanceof FatalError) {
      console.error(`[antigravity] ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
