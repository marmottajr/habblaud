#!/usr/bin/env node
// Instala (ou remove) o hook do Habblaud no Kiro CLI. Node puro (roda igual no WSL/Linux, no macOS e no Windows, sem
// npm install):
//
//   node mod/habblaud-kiro/install.mjs install     (npm run kiro:install)
//   node mod/habblaud-kiro/install.mjs uninstall   (npm run kiro:uninstall)
//   node mod/habblaud-kiro/install.mjs status      (npm run kiro:status)
//   opções: --formato v2|v3, --agente a,b, --pasta <projeto>, --port <n>, --dry-run
//
// O que faz:
// - copia hook.mjs para ~/.habblaud/kiro-hook.mjs (caminho fixo, sem depender de onde o Habblaud está; no Windows não
//   precisa enxergar a pasta do WSL) e grava a porta em ~/.habblaud/kiro-hook.json;
// - Kiro CLI 2.x: acrescenta, no fim das listas de `hooks` de cada agente em <kiro>/agents/*.json, uma entrada por
//   evento (agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop), com backup do arquivo antes. Agentes do Kiro
//   Crew (kirocrew*, <time>--<agente>) ficam de fora: o Crew os regrava. O agente embutido (kiro_default) não tem
//   arquivo e não aceita hooks: use um agente seu como padrão (kiro-cli agent set-default <nome>);
// - Kiro CLI 3.x: grava <kiro>/hooks/habblaud.json (arquivo só do Habblaud; os seus hooks ficam como estão).
// <kiro> = KIRO_HOME ou ~/.kiro; com --pasta, <projeto>/.kiro (só as sessões abertas naquela pasta).
// Rodar de novo não duplica (as entradas do Habblaud são reconhecidas pelo caminho do kiro-hook.mjs no comando).
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOK_SOURCE = join(HERE, 'hook.mjs');
export const HOOK_NAME = 'kiro-hook.mjs';
export const CONFIG_NAME = 'kiro-hook.json';
export const V3_FILE = 'habblaud.json';
export const DEFAULT_PORT = 4747;
/** O Kiro espera o hook: 3 s de teto (o hook desiste do envio em 800 ms). */
export const TIMEOUT_MS = 3_000;
const OURS = /kiro-hook\.mjs/;
/** Eventos: nome no 2.x (campo do agente) -> nome no 3.x (trigger). */
export const EVENTS = [
  ['agentSpawn', 'AgentSpawn'],
  ['userPromptSubmit', 'UserPromptSubmit'],
  ['preToolUse', 'PreToolUse'],
  ['postToolUse', 'PostToolUse'],
  ['stop', 'Stop'],
];
const TOOL_EVENTS = new Set(['preToolUse', 'postToolUse']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ funções puras (server/test/kiro-hook.test.ts)

function shQuote(p) {
  return /^[\w./:=@%+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Comando do hook. Nunca deixa o Kiro ver um erro: no PreToolUse, hook que falha bloqueia a ferramenta.
 * Windows (cmd.exe): `node C:\...\kiro-hook.mjs 2>nul & exit /b 0` (aspas só no Node, e só com espaço no caminho).
 */
export function hookCommand(nodeBin, hookPath, platform = process.platform) {
  if (platform === 'win32') {
    const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
    return `${q(nodeBin)} ${q(hookPath)} 2>nul & exit /b 0`;
  }
  return `${shQuote(nodeBin)} ${shQuote(hookPath)} 2>/dev/null || true`;
}

export function isOurs(entry) {
  if (!isObject(entry)) return false;
  const cmd = typeof entry.command === 'string' ? entry.command : isObject(entry.action) ? entry.action.command : undefined;
  return typeof cmd === 'string' && OURS.test(cmd);
}

/** Agente regravado pelo Kiro Crew (ou arquivo que não é agente): fica de fora. */
export function isManagedAgent(file) {
  const name = basename(file);
  return !name.endsWith('.json') || /^kirocrew/i.test(name) || name.includes('--') || name.startsWith('.');
}

/** Entrada do Habblaud para um evento do 2.x. */
export function v2Entry(event, command) {
  return { ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}), command, timeout_ms: TIMEOUT_MS };
}

/** Agente com as entradas do Habblaud (troca as antigas no mesmo lugar; acrescenta no fim as que faltam). */
export function addV2(agent, command) {
  const hooks = isObject(agent.hooks) ? { ...agent.hooks } : {};
  for (const [event] of EVENTS) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const entry = v2Entry(event, command);
    const i = list.findIndex(isOurs);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    hooks[event] = list.filter((e, k) => !isOurs(e) || k === (i >= 0 ? i : list.length - 1));
  }
  const next = { ...agent, hooks };
  return { agent: next, changed: JSON.stringify(next) !== JSON.stringify(agent) };
}

/** Agente sem as entradas do Habblaud (listas que ficam vazias saem; `hooks` vazio sai). */
export function removeV2(agent) {
  if (!isObject(agent.hooks)) return { agent, changed: false };
  const hooks = {};
  for (const [k, v] of Object.entries(agent.hooks)) {
    if (!Array.isArray(v)) {
      hooks[k] = v;
      continue;
    }
    const kept = v.filter((e) => !isOurs(e));
    if (kept.length || !v.length) hooks[k] = kept;
  }
  const next = { ...agent };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { agent: next, changed: JSON.stringify(next) !== JSON.stringify(agent) };
}

export function hasV2(agent) {
  return isObject(agent.hooks) && EVENTS.every(([e]) => Array.isArray(agent.hooks[e]) && agent.hooks[e].some(isOurs));
}

/** Arquivo de hooks do 3.x (só do Habblaud). */
export function v3File(command) {
  return {
    version: 'v1',
    hooks: EVENTS.map(([v2, trigger]) => ({
      name: `habblaud-${v2}`,
      description: 'Habblaud: mostra a sessão no escritório (só observa, nunca bloqueia)',
      trigger,
      ...(TOOL_EVENTS.has(v2) ? { matcher: '*' } : {}),
      timeout_ms: TIMEOUT_MS,
      action: { type: 'command', command },
    })),
  };
}

/** Major do Kiro CLI em `kiro-cli --version` ("kiro-cli 2.16.2" -> 2). */
export function kiroMajor(out) {
  const m = /(\d+)\.\d+(?:\.\d+)?/.exec(out ?? '');
  return m ? Number(m[1]) : undefined;
}

export function parseArgs(argv) {
  const opts = { command: argv[0], dryRun: false, agents: undefined, format: undefined, dir: undefined, port: undefined };
  if (!['install', 'uninstall', 'status'].includes(opts.command)) return 'help';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`faltou o valor de ${a}`);
      return v;
    };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--formato' || a === '--format') {
      opts.format = val();
      if (!['v2', 'v3'].includes(opts.format)) throw new Error('--formato aceita v2 (Kiro CLI 2.x) ou v3 (Kiro CLI 3.x)');
    } else if (a === '--agente' || a === '--agent') opts.agents = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--pasta' || a === '--dir') opts.dir = resolve(val());
    else if (a === '--port') {
      opts.port = Number(val());
      if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port >= 65_536) throw new Error('--port inválida');
    } else if (a === '-h' || a === '--help') return 'help';
    else throw new Error(`opção desconhecida: ${a}`);
  }
  return opts;
}

// ------------------------------------------------------------------ arquivos

function readJson(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const v = JSON.parse(raw);
    return isObject(v) ? { value: v, raw } : { error: 'não é um objeto JSON' };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'não existe' : `JSON inválido (${err.message})` };
  }
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Backup + gravação atômica (sem BOM). Devolve o backup. */
function writeJson(file, value, raw, now) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: raw === undefined ? 0o644 : statSync(file).mode & 0o777 });
  let backup;
  if (raw !== undefined) {
    if (readFileSync(file, 'utf8').replace(/^\uFEFF/, '') !== raw) {
      unlinkSync(tmp);
      throw new Error('o arquivo mudou desde a leitura; rode de novo');
    }
    backup = `${file}.habblaud-backup-${stamp(now)}`;
    copyFileSync(file, backup);
  }
  renameSync(tmp, file);
  return backup;
}

function detectFormat() {
  const bins = process.platform === 'win32' ? [join(process.env.LOCALAPPDATA ?? '', 'Kiro-Cli', 'kiro-cli.exe'), 'kiro-cli.exe'] : ['kiro-cli', join(homedir(), '.local', 'bin', 'kiro-cli')];
  for (const bin of bins) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const major = kiroMajor(out);
      if (major) return { format: major >= 3 ? 'v3' : 'v2', version: out.trim() };
    } catch {
      // próximo
    }
  }
  return undefined;
}

/** Node dos hooks: no Windows, o `node` do PATH (sem aspas no cmd.exe) se for 22+; senão este Node, com caminho. */
function chooseNode() {
  if (process.platform === 'win32') {
    try {
      const v = execSync('node --version', { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      if (Number(/^v(\d+)/.exec(v.trim())?.[1] ?? 0) >= 22) return 'node';
    } catch {
      // usa o caminho
    }
  }
  return process.execPath;
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ comando

export async function run(opts, ctx = {}) {
  const out = ctx.out ?? ((l) => console.log(l));
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? (env.HOME || env.USERPROFILE || homedir());
  const now = ctx.now ?? new Date();
  const habblaudDir = join(home, '.habblaud');
  const hookPath = join(habblaudDir, HOOK_NAME);
  const kiroBase = opts.dir ? join(opts.dir, '.kiro') : resolve(env.KIRO_HOME?.trim() || join(home, '.kiro'));
  const detected = opts.format ? undefined : (ctx.detectFormat ?? detectFormat)();
  const format = opts.format ?? detected?.format;
  const tag = opts.dryRun ? ' (simulação: nada gravado)' : '';
  let failures = 0;

  out(`Kiro: ${kiroBase}${detected ? ` · ${detected.version}` : ''}${format ? ` · formato ${format}` : ''}`);
  if (!format && opts.command !== 'status') {
    out('✗ não achei o kiro-cli para saber a versão: rode de novo com --formato v2 (Kiro CLI 2.x) ou --formato v3 (3.x)');
    return 1;
  }

  const command = hookCommand(ctx.nodeBin ?? chooseNode(), hookPath, ctx.platform ?? process.platform);
  const port = opts.port ?? (Number.parseInt(env.HABBLAUD_PORT ?? '', 10) || DEFAULT_PORT);

  if (opts.command === 'install') {
    if (!opts.dryRun) {
      mkdirSync(habblaudDir, { recursive: true });
      copyFileSync(ctx.hookSource ?? HOOK_SOURCE, hookPath);
      writeFileSync(join(habblaudDir, CONFIG_NAME), `${JSON.stringify({ port }, null, 2)}\n`);
    }
    out(`✓ hook em ${hookPath} (porta ${port})${tag}`);
    out(`  comando: ${command}`);
  }

  // 2.x: agentes. Na desinstalação e no status, todos (tira o Habblaud de onde estiver).
  const agentsDir = join(kiroBase, 'agents');
  const files = existsSync(agentsDir) ? readdirSync(agentsDir).map((f) => join(agentsDir, f)).filter((f) => f.endsWith('.json')) : [];
  const wanted = (f) => !isManagedAgent(f) && (!opts.agents || opts.agents.includes(basename(f, '.json')));
  if (opts.command === 'install' && format === 'v2') {
    const targets = files.filter(wanted);
    if (!targets.length) {
      out(`! nenhum agente em ${agentsDir}${opts.agents ? ` com o nome ${opts.agents.join(', ')}` : ''}: crie um (kiro-cli agent create) e rode de novo`);
      failures++;
    }
    for (const f of targets) {
      const r = readJson(f);
      if (r.error) {
        out(`✗ ${basename(f)}: ${r.error}; não mexi`);
        failures++;
        continue;
      }
      const { agent, changed } = addV2(r.value, command);
      if (!changed) out(`= ${basename(f)}: já tem o hook`);
      else if (opts.dryRun) out(`~ ${basename(f)}: entraria o hook${tag}`);
      else {
        try {
          const b = writeJson(f, agent, r.raw, now);
          out(`✓ ${basename(f)}: hook acrescentado · backup ${basename(b)}`);
        } catch (err) {
          out(`✗ ${basename(f)}: ${err.message}`);
          failures++;
        }
      }
    }
  }
  if (opts.command === 'uninstall') {
    for (const f of files) {
      const r = readJson(f);
      if (r.error) continue;
      const { agent, changed } = removeV2(r.value);
      if (!changed) continue;
      if (opts.dryRun) out(`~ ${basename(f)}: sairia o hook${tag}`);
      else {
        try {
          const b = writeJson(f, agent, r.raw, now);
          out(`✓ ${basename(f)}: hook removido · backup ${basename(b)}`);
        } catch (err) {
          out(`✗ ${basename(f)}: ${err.message}`);
          failures++;
        }
      }
    }
  }

  // 3.x: arquivo próprio.
  const v3 = join(kiroBase, 'hooks', V3_FILE);
  if (opts.command === 'install' && format === 'v3') {
    const cur = readJson(v3);
    const next = v3File(command);
    if (!cur.error && !cur.value.hooks?.some?.(isOurs)) {
      out(`✗ ${v3} existe e não é do Habblaud; não mexi`);
      failures++;
    } else if (!cur.error && JSON.stringify(cur.value) === JSON.stringify(next)) out(`= ${v3}: já está lá`);
    else if (opts.dryRun) out(`~ ${v3}: seria gravado${tag}`);
    else {
      writeJson(v3, next, undefined, now);
      out(`✓ ${v3}: gravado`);
    }
  }
  if (opts.command === 'uninstall' && existsSync(v3)) {
    const cur = readJson(v3);
    if (!cur.error && cur.value.hooks?.some?.(isOurs)) {
      if (!opts.dryRun) unlinkSync(v3);
      out(`✓ ${v3}: removido${tag}`);
    }
  }

  if (opts.command === 'status') {
    const withHook = files.filter((f) => {
      const r = readJson(f);
      return !r.error && hasV2(r.value);
    });
    out(`Agentes com o hook (2.x): ${withHook.length ? withHook.map((f) => basename(f, '.json')).join(', ') : 'nenhum'}`);
    const v3cur = readJson(v3);
    out(`Arquivo 3.x (${v3}): ${!v3cur.error && v3cur.value.hooks?.some?.(isOurs) ? 'instalado' : 'não'}`);
    if (existsSync(hookPath)) {
      const same = existsSync(ctx.hookSource ?? HOOK_SOURCE) && readFileSync(hookPath, 'utf8') === readFileSync(ctx.hookSource ?? HOOK_SOURCE, 'utf8');
      out(`Hook: ${hookPath}${same ? '' : ' (desatualizado: rode kiro:install de novo)'}`);
    } else out('Hook: não instalado');
    const cfg = readJson(join(habblaudDir, CONFIG_NAME));
    const p = !cfg.error && Number.isInteger(cfg.value.port) ? cfg.value.port : port;
    const h = await (ctx.health ?? health)(p);
    out(`Habblaud em http://127.0.0.1:${p}: ${!h ? 'fora do ar (o hook sai na hora e o Kiro segue normal)' : h.kiroEvents ? 'recebendo os eventos do Kiro' : 'no ar, mas sem a fonte do Kiro'}`);
  }

  if (opts.command === 'install' && !opts.dryRun && !failures) {
    out('');
    out('Pronto. Abra uma sessão NOVA do Kiro (as abertas não releem os hooks).');
    out(`Para desfazer: node "${join(HERE, 'install.mjs')}" uninstall${opts.dir ? ` --pasta "${opts.dir}"` : ''}`);
  }
  return failures ? 1 : 0;
}

const USAGE = `Uso: node mod/habblaud-kiro/install.mjs <install|uninstall|status> [opções]

  install     copia o hook para ~/.habblaud e o registra no Kiro CLI (2.x: nos agentes; 3.x: em hooks/habblaud.json)
  uninstall   tira o hook do Habblaud dos agentes e apaga hooks/habblaud.json (os seus hooks ficam)
  status      mostra onde o hook está e se o Habblaud está recebendo

Opções:
  --formato v2|v3   Kiro CLI 2.x (hooks nos agentes) ou 3.x (arquivo de hooks); padrão: pela versão do kiro-cli
  --agente a,b      só estes agentes (2.x); padrão: todos os seus em <kiro>/agents, menos os do Kiro Crew
  --pasta <dir>     instala em <dir>/.kiro (só as sessões abertas nessa pasta), em vez de KIRO_HOME ou ~/.kiro
  --port <n>        porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  --dry-run         mostra o que mudaria, sem gravar nada`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[kiro] ${err.message}`);
    process.exitCode = 2;
    return;
  }
  if (opts === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = await run(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`[kiro] Erro: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
