// VAPID (RFC 8292): o servidor de push recusa o envio com 401 se o JWT vier torto, e a mensagem de erro da Apple não
// diz qual campo está errado. Estes testes são o que separa "o push não chegou" de "o push não foi assinado".
import { createVerify, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateVapidKeys, JWT_TTL_S, privateKeyFromRaw, publicFromPrivate, vapidAuthorization } from './vapid';

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
