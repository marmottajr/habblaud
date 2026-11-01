// O envio em si: os cabeçalhos que o servidor de push vê e a linha que fica no log. Nenhum teste aqui chama a rede:
// o `fetch` é injetado, e é por isso que estes casos podem afirmar o que a Apple recusaria sem nunca lhe mandar nada.
import { createECDH, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { recusaDeTopic } from '../test/fake-push-server';
import { pushReason, safeTopic, sendPush, type SendOptions } from './sender';
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

  it('um id sem nada de legível continua dando um `Topic` válido, e o log fica sem o tipo', async () => {
    // A impressão digital vale para qualquer id não vazio, logo a substituição funciona até para um id que a lista
    // branca do log esvazia. O que o log não leva é um tipo ilegível.
    const { headers, linhas } = await envia({ topic: ':::' });
    expect(recusaDeTopic(headers.Topic)).toBeUndefined();
    expect(linhas).toEqual(['push …aBcD-_12 -> 201']);
  });

  it('um id comprido não estoura os 32 caracteres', async () => {
    const { headers } = await envia({ topic: 'x'.repeat(400) });
    expect(headers.Topic).toHaveLength(20);
  });

  it('sem tipo nenhum não vai cabeçalho `Topic`', async () => {
    const { headers } = await envia({ topic: undefined });
    expect(headers.Topic).toBeUndefined();
  });
});

/**
 * O `Topic` contra um duplo que recusa como o servidor da Apple recusa.
 *
 * O id do tipo ia direto no cabeçalho, e um id de 9 caracteres (`needs-you`) é recusado com
 * `400 BadWebPushTopic`, porque 4n+1 caracteres não são base64 válido. O aviso não chegava ao celular, a suíte
 * ficava verde, e o único sinal era a linha de log do envio.
 */
describe('o `Topic` de cada tipo passa pela regra do servidor de push', () => {
  beforeEach(() => clearVapidCache());

  it('os tipos deste repositório, e um id de cada comprimento recusado', async () => {
    for (const id of ['needs-you', 'summary', 'outro-aviso', 'a']) {
      const { headers } = await envia({ topic: id });
      expect(recusaDeTopic(headers.Topic), `tipo ${id}`).toBeUndefined();
    }
  });

  it('o id do jeito que estava seria recusado: é esse o defeito que isto fecha', () => {
    // A prova pelo contrário: o duplo recusa o nome que antes ia no cabeçalho.
    expect(recusaDeTopic('needs-you')).toBe('BadWebPushTopic');
    expect(recusaDeTopic('a')).toBe('BadWebPushTopic');
    expect(recusaDeTopic('outro-aviso')).toBeUndefined();
  });

  it('qualquer comprimento de id dá um `Topic` que passa', () => {
    // Um id por comprimento, de 1 a 64: nenhum escapa, inclusive os múltiplos de 4 e os ≡ 1 (mod 4).
    for (let n = 1; n <= 64; n++) {
      expect(recusaDeTopic(safeTopic('a'.repeat(n))), `id de ${n} caracteres`).toBeUndefined();
    }
    // E ids com tudo o que não é base64url: acentos, espaços, barras, dois pontos, emoji.
    for (const id of ['atenção à máquina', 'a b/c:d', '✅ feito', '..', '-', '_']) {
      expect(recusaDeTopic(safeTopic(id)), `id ${JSON.stringify(id)}`).toBeUndefined();
    }
  });

  it('é determinística e sem colisões', () => {
    expect(safeTopic('needs-you')).toBe(safeTopic('needs-you'));
    const ids = ['needs-you', 'summary', 'outro-aviso'];
    expect(new Set(ids.map((i) => safeTopic(i))).size).toBe(ids.length);
    // Dois ids com o mesmo começo comprido não se juntam: o corte aos 32 era o que fazia isso.
    expect(safeTopic(`${'x'.repeat(40)}a`)).not.toBe(safeTopic(`${'x'.repeat(40)}b`));
  });
});
