#!/usr/bin/env node
// Hook do Habblaud para o Kiro CLI: manda ao escritório, na hora, o que a sessão faz (AgentSpawn, UserPromptSubmit,
// PreToolUse, PostToolUse, Stop). `npm run kiro:install` (mod/habblaud-kiro/install.mjs) copia este arquivo para
// ~/.habblaud/kiro-hook.mjs e o registra:
//   - Kiro CLI 2.x: no campo `hooks` de cada agente em ~/.kiro/agents/*.json (camelCase: userPromptSubmit...);
//   - Kiro CLI 3.x: no arquivo ~/.kiro/hooks/habblaud.json (PascalCase: UserPromptSubmit...).
//
// O hook:
// 1. lê do stdin o JSON do evento (hook_event_name, session_id, cwd, prompt, tool_name, tool_input, tool_response,
//    assistant_response);
// 2. no Linux, acha os processos do Kiro acima dele (/proc): o servidor liga o evento à trava da sessão e sabe quando
//    o Kiro fecha;
// 3. manda o evento, com os textos cortados, para POST http://127.0.0.1:<porta>/api/kiro/events (prazo de 800 ms).
//
// Regras: Node puro (22+), só `node:*`; nunca escreve no stdout (no AgentSpawn e no UserPromptSubmit o stdout vira
// contexto do modelo) e sempre sai com 0. O PreToolUse do Kiro bloqueia a ferramenta se o hook falhar: o instalador
// ainda põe `|| true` (Linux/macOS) ou `& exit /b 0` (Windows) no comando, para o caso de o Node ou este arquivo
// sumirem. Só fala com 127.0.0.1. Porta: ~/.habblaud/kiro-hook.json ({port}) ou HABBLAUD_PORT; padrão 4747.
// HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'kiro-hook.json';
/** Nome canônico (3.x) de cada evento; o 2.x manda em camelCase. O 3.x chama o início da sessão de SessionStart. */
export const EVENTS = { agentspawn: 'AgentSpawn', sessionstart: 'AgentSpawn', userpromptsubmit: 'UserPromptSubmit', pretooluse: 'PreToolUse', posttooluse: 'PostToolUse', stop: 'Stop' };
/** O Kiro espera o hook terminar antes de seguir: o envio tem prazo curto. */
const EVENT_TIMEOUT_MS = 800;
const STDIN_TIMEOUT_MS = 2_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Prompt e argumentos das ferramentas (o servidor só mostra prévias). */
const MAX_STRING = 4_000;
/** Resultado da ferramenta: só o começo (o servidor só procura sinais de erro). */
const MAX_RESULT_STRING = 300;
const MAX_BODY = 200_000;
const KIRO_PROC = /kiro/i;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-kiro] ${msg}\n`) : () => {};
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Nome canônico do evento (AgentSpawn, UserPromptSubmit, PreToolUse, PostToolUse, Stop) ou undefined. */
export function eventName(raw) {
  return typeof raw === 'string' ? EVENTS[raw.toLowerCase()] : undefined;
}

/** Porta: ~/.habblaud/kiro-hook.json ({port}); senão HABBLAUD_PORT; senão 4747. */
export function readConfig(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const filePort = Number(isObject(file) ? file.port : NaN);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return { port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT };
}

/** Pasta do Kiro desta sessão: KIRO_HOME ou ~/.kiro. */
export function kiroHomeOf(env = process.env) {
  const custom = typeof env.KIRO_HOME === 'string' ? env.KIRO_HOME.trim() : '';
  return resolve(custom || join(env.HOME || env.USERPROFILE || homedir(), '.kiro'));
}

/**
 * Processos do Kiro acima do hook (Linux, pelo /proc): o 2.x roda kiro-cli > kiro-cli-chat > bun > kiro-cli-chat > hook,
 * e a trava da sessão guarda um deles. Fora do Linux (ou sem /proc): [].
 */
export function kiroPids(start = process.ppid, procRoot = '/proc', max = 8) {
  const out = [];
  let pid = start;
  for (let i = 0; i < max && Number.isInteger(pid) && pid > 1; i++) {
    let stat;
    try {
      stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    } catch {
      break;
    }
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    let exe = '';
    try {
      exe = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0')[0].split('/').pop() ?? '';
    } catch {
      // processo de outro usuário
    }
    if (KIRO_PROC.test(comm) || KIRO_PROC.test(exe)) out.push(pid);
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return out;
}

/** Corta textos longos (arquivo inteiro num write, saída de comando...). */
export function trimValue(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trimValue(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 100)) out[k] = trimValue(x, max, depth + 1);
  return out;
}

/** Corpo de POST /api/kiro/events: só os campos que o Habblaud usa, com os textos cortados. */
export function eventBody(input, ctx) {
  const event = { hook_event_name: eventName(input.hook_event_name), session_id: input.session_id };
  if (typeof input.cwd === 'string') event.cwd = input.cwd;
  if (typeof input.prompt === 'string') event.prompt = input.prompt.slice(0, MAX_STRING);
  if (typeof input.tool_name === 'string') event.tool_name = input.tool_name.slice(0, 200);
  if (input.tool_input !== undefined) event.tool_input = trimValue(input.tool_input);
  if (input.tool_response !== undefined) event.tool_response = trimValue(input.tool_response, MAX_RESULT_STRING);
  if (typeof input.assistant_response === 'string') event.assistant_response = input.assistant_response.slice(0, MAX_STRING);
  const body = { kiroHome: ctx.kiroHome, pids: ctx.pids, platform: ctx.platform, event };
  for (const max of [1_000, 200]) {
    if (JSON.stringify(body).length <= MAX_BODY) break;
    if (event.tool_input !== undefined) event.tool_input = trimValue(input.tool_input, max);
    if (event.prompt) event.prompt = event.prompt.slice(0, max);
  }
  return body;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Manda o evento. Devolve o status HTTP (null = Habblaud fora do ar, evento ignorado ou erro). Nunca lança. */
export async function run(env = process.env, stdinText, ctx = {}) {
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return null;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(input) || !eventName(input.hook_event_name) || typeof input.session_id !== 'string' || !input.session_id) return null;
    const { port } = readConfig(env);
    const platform = ctx.platform ?? process.platform;
    const body = eventBody(input, {
      kiroHome: ctx.kiroHome ?? kiroHomeOf(env),
      pids: ctx.pids ?? (platform === 'linux' ? kiroPids(process.ppid, ctx.procRoot) : []),
      platform,
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/kiro/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? EVENT_TIMEOUT_MS),
    });
    await res.text().catch(() => '');
    debug(`${body.event.hook_event_name}: ${res.status}`);
    return res.status;
  } catch (err) {
    debug(`erro: ${err?.name ?? ''} ${err?.message ?? err}`);
    return null;
  }
}

export async function main() {
  // Rede de segurança: nunca segura o Kiro além disso (o envio já tem prazo de 800 ms).
  setTimeout(() => process.exit(0), 2_500).unref();
  await run();
  // Sem process.exit() logo depois do fetch (no Windows, Node 23 até 24.19 cai com 0xC0000409, nodejs/node#56645):
  // o processo sai sozinho quando o loop esvazia.
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => {});
