#!/usr/bin/env node
// Hook do Habblaud para o Gemini CLI: mostra no escritório o que as sessões do Gemini fazem. `npm run gemini:install`
// acrescenta em ~/.gemini/settings.json (seção "hooks"), em cada evento observado, um grupo que roda:
//
//   "<node>" "/caminho/do/habblaud/mod/habblaud-gemini/hook.mjs"
//
// O hook:
// 1. lê do stdin o JSON do evento (session_id, hook_event_name, cwd, tool_name, tool_input...);
// 2. manda o evento, com os textos cortados, para POST http://127.0.0.1:<porta>/api/gemini/events (prazo curto);
// 3. imprime `{}` (o Gemini exige JSON no stdout) e sai com 0: nunca bloqueia nem altera nada na sessão.
//
// Porta: ~/.habblaud/gemini-hook.json ({port}, gravado pelo instalador); senão HABBLAUD_PORT; senão 4747.
// Regras: Node puro (22+), só `node:*`; todo erro = sair com 0 imprimindo `{}`. Só fala com 127.0.0.1.
// HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'gemini-hook.json';
const EVENT_TIMEOUT_MS = 1_500;
const SESSION_END_TIMEOUT_MS = 600;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 4_000;
const MAX_BODY = 200_000;
/** Campos grandes que o escritório não usa (pedido e resposta do modelo, saída inteira da ferramenta). */
const DROP = new Set(['llm_request', 'llm_response', 'prompt_response']);

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-gemini] ${msg}\n`) : () => {};
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

export function readPort(env = process.env) {
  try {
    const file = JSON.parse(readFileSync(join(homedir(), '.habblaud', CONFIG_FILE), 'utf8'));
    if (isObject(file) && validPort(file.port)) return file.port;
  } catch {
    // sem arquivo: segue
  }
  const p = Number(env.HABBLAUD_PORT);
  return validPort(p) ? p : DEFAULT_PORT;
}

/** Corta textos e profundidade (o servidor só mostra prévias). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => trimInput(x, max, depth + 1));
  if (isObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (depth === 0 && DROP.has(k)) continue;
      out[k] = trimInput(x, max, depth + 1);
    }
    return out;
  }
  return v;
}

export function eventBody(input) {
  let event = trimInput(input);
  // A resposta da ferramenta só interessa pelo erro.
  if (isObject(event.tool_response)) {
    const err = event.tool_response.error;
    event.tool_response = err ? { error: trimInput(err, 500) } : {};
  }
  let body = JSON.stringify({ account: '.gemini', event });
  for (const max of [1_000, 200]) {
    if (body.length <= MAX_BODY) break;
    event = trimInput(input, max);
    delete event.tool_response;
    body = JSON.stringify({ account: '.gemini', event });
  }
  return body;
}

function readStdin() {
  return new Promise((resolveP) => {
    const chunks = [];
    let size = 0;
    const done = () => resolveP(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export async function run(env = process.env, stdinText) {
  const text = stdinText ?? (await readStdin());
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    debug('stdin não é JSON');
    return;
  }
  if (!isObject(input) || typeof input.hook_event_name !== 'string') return;
  const port = readPort(env);
  const timeout = input.hook_event_name === 'SessionEnd' ? SESSION_END_TIMEOUT_MS : EVENT_TIMEOUT_MS;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/gemini/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody(input),
      signal: AbortSignal.timeout(timeout),
    });
    debug(`${input.hook_event_name}: HTTP ${res.status}`);
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    debug(`${input.hook_event_name}: Habblaud fora do ar (${err?.message ?? err})`);
  }
}

export async function main() {
  try {
    await run();
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
  }
  process.stdout.write('{}\n');
  process.exitCode = 0;
}

function isMain() {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isMain()) void main();
