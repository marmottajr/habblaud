// Cifra do corpo de um Web Push (RFC 8291, `Content-Encoding: aes128gcm`), só com node:crypto.
//
// O servidor de push (no iOS, *.push.apple.com) encaminha bytes opacos: a chave sai do par efêmero daqui com a chave
// pública da inscrição (p256dh) e do segredo `auth`, então nem a Apple nem ninguém no caminho lê o texto.
//
// Registro, na ordem (RFC 8188 §2 com um único registro):
//   salt (16) | rs (4, big-endian) | idlen (1) | chave pública efêmera (65) | AES-128-GCM(texto | 0x02) + tag (16)
import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';

/** Tamanho do registro declarado no cabeçalho: um registro só, sempre maior que o corpo que mandamos. */
export const RECORD_SIZE = 4096;
/** Último (e único) registro: o texto termina com este delimitador antes de cifrar (RFC 8188 §2). */
const LAST_RECORD = 0x02;
const KEY_LEN = 16;
const NONCE_LEN = 12;
const SALT_LEN = 16;
/** Chave pública P-256 sem compressão: 0x04 | X (32) | Y (32). */
const P256_PUBLIC_LEN = 65;

export interface PushKeys {
  /** Chave pública P-256 do navegador, base64url (subscription.keys.p256dh). */
  p256dh: string;
  /** Segredo de autenticação de 16 bytes, base64url (subscription.keys.auth). */
  auth: string;
}

export interface EncryptOptions {
  /** Fixa o sal; só nos testes (produção usa 16 bytes aleatórios por envio). */
  salt?: Buffer;
  /** Fixa a chave privada efêmera; só nos testes. */
  privateKey?: Buffer;
}

export function b64urlToBuf(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

export function bufToB64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HKDF-SHA256 com um único bloco de saída (tudo aqui pede 32 bytes ou menos). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  if (length > 32) throw new Error('hkdf: saída acima de um bloco');
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.of(1)])).subarray(0, length);
}

/** `WebPush: info\0 | p256dh | chave pública efêmera` (RFC 8291 §3.3). */
function authInfo(uaPublic: Buffer, asPublic: Buffer): Buffer {
  return Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
}

function contentInfo(label: string): Buffer {
  return Buffer.from(`Content-Encoding: ${label}\0`, 'utf8');
}

/** Material de chave do Web Push: ECDH + o segredo `auth` da inscrição (RFC 8291 §3.3). */
export function webPushIkm(args: { shared: Buffer; authSecret: Buffer; uaPublic: Buffer; asPublic: Buffer }): Buffer {
  return hkdf(args.authSecret, args.shared, authInfo(args.uaPublic, args.asPublic), 32);
}

/**
 * Um registro `aes128gcm` completo (RFC 8188 §2): cabeçalho + texto cifrado. Separado de `encryptPayload` para o teste
 * poder conferir esta camada contra o vetor do RFC 8188 §3.1, que não tem ECDH nenhum pelo meio.
 */
export function aes128gcmRecord(args: { salt: Buffer; ikm: Buffer; keyid: Buffer; plaintext: Buffer }): Buffer {
  if (args.salt.length !== SALT_LEN) throw new Error('salt: 16 bytes');
  const key = hkdf(args.salt, args.ikm, contentInfo('aes128gcm'), KEY_LEN);
  const nonce = hkdf(args.salt, args.ikm, contentInfo('nonce'), NONCE_LEN);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([args.plaintext, Buffer.of(LAST_RECORD)])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(SALT_LEN + 4 + 1);
  args.salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_LEN);
  header.writeUInt8(args.keyid.length, SALT_LEN + 4);
  return Buffer.concat([header, args.keyid, sealed]);
}

/**
 * Corpo cifrado de um push para `keys`. Devolve os bytes que vão no POST ao endpoint, com
 * `Content-Encoding: aes128gcm` e sem mais nenhum cabeçalho de cifra (o sal e a chave efêmera viajam no próprio corpo).
 */
export function encryptPayload(plaintext: string | Buffer, keys: PushKeys, opts: EncryptOptions = {}): Buffer {
  const uaPublic = b64urlToBuf(keys.p256dh);
  const authSecret = b64urlToBuf(keys.auth);
  if (uaPublic.length !== P256_PUBLIC_LEN) throw new Error('p256dh: chave pública P-256 inválida');
  if (authSecret.length !== KEY_LEN) throw new Error('auth: segredo precisa de 16 bytes');

  const ecdh = createECDH('prime256v1');
  if (opts.privateKey) ecdh.setPrivateKey(opts.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(SALT_LEN);
  if (salt.length !== SALT_LEN) throw new Error('salt: 16 bytes');

  return aes128gcmRecord({
    salt,
    ikm: webPushIkm({ shared, authSecret, uaPublic, asPublic }),
    // No Web Push o `keyid` do cabeçalho é a chave pública efêmera: é como o navegador refaz o ECDH.
    keyid: asPublic,
    plaintext: Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'),
  });
}
