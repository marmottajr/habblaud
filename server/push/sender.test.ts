// O envio em si: os cabeçalhos que o servidor de push vê e a linha que fica no log. Nenhum teste aqui chama a rede:
// o `fetch` é injetado, e é por isso que estes casos podem afirmar o que a Apple recusaria sem nunca lhe mandar nada.
import { createECDH, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pushReason, sendPush, type SendOptions } from './sender';
import { clearVapidCache, generateVapidKeys } from './vapid';
import type { PushSubscription } from './store';

const vapid = generateVapidKeys();
const ua = createECDH('prime256v1');
ua.generateKeys();
const SUBJECT = 'mailto:alguem@exemplo.pt';
const T0 = 1_700_000_000_000;

const sub: PushSubscription = {
  id: 'ins-1',
  endpoint: `https://web.push.apple.com/${'a'.repeat(150)}aBcD-_12`,
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  types: {},
  createdAt: 0,
};

/** Um envio com `fetch` falso: devolve os cabeçalhos que o `sendPush` montou e as linhas de log que deixou. */
async function envia(opts: { at?: number; status?: number; body?: string } & Partial<SendOptions> = {}) {
  let headers: Record<string, string> = {};
  const linhas: string[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return new Response(opts.body ?? '', { status: opts.status ?? 201 });
  }) as unknown as typeof globalThis.fetch;
  const r = await sendPush(
    sub,
    JSON.stringify({ title: 'Alguém precisa de você', tag: 'needs-you' }),
    { ttlS: opts.ttlS ?? 600, urgency: opts.urgency ?? 'high', topic: 'topic' in opts ? opts.topic : 'needs-you' },
    { privateKey: vapid.privateKey, publicKey: vapid.publicKey, subject: SUBJECT, hosts: ['.push.apple.com'], fetch: fake, now: () => opts.at ?? T0, log: (m) => linhas.push(m) },
  );
  return { headers, linhas, r };
}

describe('sendPush: identidade reutilizada', () => {
  beforeEach(() => clearVapidCache());

  it('o mesmo token serve os envios seguintes', async () => {
    const a = await envia({ at: T0 });
    const b = await envia({ at: T0 + 1_000 });
    const c = await envia({ at: T0 + 60 * 60 * 1000 });
    expect(b.headers.Authorization).toBe(a.headers.Authorization);
    expect(c.headers.Authorization).toBe(a.headers.Authorization);
  });
});

describe('sendPush: a linha de log', () => {
  beforeEach(() => clearVapidCache());

  it('o motivo do servidor de push entra no log, com o tipo e sem o endpoint inteiro', async () => {
    const { linhas } = await envia({ status: 400, body: '{"reason":"BadJwtToken"}' });
    expect(linhas).toEqual(['push …aBcD-_12 needs-you -> 400 (BadJwtToken)']);
    expect(linhas[0]).not.toContain(sub.endpoint);
  });

  it('um 201 não leva motivo nenhum', async () => {
    const { linhas } = await envia({ status: 201 });
    expect(linhas).toEqual(['push …aBcD-_12 needs-you -> 201']);
  });
});

describe('pushReason', () => {
  it('tira o motivo do JSON do servidor de push', () => {
    expect(pushReason('{"reason":"BadTtl"}')).toBe('BadTtl');
  });

  it('corpo sem JSON, ou sem motivo, não despeja texto de terceiros no log', () => {
    expect(pushReason('<html>vai-te embora</html>')).toBe('sem motivo');
    expect(pushReason('{"erro":"x"}')).toBe('sem motivo');
    expect(pushReason('')).toBe('sem motivo');
    expect(pushReason(undefined)).toBe('sem motivo');
  });

  it('um motivo com mudança de linha continua a ser uma linha de log', () => {
    expect(pushReason('{"reason":"Bad\\nJwt Token; rm -rf /"}')).toBe('BadJwtTokenrm-rf');
    expect(pushReason(`{"reason":"${'A'.repeat(200)}"}`)).toHaveLength(40);
  });
});

describe('sendPush: cabeçalhos que o servidor de push recusaria', () => {
  beforeEach(() => clearVapidCache());

  it('o TTL sai sempre positivo', async () => {
    expect((await envia({ ttlS: 0 })).headers.TTL).toBe('1');
    expect((await envia({ ttlS: -5 })).headers.TTL).toBe('1');
    expect((await envia({ ttlS: 600.7 })).headers.TTL).toBe('600');
  });

  it('um topic que fica vazio depois do saneamento não vai em cabeçalho', async () => {
    const { headers, linhas } = await envia({ topic: ':::' });
    expect(headers.Topic).toBeUndefined();
    expect(linhas).toEqual(['push …aBcD-_12 -> 201']);
  });

  it('um topic comprido é cortado aos 32 caracteres', async () => {
    const { headers } = await envia({ topic: 'x'.repeat(40) });
    expect(headers.Topic).toHaveLength(32);
  });
});
