// Refino opcional da explicação em linguagem de leigo (HABBLAUD_EXPLICAR=claude): o servidor pede ao Claude Code deste
// computador (`claude -p --model haiku`) uma frase melhor para o `what`, por cima da explicação automática de
// shared/explain.ts. Desligado por padrão: usa o plano de quem roda o Habblaud (uma chamada curta por pedido) e leva
// alguns segundos. Regras:
// - só o texto muda: o risco (baixo/médio/alto) continua o da heurística, nunca o do modelo;
// - tempo limite de 8 s; sem resposta, com erro ou resposta estranha (vazia, longa demais, várias linhas), fica o
//   texto automático;
// - cache por pedido (ferramenta + argumentos): o mesmo pedido repetido não chama o modelo de novo;
// - `--bare` e `--no-session-persistence`: a chamada não roda hooks (não cria outro pedido de permissão), não
//   carrega plugins nem MCP e não deixa transcript (não vira um agente no escritório);
// - o que vai ao modelo é o que o cartão já mostra (título mascarado, explicação automática, comando/diff cortado),
//   nunca o `input` inteiro.
import { spawn } from 'node:child_process';
import type { PermissionRequestInfo, PlainExplanation } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const REFINE_TIMEOUT_MS = 8_000;
/** Tamanho máximo do `what` refinado (o cartão mostra uma ou duas linhas). */
export const REFINE_MAX = 260;
const INPUT_MAX = 1_200;
const CACHE_MAX = 200;

export interface RefineOptions {
  /** Executável do Claude Code (server/claude-bin.ts). */
  claudeBin: string;
  model?: string;
  timeoutMs?: number;
  /** Para os testes: roda outro programa no lugar do `claude`. */
  run?: Runner;
}

/** Roda um comando com um texto no stdin e devolve o stdout (rejeita com erro, código diferente de zero ou tempo esgotado). */
export type Runner = (bin: string, args: string[], stdin: string, timeoutMs: number) => Promise<string>;

/** O prompt que vai ao modelo, em português, com o que o cartão já mostra. */
export function refinePrompt(info: Pick<PermissionRequestInfo, 'tool' | 'title' | 'input'>, plain: PlainExplanation): string {
  const input = (info.input ?? '').slice(0, INPUT_MAX);
  return [
    tr('Você explica, para uma pessoa que não é programadora, o que um agente de IA quer fazer no computador dela. Ela vai aprovar ou recusar pelo que você escrever.'),
    tr('Responda com UMA frase em português do Brasil, simples e direta, de até 200 caracteres, começando com "O agente quer". Descreva arquivos e pastas em palavras (nome do arquivo e onde fica), nunca com o caminho inteiro. Não invente nada que não esteja abaixo. Não fale do risco. Não use markdown nem aspas.'),
    '',
    tr('Ferramenta: {0}', [info.tool]),
    tr('Título técnico: {0}', [info.title]),
    tr('Explicação automática (melhore-a): {0}', [plain.what]),
    input ? tr('Argumentos (cortados):\n{0}', [input]) : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** A resposta serve? Uma linha, tamanho razoável, sem markdown. */
export function acceptRefined(raw: string): string | undefined {
  const text = raw.trim().replace(/^["“”']+|["“”']+$/g, '').trim();
  if (!text || text.includes('\n') || text.length > REFINE_MAX || text.length < 12) return undefined;
  if (/^[#*`>-]/.test(text) || /```/.test(text)) return undefined;
  return text;
}

/** Chave do cache: a ferramenta e os argumentos mostrados (o id do pedido muda a cada tentativa). */
function cacheKey(info: Pick<PermissionRequestInfo, 'tool' | 'title' | 'input'>): string {
  return `${info.tool}\u0000${info.title}\u0000${info.input ?? ''}`;
}

const defaultRun: Runner = (bin, args, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(tr('tempo esgotado ({0} s)', [Math.round(timeoutMs / 1000)])));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || tr('código {0}', [code ?? '?'])));
    });
    child.stdin.end(stdin);
  });

/**
 * Cria o refinador para RegistryOptions.refine: devolve o `what` refinado ou undefined (fica o automático). Nunca
 * rejeita por resposta ruim; rejeita só por erro de execução (o registro loga uma vez).
 */
export function createClaudeRefiner(opts: RefineOptions): (info: PermissionRequestInfo, plain: PlainExplanation) => Promise<string | undefined> {
  const run = opts.run ?? defaultRun;
  const model = opts.model ?? 'haiku';
  const timeoutMs = opts.timeoutMs ?? REFINE_TIMEOUT_MS;
  const cache = new Map<string, Promise<string | undefined>>();
  return (info, plain) => {
    const key = cacheKey(info);
    const hit = cache.get(key);
    if (hit) return hit;
    const args = ['-p', '--bare', '--no-session-persistence', '--model', model, '--output-format', 'text', '--tools', ''];
    const promise = run(opts.claudeBin, args, refinePrompt(info, plain), timeoutMs).then(acceptRefined);
    cache.set(key, promise);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    // Falha de execução: sai do cache (a próxima tentativa roda de novo) e sobe para o registro logar.
    promise.catch(() => cache.delete(key));
    return promise;
  };
}
