#!/usr/bin/env node
// Hook PreToolUse do Habblaud para o Kiro CLI: deixa aprovar ou recusar pelo escritório os pedidos de permissão do
// Kiro (ferramentas que ele pediria para confirmar no terminal). É SEPARADO do hook que só observa
// (mod/habblaud-kiro/hook.mjs): este bloqueia a ferramenta quando você recusa.
//
// `npm run kiro:install --aprovar` copia este arquivo para ~/.habblaud/kiro-approval-hook.mjs, grava
// ~/.habblaud/kiro-hook.json com {approve:true, wait:<s>} e registra uma entrada PreToolUse com um timeout_ms grande
// (para o Kiro não matar a espera).
//
// Em qual mecanismo isto se apoia (conferido no executor de hooks do Kiro CLI 2.16.2 e do 3.2.0): o PreToolUse só
// sabe BLOQUEAR (exit 2) ou PEDIR confirmação ({permissionDecision:"ask"} no stdout); não existe `allow` por hook em
// nenhuma das duas versões. Por isso:
//   - exit 2  -> BLOQUEIA a ferramenta; o STDERR vira o motivo entregue ao modelo;
//   - exit 0 sem nada -> fluxo normal: ferramenta que o Kiro já confia roda direto; as outras ainda passam pelo
//     [y/n/t] do terminal.
// RECUSAR pelo escritório = exit 2 + motivo no stderr (funciona por inteiro). APROVAR pelo escritório = exit 0: para a
// aprovação do escritório ser a única, confie a ferramenta no Kiro (o escritório vira o porteiro). O instalador
// registra este hook SEM `|| true` (o código de saída e o stderr precisam chegar ao Kiro). Timeout do hook, erro ou
// Habblaud fora do ar: exit 0 sem nada.
//
// O hook:
// 1. só age se ~/.habblaud/kiro-hook.json tiver {approve:true} (opt-in) e se a ferramenta precisar de aprovação
//    (shell e escrita de arquivo; leitura/busca passam direto);
// 2. lê do stdin o JSON do PreToolUse (hook_event_name, session_id, cwd, tool_name, tool_input);
// 3. registra em POST /api/permissions (provider:"kiro"). Se o Habblaud não responder, recusar (sem página aberta
//    ou sessão desconhecida), sai na hora com exit 0;
// 4. espera a decisão em GET /api/permissions/:id/wait (laço de até 25 s) até o tempo limite;
// 5. recusado -> escreve o motivo no stderr e sai com 2; aprovado/terminal/tempo/erro -> exit 0 sem nada.
//
// Regras: Node puro (22+), só `node:*`; nunca escreve no stdout (vira contexto do modelo); só fala com 127.0.0.1.
// HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr (só com debug; fora disso, o stderr só sai na recusa).
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'kiro-hook.json';
export const DEFAULT_WAIT_S = 300;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 86_400;
/** Resposta mais longa de cada long-poll (o servidor responde "pending" e o hook pergunta de novo). */
const WAIT_S = 25;
/** Registrar o pedido: se o Habblaud não responder nisso, ele está fora do ar (ou travado). */
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 8_000;
const MAX_BODY = 200_000;
/** Ferramentas do Kiro que pedem aprovação (shell e escrita; 3.x: execute_bash/execute_pwsh, fs_write e str_replace); leitura/busca passam direto. */
export const APPROVAL_TOOLS = new Set(['shell', 'execute_bash', 'execute_cmd', 'execute_pwsh', 'bash', 'execute', 'fs_write', 'write', 'write_file', 'str_replace']);

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-kiro-approval] ${msg}\n`) : () => {};
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Config: ~/.habblaud/kiro-hook.json ({port, approve, wait}); porta também de HABBLAUD_PORT; padrão 4747 e aprovação desligada. */
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
  const waitRaw = Number(isObject(file) ? file.wait : NaN);
  const wait = Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, waitRaw)) : DEFAULT_WAIT_S;
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    approve: isObject(file) && file.approve === true,
    waitMs: wait * 1_000,
  };
}

/** A ferramenta deste evento precisa de aprovação? (shell e escrita; o resto passa direto.) */
export function needsApproval(toolName) {
  return typeof toolName === 'string' && APPROVAL_TOOLS.has(toolName);
}

/** Corta textos longos dos argumentos. */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/** Corpo mandado ao Habblaud: só o que ele usa (provider:"kiro"). */
export function requestBody(input, timeoutMs) {
  const body = { provider: 'kiro', session_id: typeof input.session_id === 'string' ? input.session_id : '', tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  if (typeof input.cwd === 'string') body.cwd = input.cwd;
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimInput(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

/**
 * O que o hook deve fazer com a resposta de uma espera: {deny:<motivo>} (exit 2 + stderr) ou undefined (exit 0, nada).
 * Só a recusa bloqueia; aprovar/terminal/released/pending viram undefined (o terminal decide).
 */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided' || result.behavior !== 'deny') return undefined;
  const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
  return { deny: reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.' };
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

/** Requisição ao Habblaud local; null = fora do ar, tempo esgotado ou resposta ilegível. */
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

/**
 * Decide o pedido (ou não). Devolve {deny:<motivo>} para bloquear, ou undefined para deixar o terminal decidir.
 * Nunca lança.
 */
export async function run(env = process.env, stdinText) {
  try {
    const cfg = readConfig(env);
    if (!cfg.approve) return undefined; // opt-in: sem {approve:true}, não age.
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isObject(input) || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && String(input.hook_event_name).toLowerCase() !== 'pretooluse') return undefined;
    if (!needsApproval(input.tool_name)) return undefined;

    const base = `http://127.0.0.1:${cfg.port}`;
    const deadline = Date.now() + cfg.waitMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, cfg.waitMs), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud fora do ar'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: vale o terminal');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      const status = r.json?.status;
      if (status === 'pending') continue;
      debug(`resposta: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json);
    }
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  // Rede de segurança: nada mantém o processo vivo além do tempo limite do hook (o Kiro já tem o timeout_ms dele).
  const { waitMs } = readConfig();
  setTimeout(() => process.exit(0), waitMs + 15_000).unref();
  const out = await run();
  // Recusa: motivo no stderr e exit 2 (bloqueia a ferramenta no Kiro 2.x). Resto: exit 0 sem nada.
  if (out?.deny) {
    // exitCode já em 2: se o loop esvaziar antes do timer, o processo ainda sai com 2 (no Windows, Node 23–24.19
    // cai com 0xC0000409 se chamarmos process.exit() logo depois do fetch, nodejs/node#56645).
    process.exitCode = 2;
    const finish = () => setTimeout(() => process.exit(2), 1_000).unref();
    process.stderr.write(out.deny, finish);
  } else {
    setTimeout(() => process.exit(0), 1_000).unref();
  }
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
