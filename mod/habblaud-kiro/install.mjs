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
import { LEDGER_FILE, withoutRules } from './approval-hook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOK_SOURCE = join(HERE, 'hook.mjs');
export const HOOK_NAME = 'kiro-hook.mjs';
export const APPROVAL_HOOK_SOURCE = join(HERE, 'approval-hook.mjs');
export const APPROVAL_HOOK_NAME = 'kiro-approval-hook.mjs';
export const CONFIG_NAME = 'kiro-hook.json';
export const V3_FILE = 'habblaud.json';
export const DEFAULT_PORT = 4747;
/** O Kiro espera o hook: 3 s de teto (o hook desiste do envio em 800 ms). */
export const TIMEOUT_MS = 3_000;
/** O hook de aprovação faz long-poll: teto grande para o Kiro não matar a espera (margem acima do `wait` do hook). */
export const APPROVAL_TIMEOUT_MS = 310_000;
export const DEFAULT_WAIT_S = 300;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 86_400;
const OURS = /[/\\]kiro-hook\.mjs/;
const APPROVAL_OURS = /[/\\]kiro-approval-hook\.mjs/;
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
export function hookCommand(nodeBin, hookPath, platform = process.platform, opts = {}) {
  // `strict` (hook de aprovação): o código de saída e o stderr chegam ao Kiro como estão. Recusar É o `exit 2` + o motivo
  // no stderr; com `|| true` / `exit /b 0` o Kiro nunca veria a recusa. Só o `exit 2` bloqueia (qualquer outro código,
  // inclusive node/arquivo sumido, é falha silenciosa que não bloqueia: conferido no executor de hooks do 2.16 e do 3.2).
  if (platform === 'win32') {
    const q = (p) => (/\s/.test(p) ? `"${p}"` : p);
    return opts.strict ? `${q(nodeBin)} ${q(hookPath)}` : `${q(nodeBin)} ${q(hookPath)} 2>nul & exit /b 0`;
  }
  return opts.strict ? `${shQuote(nodeBin)} ${shQuote(hookPath)}` : `${shQuote(nodeBin)} ${shQuote(hookPath)} 2>/dev/null || true`;
}

export function isOurs(entry) {
  if (!isObject(entry)) return false;
  const cmd = typeof entry.command === 'string' ? entry.command : isObject(entry.action) ? entry.action.command : undefined;
  return typeof cmd === 'string' && OURS.test(cmd);
}

/** Entrada do hook de APROVAÇÃO (kiro-approval-hook.mjs), que é separada da de observar (kiro-hook.mjs). */
export function isApproval(entry) {
  if (!isObject(entry)) return false;
  const cmd = typeof entry.command === 'string' ? entry.command : isObject(entry.action) ? entry.action.command : undefined;
  return typeof cmd === 'string' && APPROVAL_OURS.test(cmd);
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

/** Entrada do hook de aprovação (só no preToolUse, com teto grande para a espera não ser morta). */
export function approvalEntry(command, waitS = DEFAULT_WAIT_S) {
  return { matcher: '*', command, timeout_ms: approvalTimeoutMs(waitS) };
}

/**
 * Teto do Kiro para o hook de aprovação: acima da espera configurada (`--espera`), com folga para gravar a regra "não
 * perguntar de novo". Com o teto fixo de 310 s, uma espera maior era morta pelo Kiro no meio (e o cartão ficava órfão).
 */
export function approvalTimeoutMs(waitS = DEFAULT_WAIT_S) {
  const w = Number.isFinite(waitS) ? waitS : DEFAULT_WAIT_S;
  return Math.max(APPROVAL_TIMEOUT_MS, Math.ceil(w) * 1_000 + 10_000);
}

/**
 * Agente com as entradas do Habblaud (troca as antigas no mesmo lugar; acrescenta no fim as que faltam). Com
 * `approvalCommand`, acrescenta/mantém a entrada de aprovação no preToolUse; sem ele, tira a de aprovação.
 */
export function addV2(agent, command, approvalCommand, waitS = DEFAULT_WAIT_S) {
  const hooks = isObject(agent.hooks) ? { ...agent.hooks } : {};
  for (const [event] of EVENTS) {
    let list = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const entry = v2Entry(event, command);
    const i = list.findIndex(isOurs);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    list = list.filter((e, k) => !isOurs(e) || k === (i >= 0 ? i : list.indexOf(entry)));
    if (event === 'preToolUse') {
      list = list.filter((e) => !isApproval(e));
      if (approvalCommand) list.push(approvalEntry(approvalCommand, waitS));
    }
    hooks[event] = list;
  }
  const next = { ...agent, hooks };
  return { agent: next, changed: JSON.stringify(next) !== JSON.stringify(agent) };
}

/** Agente sem as entradas do Habblaud (observar e aprovar; listas que ficam vazias saem; `hooks` vazio sai). */
export function removeV2(agent) {
  // Agente migrado para o 3.x (`/upgrade-agent`): `hooks` é uma lista de {name, trigger, action:{command}}.
  if (Array.isArray(agent.hooks)) {
    const kept = agent.hooks.filter((e) => !isOurs(e) && !isApproval(e));
    if (kept.length === agent.hooks.length) return { agent, changed: false };
    const next = { ...agent };
    if (kept.length) next.hooks = kept;
    else delete next.hooks;
    return { agent: next, changed: true };
  }
  if (!isObject(agent.hooks)) return { agent, changed: false };
  const hooks = {};
  for (const [k, v] of Object.entries(agent.hooks)) {
    if (!Array.isArray(v)) {
      hooks[k] = v;
      continue;
    }
    const kept = v.filter((e) => !isOurs(e) && !isApproval(e));
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

/** Agente (2.x ou já migrado para o 3.x) com alguma entrada do Habblaud. */
export function hasAnyHabblaud(agent) {
  if (Array.isArray(agent.hooks)) return agent.hooks.some((e) => isOurs(e) || isApproval(e));
  return isObject(agent.hooks) && Object.values(agent.hooks).some((v) => Array.isArray(v) && v.some((e) => isOurs(e) || isApproval(e)));
}

/** O agente tem a entrada de aprovação (no preToolUse). */
export function hasApprovalV2(agent) {
  return isObject(agent.hooks) && Array.isArray(agent.hooks.preToolUse) && agent.hooks.preToolUse.some(isApproval);
}

/** Ferramentas do Kiro que o hook de aprovação trata (regex do `matcher` do 3.x: `*` sozinho é regex inválida e o 3.x descarta o hook). */
export const APPROVAL_MATCHER = '^(execute_bash|execute_pwsh|shell|fs_write|str_replace|write)$';

/**
 * Entradas de hook no formato do 3.x (arquivo hooks/habblaud.json e agentes já migrados, onde `hooks` é uma lista):
 * gatilhos em PascalCase (AgentSpawn é SessionStart no 3.x), `timeout` em SEGUNDOS (o 3.x ignora `timeout_ms`; sem
 * ele valem 60 s e a espera da aprovação morreria) e sem `matcher` quando é para todas as ferramentas.
 */
export function v3Entries(command, approvalCommand, waitS = DEFAULT_WAIT_S) {
  const hooks = EVENTS.map(([v2, trigger]) => ({
    name: `habblaud-${v2}`,
    description: 'Habblaud: mostra a sessão no escritório (só observa, nunca bloqueia)',
    trigger: trigger === 'AgentSpawn' ? 'SessionStart' : trigger,
    timeout: Math.ceil(TIMEOUT_MS / 1_000),
    action: { type: 'command', command },
  }));
  if (approvalCommand) {
    hooks.push({
      name: 'habblaud-approval',
      description: 'Habblaud: aprovar/recusar permissões pelo escritório (recusar bloqueia a ferramenta)',
      trigger: 'PreToolUse',
      matcher: APPROVAL_MATCHER,
      timeout: Math.ceil(approvalTimeoutMs(waitS) / 1_000),
      action: { type: 'command', command: approvalCommand },
    });
  }
  return hooks;
}

/** Arquivo de hooks do 3.x (só do Habblaud). Com `approvalCommand`, acrescenta o hook de aprovação (PreToolUse). */
export function v3File(command, approvalCommand, waitS = DEFAULT_WAIT_S) {
  return { version: 'v1', hooks: v3Entries(command, approvalCommand, waitS) };
}

/** Major do Kiro CLI em `kiro-cli --version` ("kiro-cli 2.16.2" -> 2). */
export function kiroMajor(out) {
  const m = /(\d+)\.\d+(?:\.\d+)?/.exec(out ?? '');
  return m ? Number(m[1]) : undefined;
}

export function parseArgs(argv) {
  const opts = { command: argv[0], dryRun: false, agents: undefined, format: undefined, dir: undefined, port: undefined, approve: false, waitS: undefined };
  if (!['install', 'uninstall', 'status'].includes(opts.command)) return 'help';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`faltou o valor de ${a}`);
      return v;
    };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--aprovar' || a === '--approve') opts.approve = true;
    else if (a === '--espera' || a === '--wait') {
      opts.waitS = Number(val());
      if (!Number.isFinite(opts.waitS) || opts.waitS < MIN_WAIT_S || opts.waitS > MAX_WAIT_S) throw new Error(`--espera aceita de ${MIN_WAIT_S} a ${MAX_WAIT_S} segundos`);
    } else if (a === '--formato' || a === '--format') {
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
  const approvalPath = join(habblaudDir, APPROVAL_HOOK_NAME);
  const approve = opts.approve === true;
  const approvalCommand = approve ? hookCommand(ctx.nodeBin ?? chooseNode(), approvalPath, ctx.platform ?? process.platform, { strict: true }) : undefined;
  const port = opts.port ?? (Number.parseInt(env.HABBLAUD_PORT ?? '', 10) || DEFAULT_PORT);
  const waitS = opts.waitS ?? DEFAULT_WAIT_S;

  if (opts.command === 'install') {
    if (!opts.dryRun) {
      mkdirSync(habblaudDir, { recursive: true });
      copyFileSync(ctx.hookSource ?? HOOK_SOURCE, hookPath);
      if (approve) copyFileSync(ctx.approvalSource ?? APPROVAL_HOOK_SOURCE, approvalPath);
      writeFileSync(join(habblaudDir, CONFIG_NAME), `${JSON.stringify({ port, approve, wait: waitS }, null, 2)}\n`);
    }
    out(`✓ hook em ${hookPath} (porta ${port})${tag}`);
    out(`  comando: ${command}`);
    if (approve) {
      out(`✓ aprovação pelo escritório LIGADA · hook em ${approvalPath} · espera ${waitS}s${tag}`);
      out(`  comando: ${approvalCommand}`);
      out('  recusar pelo escritório bloqueia a ferramenta; aprovar libera o prompt do terminal;');
      out('  "não perguntar de novo" grava uma regra allow em <kiro>/settings/permissions.yaml|json (o uninstall tira).');
    } else out('  aprovação pelo escritório: desligada (use --aprovar para ligar)');
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
      const { agent, changed } = addV2(r.value, command, approvalCommand, waitS);
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
  if (opts.command === 'uninstall' || (opts.command === 'install' && format === 'v3')) {
    // 3.x: o arquivo hooks/habblaud.json vale para todos os agentes; as entradas antigas nos agentes (2.x ou migradas
    // pelo /upgrade-agent) fariam cada evento rodar duas vezes (e dois cartões de aprovação): saem.
    for (const f of files) {
      if (opts.command === 'install' && isManagedAgent(f)) continue;
      const r = readJson(f);
      if (r.error) continue;
      const { agent, changed } = removeV2(r.value);
      if (!changed) continue;
      if (opts.dryRun) out(`~ ${basename(f)}: sairia o hook${opts.command === 'install' ? ' (fica só o hooks/habblaud.json)' : ''}${tag}`);
      else {
        try {
          const b = writeJson(f, agent, r.raw, now);
          out(`✓ ${basename(f)}: hook removido${opts.command === 'install' ? ' (fica só o hooks/habblaud.json)' : ''} · backup ${basename(b)}`);
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
    const next = v3File(command, approvalCommand, waitS);
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

  // Apaga o hook de aprovação copiado (o de observar fica: ele é o kiro-hook.mjs).
  if (opts.command === 'uninstall' && existsSync(approvalPath)) {
    if (!opts.dryRun) unlinkSync(approvalPath);
    out(`✓ ${approvalPath}: removido${tag}`);
  }

  // Regras "não perguntar de novo" que o hook de aprovação gravou no Kiro (anotadas em ~/.habblaud/kiro-rules.json).
  const ledgerPath = join(habblaudDir, LEDGER_FILE);
  if (opts.command === 'uninstall' && existsSync(ledgerPath)) {
    const ledger = readJson(ledgerPath);
    const entries = !ledger.error && Array.isArray(ledger.value.rules) ? ledger.value.rules.filter((e) => isObject(e) && typeof e.file === 'string' && isObject(e.rule)) : [];
    const byFile = new Map();
    for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.rule]);
    let left = false;
    for (const [file, rules] of byFile) {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const { text, removed } = withoutRules(file, raw, rules);
      if (removed < rules.length) {
        left = true;
        out(`! ${file}: ${rules.length - removed} regra(s) do Habblaud não achada(s) do jeito que foram gravadas (o Kiro pode ter juntado a outra); confira à mão`);
      }
      if (!removed) continue;
      if (opts.dryRun) out(`~ ${file}: sairiam ${removed} regra(s) do Habblaud${tag}`);
      else {
        try {
          const backup = `${file}.habblaud-backup-${stamp(now)}`;
          copyFileSync(file, backup);
          const tmp = `${file}.habblaud-tmp-${process.pid}`;
          writeFileSync(tmp, text, { mode: statSync(file).mode & 0o777 });
          renameSync(tmp, file);
          out(`✓ ${file}: ${removed} regra(s) do Habblaud removida(s) · backup ${basename(backup)}`);
        } catch (err) {
          out(`✗ ${file}: ${err.message}`);
          failures++;
          left = true;
        }
      }
    }
    if (!opts.dryRun && !left) unlinkSync(ledgerPath);
  }

  if (opts.command === 'status') {
    const withHook = files.filter((f) => {
      const r = readJson(f);
      return !r.error && hasAnyHabblaud(r.value);
    });
    out(`Agentes com o hook: ${withHook.length ? withHook.map((f) => basename(f, '.json')).join(', ') : 'nenhum'}${format === 'v3' && withHook.length ? ' (no 3.x isto duplica o hooks/habblaud.json: rode kiro:install de novo)' : ''}`);
    const withApproval = files.filter((f) => {
      const r = readJson(f);
      return !r.error && hasApprovalV2(r.value);
    });
    const v3cur = readJson(v3);
    out(`Arquivo 3.x (${v3}): ${!v3cur.error && v3cur.value.hooks?.some?.(isOurs) ? 'instalado' : 'não'}`);
    const cfg = readJson(join(habblaudDir, CONFIG_NAME));
    const approveOn = (!cfg.error && cfg.value.approve === true) || withApproval.length > 0 || (!v3cur.error && v3cur.value.hooks?.some?.(isApproval));
    const w = !cfg.error && Number.isInteger(cfg.value.wait) ? cfg.value.wait : DEFAULT_WAIT_S;
    out(`Aprovação pelo escritório: ${approveOn ? `ligada (espera ${w}s)` : 'desligada'}${withApproval.length ? ` · agentes (2.x): ${withApproval.map((f) => basename(f, '.json')).join(', ')}` : ''}`);
    if (existsSync(hookPath)) {
      const same = existsSync(ctx.hookSource ?? HOOK_SOURCE) && readFileSync(hookPath, 'utf8') === readFileSync(ctx.hookSource ?? HOOK_SOURCE, 'utf8');
      out(`Hook: ${hookPath}${same ? '' : ' (desatualizado: rode kiro:install de novo)'}`);
    } else out('Hook: não instalado');
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
  uninstall   tira o hook do Habblaud dos agentes, apaga hooks/habblaud.json (os seus hooks ficam) e tira as regras
              "não perguntar de novo" que o escritório gravou em <kiro>/settings/permissions.yaml|json
  status      mostra onde o hook está e se o Habblaud está recebendo

Opções:
  --aprovar         liga aprovar/recusar permissões pelo escritório (recusar bloqueia a ferramenta); padrão: desligado
  --espera <s>      quanto o hook de aprovação espera a resposta (de ${MIN_WAIT_S} a ${MAX_WAIT_S}s; padrão ${DEFAULT_WAIT_S})
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
