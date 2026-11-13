#!/usr/bin/env node
// Manda um evento de agente externo ao Habblaud (POST /api/external/events): leva ao escritório uma ferramenta sem
// suporte próprio (ex.: o Grok), a partir de um script, de um hook ou de um wrapper.
//
//   node scripts/agent-event.mjs <evento> --tool <ferramenta> [opções]
//
// Eventos: start, prompt, activity, waiting, idle, end (ver server/sources/external/source.ts).
//
// Exemplos:
//   node scripts/agent-event.mjs start    --tool grok --title "Refatorar o login"
//   node scripts/agent-event.mjs prompt   --tool grok --text "Corrija o teste do login"
//   node scripts/agent-event.mjs activity --tool grok --kind run --text "Rodando os testes" --detail "npm test"
//   node scripts/agent-event.mjs activity --tool grok --tool-name Read --input '{"file_path":"src/login.ts"}'
//   node scripts/agent-event.mjs waiting  --tool grok --text "aprovar um comando"
//   node scripts/agent-event.mjs idle     --tool grok
//   node scripts/agent-event.mjs end      --tool grok
//
// Sem --session, a sessão é uma por ferramenta e pasta (`<ferramenta>:<cwd>`): os eventos mandados da mesma pasta
// caem no mesmo personagem. Sem --cwd, vale a pasta atual. A porta é a de --port, HABBLAUD_PORT ou 4747.
//
// Regras: Node puro e sem dependências. Com o Habblaud fora do ar, avisa no stderr e sai com 0 (um hook nunca quebra
// a ferramenta por causa do Habblaud); argumentos inválidos ou um evento recusado saem com 2.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
const TIMEOUT_MS = 3_000;
const EVENTS = ['start', 'prompt', 'activity', 'waiting', 'idle', 'end'];
/** Opção da linha de comando -> campo do corpo. */
const FLAGS = {
  '--tool': 'tool',
  '--label': 'toolLabel',
  '--session': 'session',
  '--cwd': 'cwd',
  '--title': 'title',
  '--model': 'model',
  '--text': 'text',
  '--kind': 'kind',
  '--detail': 'detail',
  '--tool-name': 'toolName',
  '--input': 'input',
  '--port': 'port',
};

const USAGE = `Uso: node scripts/agent-event.mjs <${EVENTS.join('|')}> --tool <ferramenta> [opções]

  --tool <nome>        ferramenta, em letras minúsculas (ex.: grok); obrigatória
  --label <nome>       nome exibido da ferramenta (padrão: o --tool com a primeira letra maiúscula)
  --session <id>       id da sessão (padrão: <ferramenta>:<pasta>)
  --cwd <pasta>        pasta do projeto, que define a sala (padrão: a pasta atual)
  --title <texto>      título da sessão
  --model <nome>       modelo em uso
  --text <texto>       prompt: a instrução; activity: o que está fazendo; waiting: o motivo
  --kind <tipo>        activity: read, search, edit, write, run, test, git, web, think, respond... (padrão: other)
  --detail <texto>     activity: detalhe (comando, caminho...)
  --tool-name <nome>   activity: ferramenta no formato do Claude Code (Bash, Read, Edit...), com --input
  --input <json>       activity: a entrada dessa ferramenta, em JSON
  --port <n>           porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  -h, --help           mostra esta ajuda`;

export class UsageError extends Error {}

/** Lê os argumentos: o evento e o corpo do POST (mais a porta). */
export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const body = {};
  let event;
  let port;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const field = FLAGS[flag];
    if (field) {
      const value = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${flag} precisa de um valor.`);
      if (field === 'port') port = value;
      else if (field === 'input') {
        try {
          body.input = JSON.parse(value);
        } catch {
          throw new UsageError('--input precisa ser JSON válido.');
        }
      } else body[field] = value;
    } else if (!a.startsWith('-') && !event) event = a;
    else throw new UsageError(`opção desconhecida: ${a}`);
  }
  if (!event) throw new UsageError('diga o evento.');
  if (!EVENTS.includes(event)) throw new UsageError(`evento desconhecido: ${event} (use ${EVENTS.join(', ')}).`);
  if (!body.tool) throw new UsageError('--tool é obrigatório (ex.: --tool grok).');
  body.tool = String(body.tool).toLowerCase();
  body.event = event;
  body.cwd = resolve(cwd, body.cwd ?? '.');
  // A sessão padrão cabe nos 200 caracteres do servidor: pasta longa vira um hash dela.
  body.session ??= body.cwd.length <= 150 ? `${body.tool}:${body.cwd}` : `${body.tool}:${createHash('sha256').update(body.cwd).digest('hex').slice(0, 32)}`;
  const p = Number.parseInt(port ?? env.HABBLAUD_PORT ?? '', 10);
  return { body, port: Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT };
}

/** Manda o evento. Devolve o código de saída. */
export async function send(body, port, err = (m) => process.stderr.write(`${m}\n`), fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/api/external/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    err(`habblaud: o Habblaud não respondeu em http://127.0.0.1:${port} (${e?.cause?.code ?? e?.name ?? e}); evento ignorado.`);
    return 0;
  }
  if (res.ok) return 0;
  let detail = '';
  try {
    detail = (await res.json()).error ?? '';
  } catch {
    // sem corpo JSON
  }
  err(`habblaud: evento recusado (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`);
  return res.status === 404 ? 0 : 2;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`habblaud: ${e.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  process.exitCode = await send(parsed.body, parsed.port);
}

/** Chamado direto (e não importado pelos testes)? Compara caminhos reais (o repo pode ser um symlink). */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
