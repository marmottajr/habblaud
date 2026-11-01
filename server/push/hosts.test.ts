// A lista de anfitriões e a validação do endpoint. É aqui que se fecham os dois achados sérios da revisão de
// 2026-10-29: o endpoint deformado que derrubava o processo e o endpoint arbitrário que fazia da
// inscrição um canal de saída e uma sonda da rede interna.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_HOSTS, isWellFormedEndpoint, parsePushEndpoint, parsePushHosts, SEND_TIMEOUT_MS } from './hosts';

describe('parsePushEndpoint', () => {
  it('aceita os serviços de push dos três navegadores', () => {
    expect(parsePushEndpoint('https://web.push.apple.com/abc123')).toBeTruthy();
    expect(parsePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBeTruthy();
    expect(parsePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBeTruthy();
  });

  it('NUNCA lança, nem com a entrada que derrubava o processo', () => {
    // `/^https:\/\/[^\s]+$/.test('https://[')` dava true e o `new URL` que vinha depois estourava fora de um try.
    for (const mau of ['https://[', 'https://', 'https://:80', 'https://[::1', 'https://%', 'https://a b']) {
      expect(() => parsePushEndpoint(mau)).not.toThrow();
      expect(parsePushEndpoint(mau)).toBeUndefined();
    }
  });

  it('recusa um anfitrião fora da lista, incluindo a rede interna', () => {
    expect(parsePushEndpoint('https://192.0.2.1/x')).toBeUndefined();
    expect(parsePushEndpoint('https://127.0.0.1:4747/api/push/test')).toBeUndefined();
    expect(parsePushEndpoint('https://exemplo.pt/push')).toBeUndefined();
    expect(parsePushEndpoint('https://192.0.2.1/')).toBeUndefined();
  });

  it('recusa um anfitrião que só parece ser da lista', () => {
    // Sufixo com ponto à frente: `maupush.apple.com.mau.pt` e `push.apple.com.mau.pt` não passam.
    expect(parsePushEndpoint('https://web.push.apple.com.mau.pt/x')).toBeUndefined();
    expect(parsePushEndpoint('https://maupush.apple.com/x')).toBeUndefined();
    expect(parsePushEndpoint('https://fcm.googleapis.com.mau.pt/x')).toBeUndefined();
  });

  it('recusa o que não é https', () => {
    expect(parsePushEndpoint('http://web.push.apple.com/x')).toBeUndefined();
    expect(parsePushEndpoint('file:///etc/passwd')).toBeUndefined();
    expect(parsePushEndpoint('javascript:alert(1)')).toBeUndefined();
  });

  it('recusa o que não é texto, o vazio e o comprido demais', () => {
    for (const mau of [undefined, null, 42, {}, [], '', `https://web.push.apple.com/${'x'.repeat(1100)}`]) {
      expect(parsePushEndpoint(mau as unknown)).toBeUndefined();
    }
  });

  it('recusa espaços e caracteres de controlo (cabeçalhos partidos)', () => {
    expect(parsePushEndpoint('https://web.push.apple.com/a\nb')).toBeUndefined();
    expect(parsePushEndpoint('https://web.push.apple.com/a\u0000b')).toBeUndefined();
    expect(parsePushEndpoint(' https://web.push.apple.com/a')).toBeUndefined();
  });

  it('a lista alargada pelo ambiente passa a valer', () => {
    const hosts = parsePushHosts('push.exemplo.pt');
    expect(parsePushEndpoint('https://push.exemplo.pt/x', hosts)).toBeTruthy();
    expect(parsePushEndpoint('https://push.exemplo.pt/x')).toBeUndefined();
    // Os de omissão continuam a valer com a lista alargada.
    expect(parsePushEndpoint('https://web.push.apple.com/x', hosts)).toBeTruthy();
  });

  it('a lista do ambiente vazia ou com lixo não altera nada', () => {
    expect(parsePushHosts(undefined)).toEqual([...DEFAULT_PUSH_HOSTS]);
    expect(parsePushHosts('  ,, ')).toEqual([...DEFAULT_PUSH_HOSTS]);
  });
});

describe('isWellFormedEndpoint', () => {
  it('só confere a forma: é o que a leitura do ficheiro usa', () => {
    // Um anfitrião fora da lista tem forma válida; quem o recusa é a lista, no envio e na inscrição.
    expect(isWellFormedEndpoint('https://exemplo.pt/x')).toBe(true);
    expect(isWellFormedEndpoint('https://[')).toBe(false);
    expect(isWellFormedEndpoint('http://exemplo.pt/x')).toBe(false);
    expect(isWellFormedEndpoint(42)).toBe(false);
  });
});

describe('prazo de envio', () => {
  it('é de dez segundos, não o do undici', () => {
    expect(SEND_TIMEOUT_MS).toBe(10_000);
  });
});
