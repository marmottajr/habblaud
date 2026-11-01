// VAPID (RFC 8292): o servidor de push recusa o envio com 401 se o JWT vier torto, e a mensagem de erro da Apple não
// diz qual campo está errado. Estes testes são o que separa "o push não chegou" de "o push não foi assinado".
import { createVerify, createPublicKey } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearVapidCache, generateVapidKeys, JWT_REFRESH_MARGIN_S, JWT_TTL_S, privateKeyFromRaw, publicFromPrivate, vapidAuthorization } from './vapid';

const ENDPOINT = 'https://web.push.apple.com/abc123456789';

function parts(header: string): { jwt: string; key: string } {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  if (!m) throw new Error(`cabeçalho fora do formato: ${header}`);
  return { jwt: m[1], key: m[2] };
}

function claims(jwt: string): { aud: string; exp: number; sub: string } {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

describe('generateVapidKeys', () => {
  it('gera 32 bytes privados e 65 públicos sem compressão', () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const pub = Buffer.from(keys.publicKey, 'base64url');
    expect(pub).toHaveLength(65);
    expect(pub[0]).toBe(4);
  });

  it('a pública sai da privada (o .env guarda só a privada)', () => {
    const keys = generateVapidKeys();
    expect(publicFromPrivate(keys.privateKey)).toBe(keys.publicKey);
  });

  it('recusa uma privada fora dos 32 bytes', () => {
    expect(() => privateKeyFromRaw('curta')).toThrow(/32 bytes/);
  });
});

describe('vapidAuthorization', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization({ endpoint: ENDPOINT, ...keys, subject: 'mailto:alguem@exemplo.pt', now: () => 1_700_000_000_000 });

  it('usa o esquema vapid com t e k', () => {
    expect(parts(header).key).toBe(keys.publicKey);
  });

  it('o aud é a origem do endpoint, não o caminho', () => {
    const c = claims(parts(header).jwt);
    expect(c.aud).toBe('https://web.push.apple.com');
    expect(c.sub).toBe('mailto:alguem@exemplo.pt');
    expect(c.exp).toBe(1_700_000_000 + JWT_TTL_S);
  });

  it('a validade fica dentro das 24 h do RFC 8292', () => {
    expect(JWT_TTL_S).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('o cabeçalho ES256 é o que o servidor de push espera', () => {
    const head = JSON.parse(Buffer.from(parts(header).jwt.split('.')[0], 'base64url').toString('utf8'));
    expect(head).toEqual({ typ: 'JWT', alg: 'ES256' });
  });

  it('a assinatura é r|s de 64 bytes e confere com a chave pública', () => {
    const [h, b, sig] = parts(header).jwt.split('.');
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64);
    const pub = createPublicKey(privateKeyFromRaw(keys.privateKey));
    const ok = createVerify('sha256')
      .update(Buffer.from(`${h}.${b}`, 'utf8'))
      .verify({ key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });

  it('nada da chave privada aparece no cabeçalho', () => {
    expect(header).not.toContain(keys.privateKey);
  });
});

describe('vapidAuthorization: ritmo de renovação', () => {
  const keys = generateVapidKeys();
  const ident = { endpoint: ENDPOINT, ...keys, subject: 'mailto:alguem@exemplo.pt' };
  const T0 = 1_700_000_000_000;

  beforeEach(() => clearVapidCache());

  it('o mesmo token serve as assinaturas seguintes', () => {
    const inicial = vapidAuthorization({ ...ident, now: () => T0 });
    expect(vapidAuthorization({ ...ident, now: () => T0 + 1_000 })).toBe(inicial);
    expect(vapidAuthorization({ ...ident, now: () => T0 + 60 * 60 * 1000 })).toBe(inicial);
  });

  it('renova quando falta a margem para o fim, e não antes', () => {
    const inicial = vapidAuthorization({ ...ident, now: () => T0 });
    const limite = T0 + (JWT_TTL_S - JWT_REFRESH_MARGIN_S) * 1000;
    expect(vapidAuthorization({ ...ident, now: () => limite - 1_000 })).toBe(inicial);
    expect(vapidAuthorization({ ...ident, now: () => limite + 1_000 })).not.toBe(inicial);
  });

  it('o intervalo de renovação fica acima da hora que o servidor de push da Apple exige', () => {
    expect(JWT_TTL_S - JWT_REFRESH_MARGIN_S).toBeGreaterThan(60 * 60);
  });

  it('identidades diferentes não partilham token', () => {
    const apple = vapidAuthorization({ ...ident, now: () => T0 });
    const outro = vapidAuthorization({ ...ident, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', now: () => T0 });
    expect(outro).not.toBe(apple);
    expect(claims(parts(outro).jwt).aud).toBe('https://updates.push.services.mozilla.com');
    const contacto = vapidAuthorization({ ...ident, subject: 'mailto:outro@exemplo.pt', now: () => T0 });
    expect(contacto).not.toBe(apple);
  });

  it('o token reutilizado continua dentro das regras do servidor de push', () => {
    vapidAuthorization({ ...ident, now: () => T0 });
    const depois = vapidAuthorization({ ...ident, now: () => T0 + 2_000 });
    const c = claims(parts(depois).jwt);
    const agora = Math.floor((T0 + 2_000) / 1000);
    expect(c.aud).toBe('https://web.push.apple.com');
    expect(c.sub.startsWith('mailto:')).toBe(true);
    expect(c.exp).toBeGreaterThan(agora);
    expect(c.exp - agora).toBeLessThanOrEqual(24 * 60 * 60);
  });
});
