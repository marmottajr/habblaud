#!/usr/bin/env node
// Hook do Habblaud para o Google Antigravity CLI (`agy`): mostra no escritório, em tempo real, o que as sessões e os
// subagentes do Antigravity estão fazendo. `npm run antigravity:install` acrescenta em ~/.gemini/config/hooks.json a
// entrada `"habblaud"` que roda:
//
//   node "/caminho/do/habblaud/mod/habblaud-antigravity/hook.mjs"
//
// O hook:
// 1. lê do stdin o JSON do evento em camelCase (`conversationId`, `hookEventName`, `cwd`, `workspacePaths`,
//    `transcriptPath`, `modelName`, `lastUserInput`, `agentName`, `parentConversationId`, `toolCall`...);
// 2. manda o evento, com textos cortados, para POST http://127.0.0.1:<porta>/api/antigravity/events (prazo curto), com
//    a conta (`basename` da pasta de dados do Antigravity) e o caminho dela (`antigravityHome`);
// 3. imprime `{}` no stdout (o contrato de hooks do Antigravity CLI espera um objeto JSON no stdout) e sai com 0.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'antigravity-hook.json';
export const OBSERVED = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
const EVENT_TIMEOUT_MS = 1_500;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 8_000;
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-antigravity] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

function expandHome(p, home) {
  const abs = resolve(p.trim().replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home));
  return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
  };
}

/**
 * Pasta de dados do Antigravity CLI da sessão: ANTIGRAVITY_CLI_HOME, se veio; senão a pasta acima de `brain/<id>` em
 * `transcriptPath` ou `artifactDirectoryPath`; senão `~/.gemini/antigravity-cli`.
 */
export function antigravityHomeOf(env, input) {
  const home = env.HOME || homedir();
  const fromEnv = typeof env.ANTIGRAVITY_CLI_HOME === 'string' ? env.ANTIGRAVITY_CLI_HOME.trim() : '';
  if (fromEnv) return expandHome(fromEnv, home);
  for (const raw of [input?.transcriptPath, input?.transcript_path, input?.artifactDirectoryPath]) {
    const t = typeof raw === 'string' ? raw : '';
    const m = /^(.+)[\\/]brain(?:[\\/]|$)/.exec(t);
    if (m && isAbsolute(m[1])) return expandHome(m[1], home);
  }
  return join(home, '.gemini', 'antigravity-cli');
}

export function accountOf(antigravityHome) {
  return basename(antigravityHome) || antigravityHome;
}

export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

export function eventBody(input, account, antigravityHome) {
  const body = { account, antigravityHome, event: input };
  body.event = fitted(input, (event) => JSON.stringify({ ...body, event }).length);
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

async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

export async function run(env = process.env, stdinText) {
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return {};
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return {};
    }
    const event = input?.hookEventName ?? input?.hook_event_name;
    const convId = input?.conversationId ?? input?.conversation_id;
    if (!isObject(input) || typeof event !== 'string' || typeof convId !== 'string' || !convId) return {};
    if (!OBSERVED.has(event)) return {};

    const cfg = readConfig(env);
    const antigravityHome = antigravityHomeOf(env, input);
    const account = accountOf(antigravityHome);
    const base = `http://127.0.0.1:${cfg.port}`;
    const sent = await call(base, 'POST', '/api/antigravity/events', eventBody(input, account, antigravityHome), EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `${sent.status} ${JSON.stringify(sent.json ?? null)}` : 'Habblaud fora do ar'}`);
    return {};
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return {};
  }
}

export async function main() {
  setTimeout(() => process.exit(0), 10_000).unref();
  const out = await run();
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  process.stdout.write(`${JSON.stringify(out ?? {})}\n`, finish);
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
