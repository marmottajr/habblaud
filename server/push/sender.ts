// Envio de um push ao servidor do navegador (no iOS, *.push.apple.com): corpo cifrado pela RFC 8291, identidade VAPID
// pela RFC 8292, e o que o servidor de push responde traduzido em "segue", "repete depois" ou "inscrição morta".
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

/** O `Topic` viaja em cabeçalho HTTP e a RFC 8030 limita a 32 caracteres base64url. */
function safeTopic(topic: string): string {
  return topic.replace(/[^A-Za-z0-9\-_]/g, '').slice(0, 32);
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
    TTL: String(Math.max(0, Math.floor(opts.ttlS))),
    Urgency: opts.urgency,
  };
  if (opts.topic) headers.Topic = safeTopic(opts.topic);

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
    deps.log?.(`push ${endpointTag(sub.endpoint)} -> ${res.status}`);
    return { ok, status: res.status, gone, error };
  } catch (err) {
    deps.log?.(`push ${endpointTag(sub.endpoint)} -> falha de rede`);
    return { ok: false, status: 0, gone: false, error: (err as Error).message.slice(0, 300) };
  }
}
