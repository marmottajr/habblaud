// Envio de um push ao servidor do navegador (no iOS, *.push.apple.com): corpo cifrado pela RFC 8291, identidade VAPID
// pela RFC 8292, e o que o servidor de push responde traduzido em "segue", "repete depois" ou "inscrição morta".
import { createHash } from 'node:crypto';
import { encryptPayload } from './encrypt';
import { parsePushEndpoint, SEND_TIMEOUT_MS } from './hosts';
import { endpointTag, type PushSubscription } from './store';
import { vapidAuthorization } from './vapid';

/** Urgência do RFC 8030 §5.3: `high` acorda o aparelho, `normal` pode esperar a próxima janela. */
export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendOptions {
  /** Segundos que o servidor de push guarda a mensagem se o aparelho estiver fora do ar. */
  ttlS: number;
  urgency: Urgency;
  /** Mensagens do mesmo `Topic` ainda não entregues se substituem (RFC 8030 §5.4). */
  topic?: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** A inscrição morreu (404/410): quem chamou apaga. */
  gone: boolean;
  error?: string;
}

export interface SenderDeps {
  privateKey: string;
  publicKey: string;
  subject: string;
  /** Anfitriões de push aceitos (sufixos). Conferidos aqui outra vez: uma linha antiga do ficheiro não escapa. */
  hosts: readonly string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Log de uma linha por envio; nunca recebe o endpoint inteiro nem a chave. */
  log?: (msg: string) => void;
}

/**
 * O `Topic` de um tipo de aviso: a impressão digital do id, em base64url.
 *
 * A RFC 8030 §5.4 limita o `Topic` a 32 caracteres do alfabeto base64url, e o servidor de push da Apple é mais
 * estrito do que a letra da norma: trata o valor como base64url **para decodificar**, e recusa com
 * `400 BadWebPushTopic` o que não decodifica. Um comprimento ≡ 1 (mod 4) nunca é base64 válido, porque 4n+1
 * caracteres não correspondem a número nenhum de octetos. Logo o id do tipo não serve como `Topic` do jeito que
 * está: `needs-you` tem 9 caracteres e era recusado. Medido numa instância real, com o mesmo aparelho inscrito e a
 * mesma identidade VAPID: 59 recusas de um tipo de 9 caracteres e 3 de um de 13, contra 9 entregas de um de 11. Um
 * aviso recusado assim não chega ao aparelho e não deixa erro em lugar nenhum além desta linha de log.
 *
 * Daí a impressão digital em vez do nome: 15 octetos de um sha256 dão **20 caracteres** base64url, múltiplo de 4,
 * que decodificam sem resto e sem bits de sobra (passa até num decodificador estrito), cabem nos 32 e usam só o
 * alfabeto permitido. Vale para **qualquer** id, o que importa porque `registerType` é a porta por onde uma
 * extensão registra os seus tipos e esses nomes não são escolhidos aqui. Determinística: o mesmo tipo dá sempre o
 * mesmo `Topic`, que é o que faz a substituição do RFC 8030 §5.4 continuar funcionando, e ids diferentes dão
 * `Topic` diferentes (120 bits de impressão digital, sem corte que possa juntar dois nomes com o mesmo começo).
 *
 * O id legível não se perde: é ele que vai na linha do log, por `topicTag`.
 */
export function safeTopic(id: string): string {
  if (!id) return '';
  return createHash('sha256').update(id, 'utf8').digest().subarray(0, 15).toString('base64url');
}

/** O id do tipo como ele entra na linha do log: lista branca, porque uma linha de log não se parte em duas. */
function topicTag(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
}

/**
 * O `reason` do JSON de erro de um servidor de push (a Apple responde `{"reason":"BadJwtToken"}`). Saneado a
 * caracteres de identificador: o corpo é texto de terceiros e não entra cru num log nosso, nem com mudanças de linha
 * que partiriam a linha em duas. `'sem motivo'` quando a resposta não o traz.
 */
export function pushReason(body: string | undefined): string {
  if (!body) return 'sem motivo';
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'sem motivo';
  } catch {
    // Corpo que não é JSON: fica o status, que já está na linha.
  }
  return 'sem motivo';
}

export async function sendPush(sub: PushSubscription, payload: string, opts: SendOptions, deps: SenderDeps): Promise<SendResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  // Segunda barreira: a primeira é a rota de inscrição, esta apanha o que já estiver no ficheiro.
  // `parsePushEndpoint` nunca lança, logo o `new URL` do VAPID mais abaixo passa a ter forma garantida.
  if (!parsePushEndpoint(sub.endpoint, deps.hosts)) {
    deps.log?.(`push ${endpointTag(sub.endpoint)} -> endpoint recusado (anfitrião fora da lista ou URL inválida)`);
    // `gone`: a inscrição não serve para nada e quem chama apaga-a, como faz com um 410.
    return { ok: false, status: 0, gone: true, error: 'endpoint recusado' };
  }
  let body: Buffer;
  try {
    body = encryptPayload(payload, sub.keys);
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: `cifra: ${(err as Error).message}` };
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization({ endpoint: sub.endpoint, privateKey: deps.privateKey, publicKey: deps.publicKey, subject: deps.subject, now: deps.now }),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    // Mínimo 1: a Apple recusa com `BadTtl` um `TTL` que não seja um número positivo, e 0 não é.
    TTL: String(Math.max(1, Math.floor(opts.ttlS) || 0)),
    Urgency: opts.urgency,
  };
  // Só com valor: um `Topic` vazio vale um 400, pior do que não mandar.
  const topic = opts.topic ? safeTopic(opts.topic) : '';
  if (topic) headers.Topic = topic;

  try {
    const res = await doFetch(sub.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      // Um redirecionamento é falha, não um salto a seguir: o `fetch` do Node segue um 302, converte-o em GET e
      // devolve o corpo do alvo a quem chamou, que é o caminho de sonda da rede interna.
      redirect: 'manual',
      // Sem prazo, uma inscrição que aceita a ligação e não responde segura a fila por minutos.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      deps.log?.(`push ${endpointTag(sub.endpoint)} -> ${res.status} (redirecionamento recusado)`);
      return { ok: false, status: res.status, gone: false, error: 'o servidor de push respondeu com redirecionamento' };
    }
    const gone = res.status === 404 || res.status === 410;
    const ok = res.status >= 200 && res.status < 300;
    // 4xx que não é 404/410 quase sempre é VAPID ou cifra: o texto do servidor de push ajuda e não tem segredo nosso.
    const error = ok ? undefined : ((await res.text().catch(() => '')) || `HTTP ${res.status}`).slice(0, 300);
    // O `reason` do servidor de push (`BadJwtToken`, `BadTtl`, `BadWebPushTopic`, …) nomeia a regra que o envio
    // violou, e o tipo diz por que aviso foi: sem os dois, um 400 no log é indistinguível de qualquer outro 400.
    // O id do tipo, não o `Topic`: a impressão digital não diz nada a quem lê o log, e o log é onde se vê por qual
    // aviso foi o envio.
    const tipo = opts.topic && topicTag(opts.topic) ? ` ${topicTag(opts.topic)}` : '';
    deps.log?.(`push ${endpointTag(sub.endpoint)}${tipo} -> ${res.status}${ok ? '' : ` (${pushReason(error)})`}`);
    return { ok, status: res.status, gone, error };
  } catch (err) {
    deps.log?.(`push ${endpointTag(sub.endpoint)} -> falha de rede`);
    return { ok: false, status: 0, gone: false, error: (err as Error).message.slice(0, 300) };
  }
}
