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
// "Aprovar e não perguntar de novo" (a ferramenta inteira ou, no shell, os comandos que começam com um prefixo): o
// hook grava uma regra `allow` no arquivo de permissões do USUÁRIO do Kiro (<kiro>/settings/permissions.yaml ou
// .json, o mesmo em que o "Always allow" do Kiro grava; formato {rules:[{capability, effect, match?}]}), com backup,
// trava compatível com a do Kiro (<arquivo>.lock) e gravação atômica, e espera um pouco antes de sair: o Kiro vigia
// esse arquivo (releitura ~300 ms depois da mudança) e o PreToolUse roda ANTES da avaliação de permissão da
// ferramenta, então a chamada atual em geral já passa sem o [y/n/t] (se o Kiro ainda não tiver relido, ele pergunta
// esta última vez). Conferido no acp-server.js do Kiro CLI 3.2.0 e 2.16.2 (addRuleToFile, PolicySession.startWatching,
// buildPreToolUseGate). Quem sugere a regra é este hook (o servidor só mostra e devolve a posição escolhida); regras
// gravadas ficam anotadas em ~/.habblaud/kiro-rules.json, para o `kiro:uninstall` tirá-las.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

// ------------------------------------------------------------------ "não perguntar de novo" (regras do Kiro)

const SHELL_TOOLS = new Set(['shell', 'execute_bash', 'execute_cmd', 'execute_pwsh', 'bash', 'execute']);
/** Arquivo onde o hook anota as regras que gravou (o kiro:uninstall as tira). */
export const LEDGER_FILE = 'kiro-rules.json';
/** Espera depois de gravar a regra: o Kiro relê o arquivo ~300 ms depois da mudança (debounce do ConfigFileWatcher). */
export const RELOAD_WAIT_MS = 1_200;
const LOCK_TRIES = 20;
const LOCK_STEP_MS = 100;
/**
 * Comandos que nunca viram prefixo "não perguntar de novo": rodam qualquer outro comando (sudo, env, xargs, shells,
 * eval), apagam ou mudam permissões (rm, dd, chmod...) ou baixam e rodam coisas (curl, wget).
 */
export const NEVER_PREFIX = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'dd', 'mkfs', 'fdisk', 'mount', 'umount', 'chmod', 'chown', 'chgrp', 'chattr',
  'sudo', 'su', 'doas', 'pkexec', 'runas', 'env', 'xargs', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'watch',
  'command', 'builtin', 'exec', 'eval', 'source', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh',
  'powershell', 'cmd', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'socat', 'kill', 'killall', 'pkill',
  'reboot', 'shutdown', 'halt', 'poweroff', 'systemctl', 'crontab', 'at',
]);
/** Interpretadores: só com um subcomando (ex.: "npx vitest", "bun test"), nunca sozinhos ("python *" roda qualquer coisa). */
export const NEEDS_SUBCOMMAND = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'npx', 'pnpx', 'bunx', 'uvx', 'osascript', 'awk', 'sed', 'find', 'git', 'docker', 'kubectl']);
/**
 * Subcomandos que apagam, aplicam em produção ou abrem um shell: nunca viram "não perguntar de novo", nem com o
 * prefixo de 2 palavras ("kubectl delete *" liberaria apagar qualquer recurso em qualquer cluster).
 */
export const NEVER_PAIR = new Map([
  ['kubectl', new Set(['delete', 'apply', 'replace', 'patch', 'edit', 'exec', 'drain', 'cordon', 'scale', 'rollout', 'run', 'cp', 'debug', 'create', 'annotate', 'label', 'taint', 'set'])],
  ['terraform', new Set(['apply', 'destroy', 'import', 'state', 'taint', 'untaint', 'force-unlock', 'workspace'])],
  ['tofu', new Set(['apply', 'destroy', 'import', 'state', 'taint', 'untaint', 'force-unlock', 'workspace'])],
  ['helm', new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback'])],
  ['git', new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch', 'filter-repo', 'gc', 'prune', 'update-ref', 'reflog', 'checkout', 'restore', 'rm'])],
  ['gh', new Set(['api', 'repo', 'secret', 'workflow', 'release', 'pr', 'auth'])],
  ['docker', new Set(['run', 'exec', 'rm', 'rmi', 'system', 'volume', 'compose', 'kill', 'push'])],
  ['az', new Set(['keyvault', 'role', 'group', 'ad', 'resource', 'aks', 'login', 'account'])],
  ['aws', new Set(['iam', 'sts', 'secretsmanager', 'ssm', 'kms', 's3', 'ec2', 'eks', 'rds'])],
  ['npm', new Set(['publish', 'unpublish', 'exec', 'x'])],
]);
const FIRST_TOKEN = /^[A-Za-z0-9][\w.+-]{0,63}$/;
const SUB_TOKEN = /^[A-Za-z0-9][\w:.+-]{0,63}$/;
const SHELL_META = /[;|&`$()<>'"\\{}*?!#~]/;

/** Capability das regras do Kiro para a ferramenta: "shell", "fs_write" ou undefined. */
export function capabilityOf(toolName) {
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  if (toolName === 'fs_write' || toolName === 'write' || toolName === 'write_file' || toolName === 'str_replace') return 'fs_write';
  return undefined;
}

/**
 * Prefixo seguro de um comando (as 1–2 primeiras palavras, como as sugestões do Claude Code), ou undefined. Sem
 * prefixo: comando vazio, atribuição de variável, caminho, caractere especial de shell (; | & ` $ ( ) < > aspas) na
 * parte usada, ou comando da lista NEVER_PREFIX. Mesmo assim o Kiro avalia cada subcomando (a && b, a; b) contra as
 * regras, então o prefixo nunca libera o que vem depois de um separador.
 */
export function shellPrefix(command) {
  if (typeof command !== 'string') return undefined;
  const line = command.trim().split('\n')[0];
  const words = line.split(/\s+/).filter(Boolean);
  const [first, second, third] = words;
  if (!first || !FIRST_TOKEN.test(first)) return undefined;
  const name = first.toLowerCase();
  if (NEVER_PREFIX.has(name) || /^mkfs/.test(name)) return undefined;
  if (second && SUB_TOKEN.test(second)) {
    // Subcomando que apaga, aplica ou abre shell: nunca vira regra (nem "kubectl delete *", "git push *", "terraform apply *").
    if (NEVER_PAIR.get(name)?.has(second.toLowerCase())) return undefined;
    // "npm run <script>": o prefixo leva o script ("npm run build *"); "npm run *" liberaria qualquer script do package.json.
    if (RUNNERS.has(name) && RUN_VERBS.has(second.toLowerCase())) return third && SUB_TOKEN.test(third) ? `${first} ${second} ${third}` : undefined;
    return `${first} ${second}`;
  }
  // Caractere de shell logo na 2ª palavra ("npm test;", "ls|x"): sem prefixo (encolher para 1 palavra alargaria a regra).
  if (second && SHELL_META.test(second)) return undefined;
  return NEEDS_SUBCOMMAND.has(name) || NEVER_PAIR.has(name) || RUNNERS.has(name) ? undefined : first;
}

/** Gerenciadores cujo "run"/"exec" roda um script do projeto: o script entra no prefixo. */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno', 'make', 'just', 'task', 'poetry', 'uv', 'pipenv', 'cargo', 'dotnet', 'go', 'mvn', 'gradle']);
const RUN_VERBS = new Set(['run', 'run-script', 'exec', 'x', 'dlx']);

/**
 * Regras "não perguntar de novo" que o hook oferece ao escritório (na ordem em que aparecem): no shell, os comandos
 * que começam com o prefixo (`<prefixo> *`: o Kiro casa o prefixo sozinho e com argumentos) e o shell inteiro; na
 * escrita, a ferramenta inteira.
 */
export function ruleSuggestions(toolName, toolInput) {
  const capability = capabilityOf(toolName);
  if (!capability) return [];
  const out = [];
  if (capability === 'shell') {
    const prefix = shellPrefix(isObject(toolInput) ? toolInput.command : undefined);
    if (prefix) out.push({ capability, effect: 'allow', match: [`${prefix} *`], prefix });
  }
  out.push({ capability, effect: 'allow' });
  return out;
}

/** A regra que vai para o arquivo do Kiro (sem o `prefix`, que é só para mostrar). */
function kiroRule(s) {
  return { capability: s.capability, effect: 'allow', ...(s.match ? { match: [...s.match] } : {}) };
}

/** A sugestão é uma das que este hook gera (confere de novo antes de gravar). */
export function validSuggestion(s) {
  if (!isObject(s) || (s.capability !== 'shell' && s.capability !== 'fs_write') || s.effect !== 'allow') return false;
  if (s.match === undefined) return true;
  if (s.capability !== 'shell' || !Array.isArray(s.match) || s.match.length !== 1 || typeof s.match[0] !== 'string') return false;
  const m = /^(.+) \*$/.exec(s.match[0]);
  return !!m && shellPrefix(m[1]) === m[1];
}

/** Já existe regra que libera isso (mesma capability, allow, sem exclude e: sem match / com o padrão)? */
function hasRule(rules, rule) {
  return rules.some((r) => {
    if (!isObject(r) || r.capability !== rule.capability || r.effect !== 'allow' || (Array.isArray(r.exclude) && r.exclude.length)) return false;
    if (!rule.match) return r.match === undefined || (Array.isArray(r.match) && r.match.length === 0);
    return Array.isArray(r.match) && r.match.includes(rule.match[0]);
  });
}

/** Linha YAML (flow) da regra: JSON é YAML válido. */
export function yamlRuleLine(rule) {
  return `- ${JSON.stringify(rule)}`;
}

/**
 * Acrescenta a regra a um permissions.yaml de verdade (o que o Kiro grava: `rules:` como única chave do topo, lista em
 * bloco). Devolve o texto novo, o mesmo texto (já estava) ou undefined (formato que o hook não sabe editar sem um
 * parser de YAML: não mexe).
 */
export function appendYamlRule(text, rule) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const line = yamlRuleLine(rule);
  if (lines.some((l) => l.trim() === line)) return text;
  let rulesAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l) || /^---\s*$/.test(l)) continue;
    if (/^\s/.test(l) || (rulesAt >= 0 && l.startsWith('-'))) continue;
    if (rulesAt >= 0 || !/^rules:\s*(\[\s*\])?\s*$/.test(l)) return undefined;
    rulesAt = i;
  }
  if (rulesAt < 0) return undefined;
  const indent = lines.slice(rulesAt + 1).map((l) => /^(\s*)- /.exec(l)?.[1]).find((x) => x !== undefined) ?? '  ';
  lines[rulesAt] = 'rules:';
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(`${indent}${line}`);
  return `${lines.join('\n')}\n`;
}

/** Arquivo de permissões do usuário do Kiro, pela mesma regra dele (yaml se existir; senão json; senão json novo). */
export function userPermissionsFile(kiroHome) {
  const dir = join(kiroHome, 'settings');
  const yaml = join(dir, 'permissions.yaml');
  // O Kiro carrega o .yaml se ele EXISTIR (mesmo vazio) e só então o .json: gravar no .json com um .yaml presente não valeria.
  if (existsSync(yaml)) return yaml;
  return join(dir, 'permissions.json');
}

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Trava do arquivo compatível com a do Kiro (proper-lockfile: o diretório <arquivo>.lock). */
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST' || i >= LOCK_TRIES) throw new Error(`arquivo travado: ${lock}`);
      await sleep(LOCK_STEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // já saiu
    }
  }
}

/** Texto novo do arquivo com a regra, o mesmo (já estava) ou undefined (não dá para editar com segurança). */
export function withRule(file, raw, rule) {
  const text = (raw ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) return `${JSON.stringify({ rules: [rule] }, null, 2)}\n`;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // YAML de verdade (o Kiro grava assim): só o formato simples que ele mesmo gera.
    return file.endsWith('.yaml') ? appendYamlRule(text, rule) : undefined;
  }
  if (!isObject(doc) || (doc.rules !== undefined && !Array.isArray(doc.rules))) return undefined;
  const rules = doc.rules ?? [];
  if (hasRule(rules, rule)) return text;
  return `${JSON.stringify({ ...doc, rules: [...rules, rule] }, null, 2)}\n`;
}

/**
 * Grava a regra no arquivo de permissões do usuário do Kiro: backup (<arquivo>.habblaud-backup-<data>), trava,
 * gravação atômica (arquivo temporário + rename) e idempotente. Devolve {file, changed} ou lança.
 */
export async function persistRule(kiroHome, rule, now = new Date()) {
  const file = userPermissionsFile(kiroHome);
  mkdirSync(join(kiroHome, 'settings'), { recursive: true, mode: 0o700 });
  return withLock(file, () => {
    const exists = existsSync(file);
    const raw = exists ? readFileSync(file, 'utf8') : undefined;
    const next = withRule(file, raw, rule);
    if (next === undefined) throw new Error(`formato que o Habblaud não sabe editar: ${file}`);
    if (exists && next === raw) return { file, changed: false };
    const mode = exists ? statSync(file).mode & 0o777 : 0o600;
    if (exists) copyFileSync(file, `${file}.habblaud-backup-${stamp(now)}`);
    const tmp = `${file}.habblaud-tmp-${process.pid}`;
    writeFileSync(tmp, next, { mode });
    try {
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nada
      }
      throw err;
    }
    return { file, changed: true };
  });
}

/** Anota a regra gravada em ~/.habblaud/kiro-rules.json (para o kiro:uninstall). */
export function recordRule(habblaudDir, file, rule) {
  const ledger = join(habblaudDir, LEDGER_FILE);
  let doc;
  try {
    doc = JSON.parse(readFileSync(ledger, 'utf8'));
  } catch {
    doc = undefined;
  }
  const rules = isObject(doc) && Array.isArray(doc.rules) ? doc.rules : [];
  const key = JSON.stringify({ file, rule });
  if (rules.some((r) => JSON.stringify({ file: r?.file, rule: r?.rule }) === key)) return;
  mkdirSync(habblaudDir, { recursive: true });
  const tmp = `${ledger}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ rules: [...rules, { file, rule }] }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, ledger);
}

/**
 * Tira de um arquivo de permissões as regras gravadas pelo Habblaud (kiro:uninstall). Devolve o texto novo e quantas
 * saíram (o Kiro pode ter regravado o arquivo e juntado a regra a outra: essas ficam, e o instalador avisa).
 */
export function withoutRules(file, raw, rules) {
  const text = raw.replace(/^\uFEFF/, '');
  const sigs = new Set(rules.map((r) => JSON.stringify(kiroRule(r))));
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    if (!file.endsWith('.yaml')) return { text, removed: 0 };
    const lines = new Set(rules.map((r) => yamlRuleLine(kiroRule(r))));
    const kept = text.split('\n').filter((l) => !lines.has(l.trim()));
    return { text: kept.join('\n'), removed: text.split('\n').length - kept.length };
  }
  if (!isObject(doc) || !Array.isArray(doc.rules)) return { text, removed: 0 };
  const kept = doc.rules.filter((r) => !(isObject(r) && sigs.has(JSON.stringify(kiroRule(r))) && !r.exclude));
  const removed = doc.rules.length - kept.length;
  return { text: removed ? `${JSON.stringify({ ...doc, rules: kept }, null, 2)}\n` : text, removed };
}

/** Pasta do Kiro desta sessão: KIRO_HOME ou ~/.kiro. */
export function kiroHomeOf(env = process.env) {
  const custom = typeof env.KIRO_HOME === 'string' ? env.KIRO_HOME.trim() : '';
  return resolve(custom || join(env.HOME || env.USERPROFILE || homedir(), '.kiro'));
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

/** Corpo mandado ao Habblaud: só o que ele usa (provider:"kiro") e as regras "não perguntar de novo" oferecidas. */
export function requestBody(input, timeoutMs, suggestions = ruleSuggestions(input.tool_name, input.tool_input)) {
  const body = { provider: 'kiro', session_id: typeof input.session_id === 'string' ? input.session_id : '', tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  if (typeof input.cwd === 'string') body.cwd = input.cwd;
  if (suggestions.length) body.kiro_suggestions = suggestions;
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
 * Aprovado com "não perguntar de novo": grava a regra escolhida (a ORIGINAL que este hook sugeriu, conferida de novo)
 * e espera o Kiro reler o arquivo. Falha ao gravar: só avisa no debug (a aprovação vale do mesmo jeito).
 */
export async function applySuggestion(result, suggestions, env = process.env, opts = {}) {
  if (!result || result.status !== 'decided' || result.behavior !== 'allow' || !Number.isInteger(result.suggestion)) return undefined;
  const s = suggestions[result.suggestion];
  if (!validSuggestion(s)) return undefined;
  const rule = kiroRule(s);
  try {
    const home = env.HOME || env.USERPROFILE || homedir();
    const r = await persistRule(kiroHomeOf(env), rule);
    recordRule(join(home, '.habblaud'), r.file, rule);
    debug(`regra ${r.changed ? 'gravada' : 'já estava'} em ${r.file}: ${JSON.stringify(rule)}`);
    // O Kiro relê o arquivo de permissões ~300 ms depois da mudança: esperar faz a chamada atual já passar sem o [y/n/t].
    if (r.changed) await sleep(opts.reloadWaitMs ?? RELOAD_WAIT_MS);
    return r;
  } catch (err) {
    debug(`não gravei a regra: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Sessão ainda desconhecida: o evento PreToolUse do hook de observar (que cria o agente) pode estar chegando junto. */
const REGISTER_RETRIES = 3;
const REGISTER_RETRY_MS = 400;

/**
 * Regras do arquivo de permissões do usuário do Kiro (o mesmo que persistRule grava). JSON inteiro; YAML só nas linhas
 * `- {json}` (as que o Habblaud grava) — o resto do YAML fica de fora e, na dúvida, o escritório pergunta.
 */
export function readUserRules(kiroHome) {
  const file = userPermissionsFile(kiroHome);
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  if (file.endsWith('.json')) {
    try {
      const doc = JSON.parse(text);
      return isObject(doc) && Array.isArray(doc.rules) ? doc.rules.filter(isObject) : [];
    } catch {
      return [];
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-\s+(\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try {
      const r = JSON.parse(m[1]);
      if (isObject(r)) out.push(r);
    } catch {
      // linha que não é JSON: ignora
    }
  }
  return out;
}

/** Comandos de um shell (a && b; c | d): cada um precisa casar com uma regra. Com $( ) ou ` ` não dá para saber: undefined. */
function shellParts(command) {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  if (/\$\(|`/.test(command)) return undefined;
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Esta chamada já está liberada por uma regra allow do usuário (sem exclude), e nenhuma regra deny da mesma capability
 * existe? Capability inteira (sem match) libera tudo; `"<prefixo> *"` libera o comando igual ao prefixo ou que começa
 * com ele + espaço, em cada parte do comando. Qualquer dúvida = false (o escritório pergunta).
 */
export function alreadyAllowed(rules, toolName, toolInput) {
  const capability = capabilityOf(toolName);
  if (!capability || !Array.isArray(rules)) return false;
  const mine = rules.filter((r) => isObject(r) && r.capability === capability);
  if (mine.some((r) => r.effect !== 'allow' || (Array.isArray(r.exclude) && r.exclude.length))) return false;
  if (mine.some((r) => r.match === undefined || (Array.isArray(r.match) && !r.match.length))) return true;
  if (capability !== 'shell') return false;
  const prefixes = mine
    .flatMap((r) => (Array.isArray(r.match) ? r.match : []))
    .map((m) => (typeof m === 'string' ? /^(.+) \*$/.exec(m)?.[1] : undefined))
    .filter((p) => typeof p === 'string' && p.trim());
  if (!prefixes.length) return false;
  const parts = shellParts(isObject(toolInput) ? toolInput.command : undefined);
  if (!parts?.length) return false;
  return parts.every((part) => prefixes.some((p) => part === p || part.startsWith(`${p} `)));
}

/**
 * Decide o pedido (ou não). Devolve {deny:<motivo>} para bloquear, ou undefined para deixar o terminal decidir.
 * Nunca lança.
 */
export async function run(env = process.env, stdinText, opts = {}) {
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
    // "Não perguntar de novo" já gravado (por aqui ou pelo "Always allow" do próprio Kiro): o Kiro não pergunta mais, e o
    // escritório também não. Sem isso o cartão voltava a cada chamada e parecia que a regra não tinha valido.
    if (alreadyAllowed(readUserRules(kiroHomeOf(env)), input.tool_name, input.tool_input)) {
      debug('já liberado por uma regra do Kiro: sem cartão');
      return undefined;
    }

    const base = `http://127.0.0.1:${cfg.port}`;
    const deadline = Date.now() + cfg.waitMs;
    const suggestions = ruleSuggestions(input.tool_name, input.tool_input);
    const body = requestBody(input, cfg.waitMs, suggestions);
    let reg;
    for (let i = 0; ; i++) {
      reg = await call(base, 'POST', '/api/permissions', body, REGISTER_TIMEOUT_MS);
      if (reg?.status !== 200 || reg.json?.skip !== 'unknown-session' || i >= REGISTER_RETRIES) break;
      await sleep(opts.retryMs ?? REGISTER_RETRY_MS);
    }
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
      await applySuggestion(r.json, suggestions, env, opts);
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
