// Identidade do servidor de aplicação (VAPID, RFC 8292): par P-256 e o JWT ES256 que vai no cabeçalho
// `Authorization: vapid t=<jwt>, k=<chave pública>`. Sem dependências: só node:crypto.
import { createECDH, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** Validade do JWT. A RFC 8292 deixa até 24 h; 12 h cobre qualquer relógio torto sem esticar o prazo. */
export const JWT_TTL_S = 12 * 60 * 60;

export interface VapidKeys {
  /** Privada bruta de 32 bytes, base64url (o que vai no .env). */
  privateKey: string;
  /** Pública sem compressão de 65 bytes, base64url (o que vai para o navegador). */
  publicKey: string;
}

/** O par bruto de 32/65 bytes, como as APIs de push o pedem. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: rawPrivate(privateKey).toString('base64url'),
    publicKey: rawPublic(publicKey).toString('base64url'),
  };
}

function rawPrivate(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { d?: string };
  if (!jwk.d) throw new Error('vapid: chave privada sem componente d');
  return Buffer.from(jwk.d, 'base64url');
}

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('vapid: chave pública sem x/y');
  return Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

/** Objeto de chave a partir da privada bruta de 32 bytes (a pública sai dela por multiplicação). */
export function privateKeyFromRaw(privateKey: string): KeyObject {
  const d = Buffer.from(privateKey, 'base64url');
  if (d.length !== 32) throw new Error('vapid: chave privada precisa de 32 bytes em base64url');
  // A pública que o JWK exige vem da própria privada; derivamos com ECDH, que é o caminho sem ASN.1 à mão.
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: d.toString('base64url'),
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
  });
}

/** A pública bruta (65 bytes, base64url) que corresponde a uma privada bruta. */
export function publicFromPrivate(privateKey: string): string {
  return rawPublic(createPublicKey(privateKeyFromRaw(privateKey))).toString('base64url');
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Assinatura ES256 em formato bruto r|s (64 bytes), que é o que o JWT pede (e não o DER do OpenSSL). */
function signEs256(data: Buffer, key: KeyObject): Buffer {
  return createSign('sha256').update(data).sign({ key, dsaEncoding: 'ieee-p1363' });
}

export interface VapidHeaderOptions {
  /** Endpoint da inscrição: o `aud` do JWT é a origem dele (ex.: https://web.push.apple.com). */
  endpoint: string;
  privateKey: string;
  publicKey: string;
  /** Contato do responsável: `mailto:` ou `https:` (RFC 8292 §2.1). */
  subject: string;
  now?: () => number;
}

/**
 * Margem de renovação do JWT. O servidor de push da Apple pede, no cabeçalho `Authorization`, que o JWT não seja
 * renovado mais de uma vez por hora, e responde 400 aos tokens novos que chegam dentro dessa hora: um token assinado
 * a cada envio faz a maior parte dos avisos cair. Com 12 h de validade e 1 h de margem, renova-se de 11 em 11 horas.
 */
export const JWT_REFRESH_MARGIN_S = 60 * 60;

/** Token em uso, por identidade. No pior caso tem uma entrada por serviço de push, nunca uma por aparelho. */
const tokens = new Map<string, { header: string; exp: number }>();

/** Esvazia os tokens em uso (os testes, e quem trocar a identidade VAPID com o processo a correr). */
export function clearVapidCache(): void {
  tokens.clear();
}

/**
 * Valor do cabeçalho `Authorization` de um envio (esquema `vapid` da RFC 8292 §3). O token é **reutilizado** enquanto
 * lhe sobrar mais de `JWT_REFRESH_MARGIN_S` de validade; assinar um por envio é o que os servidores de push leem como
 * renovação a mais.
 */
export function vapidAuthorization(opts: VapidHeaderOptions): string {
  const aud = new URL(opts.endpoint).origin;
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  // A chave é a identidade (origem do serviço de push, contato e chave pública), NUNCA o endpoint: o mesmo token
  // serve todos os aparelhos do mesmo serviço, e assim o mapa não cresce com o número de inscrições.
  const id = `${aud}\u0000${opts.subject}\u0000${opts.publicKey}`;
  const emUso = tokens.get(id);
  if (emUso && emUso.exp - now > JWT_REFRESH_MARGIN_S) return emUso.header;
  const exp = now + JWT_TTL_S;
  const header = b64urlJson({ typ: 'JWT', alg: 'ES256' });
  const body = b64urlJson({ aud, exp, sub: opts.subject });
  const signing = Buffer.from(`${header}.${body}`, 'utf8');
  const sig = signEs256(signing, privateKeyFromRaw(opts.privateKey)).toString('base64url');
  const value = `vapid t=${header}.${body}.${sig}, k=${opts.publicKey}`;
  tokens.set(id, { header: value, exp });
  return value;
}
