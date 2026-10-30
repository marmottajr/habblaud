// Vetores de teste das RFCs da cifra do Web Push. Sem isto, um erro na derivação de chave só aparece como um push que
// o aparelho descarta em silêncio — o pior modo de falhar que este código tem.
import { createCipheriv, createDecipheriv, createECDH, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aes128gcmRecord, b64urlToBuf, encryptPayload, RECORD_SIZE, webPushIkm } from './encrypt';

/**
 * RFC 8291, seção 5 e apêndice A: o exemplo de ponta a ponta, copiado do texto da RFC.
 *
 * `body` é o corpo publicado na seção 5, e é o conhecido-resposta que importa: com estas entradas, o `encryptPayload`
 * tem de o reproduzir byte a byte. Os valores intermédios (`ecdhSecret`, `ikm`, `header`) são do apêndice A e dizem
 * em que passo está o erro quando o corpo não bate.
 */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function publicOf(privateKey: string): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64urlToBuf(privateKey));
  return ecdh.getPublicKey().toString('base64url');
}

/**
 * Decifra como o navegador decifra: do próprio cabeçalho do registro tira o sal e a chave pública efêmera, refaz o
 * ECDH do outro lado e redescobre a chave. Escrito aqui à parte de propósito — se `encrypt.ts` trocasse a ordem de
 * `ua_public` e `as_public` no `WebPush: info`, este caminho não abriria.
 */
function decryptAsBrowser(record: Buffer, uaPrivate: string, authSecret: string): string {
  const salt = record.subarray(0, 16);
  expect(record.readUInt32BE(16)).toBe(RECORD_SIZE);
  const idLen = record.readUInt8(20);
  const asPublic = record.subarray(21, 21 + idLen);
  const sealed = record.subarray(21 + idLen);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64urlToBuf(uaPrivate));
  const shared = ecdh.computeSecret(asPublic);
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  const hkdf = (s: Buffer, ikm: Buffer, info: Buffer, len: number) => hmac(hmac(s, ikm), Buffer.concat([info, Buffer.of(1)])).subarray(0, len);
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ecdh.getPublicKey(), asPublic]);
  const ikm = hkdf(b64urlToBuf(authSecret), shared, authInfo, 32);
  const key = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(0x02); // delimitador do último registro (RFC 8188 §2)
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('aes128gcm (RFC 8188)', () => {
  // Vetor do RFC 8188 §3.1: um registro só, sem keyid e sem ECDH pelo meio. Confere a camada de codificação de
  // conteúdo (HKDF, nonce, delimitador, cabeçalho) contra um valor publicado, independente do nosso código.
  it('reproduz o vetor do §3.1 byte a byte', () => {
    const record = aes128gcmRecord({
      salt: b64urlToBuf('I1BsxtFttlv3u_Oo94xnmw'),
      ikm: b64urlToBuf('yqdlZ-tYemfogSmv7Ws5PQ'),
      keyid: Buffer.alloc(0),
      plaintext: Buffer.from('I am the walrus', 'utf8'),
    });
    expect(record.toString('base64url')).toBe('I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg');
  });

  it('declara o tamanho de registro e o keyid no cabeçalho', () => {
    const record = aes128gcmRecord({ salt: Buffer.alloc(16, 7), ikm: Buffer.alloc(32, 9), keyid: Buffer.alloc(65, 4), plaintext: Buffer.from('x') });
    expect(record.readUInt32BE(16)).toBe(RECORD_SIZE);
    expect(record.readUInt8(20)).toBe(65);
    expect(record.length).toBe(16 + 4 + 1 + 65 + 1 + 1 + 16);
  });
});

describe('encryptPayload (RFC 8291)', () => {
  // As chaves do apêndice A conferem entre si: cada privada gera exatamente a pública publicada na RFC. Se um dos
  // valores acima tivesse sido copiado errado, este teste cai antes de qualquer conclusão sobre a cifra.
  it('as chaves do apêndice A são um par', () => {
    expect(publicOf(RFC8291.uaPrivate)).toBe(RFC8291.uaPublic);
    expect(publicOf(RFC8291.asPrivate)).toBe(RFC8291.asPublic);
  });

  it('o navegador decifra o que mandamos', () => {
    const record = encryptPayload(RFC8291.plaintext, { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
    expect(decryptAsBrowser(record, RFC8291.uaPrivate, RFC8291.authSecret)).toBe(RFC8291.plaintext);
  });

  // O conhecido-resposta que fecha a dúvida: com as entradas publicadas, o corpo tem de ser o corpo publicado.
  it('reproduz o corpo cifrado publicado na seção 5, byte a byte', () => {
    const record = encryptPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      { salt: b64urlToBuf(RFC8291.salt), privateKey: b64urlToBuf(RFC8291.asPrivate) },
    );
    expect(record.toString('base64url')).toBe(RFC8291.body);
    // 144 octetos: cabeçalho de 86, texto de 41, delimitador de 1, tag de 16. (A seção 5 da RFC anuncia
    // `Content-Length: 145` ao lado de um corpo que descodifica para 144; o corpo é que manda.)
    expect(record.length).toBe(144);
  });

  it('os valores intermédios do apêndice A batem, um por um', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(b64urlToBuf(RFC8291.asPrivate));
    const shared = ecdh.computeSecret(b64urlToBuf(RFC8291.uaPublic));
    expect(shared.toString('base64url')).toBe(RFC8291.ecdhSecret);
    const ikm = webPushIkm({
      shared,
      authSecret: b64urlToBuf(RFC8291.authSecret),
      uaPublic: b64urlToBuf(RFC8291.uaPublic),
      asPublic: b64urlToBuf(RFC8291.asPublic),
    });
    expect(ikm.toString('base64url')).toBe(RFC8291.ikm);
  });

  it('o cabeçalho de 86 octetos é o do apêndice A', () => {
    const record = encryptPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      { salt: b64urlToBuf(RFC8291.salt), privateKey: b64urlToBuf(RFC8291.asPrivate) },
    );
    expect(record.subarray(0, 86).toString('base64url')).toBe(RFC8291.header);
    expect(record.subarray(0, 16).toString('base64url')).toBe(RFC8291.salt);
    expect(record.subarray(21, 86).toString('base64url')).toBe(RFC8291.asPublic);
    expect(decryptAsBrowser(record, RFC8291.uaPrivate, RFC8291.authSecret)).toBe(RFC8291.plaintext);
  });

  it('cada envio troca o sal e a chave efêmera', () => {
    const a = encryptPayload('oi', { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
    const b = encryptPayload('oi', { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
    expect(a.subarray(0, 86).equals(b.subarray(0, 86))).toBe(false);
  });

  it('recusa chaves de inscrição fora do formato', () => {
    expect(() => encryptPayload('oi', { p256dh: 'curta', auth: RFC8291.authSecret })).toThrow(/p256dh/);
    expect(() => encryptPayload('oi', { p256dh: RFC8291.uaPublic, auth: 'curto' })).toThrow(/auth/);
  });
});

describe('AES-GCM', () => {
  // Trava o pressuposto de que a tag de 16 bytes vai no fim do corpo (é o que o navegador espera).
  it('a tag tem 16 bytes', () => {
    const c = createCipheriv('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12));
    c.update('x');
    c.final();
    expect(c.getAuthTag().length).toBe(16);
  });
});
