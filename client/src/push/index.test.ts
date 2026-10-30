// Toque na notificação com a app já aberta: o service worker pede à página para ir ela própria ao caminho, porque no
// iPhone o `WindowClient.navigate()` não é de confiança. A decisão de ir, e a restrição à
// própria origem, vivem nesta função pura — é o que se pode prender sem navegador.
import { describe, expect, it } from 'vitest';
import { OPEN_MESSAGE, openRequestPath } from './index';

describe('openRequestPath', () => {
  it('aceita um caminho da própria origem', () => {
    expect(openRequestPath({ type: OPEN_MESSAGE, url: '/?app=1&gb=1' })).toBe('/?app=1&gb=1');
    expect(openRequestPath({ type: OPEN_MESSAGE, url: '/?app=1&agent=a-1' })).toBe('/?app=1&agent=a-1');
  });

  it('recusa o que não é a nossa mensagem', () => {
    expect(openRequestPath({ type: 'outra-coisa', url: '/?app=1' })).toBeUndefined();
    expect(openRequestPath({ url: '/?app=1' })).toBeUndefined();
    expect(openRequestPath('texto')).toBeUndefined();
    expect(openRequestPath(null)).toBeUndefined();
    expect(openRequestPath(undefined)).toBeUndefined();
  });

  it('recusa qualquer coisa que saia da própria origem', () => {
    for (const url of ['https://mau.pt/x', '//mau.pt/x', 'javascript:alert(1)', 'app=1', '']) {
      expect(openRequestPath({ type: OPEN_MESSAGE, url })).toBeUndefined();
    }
  });

  it('recusa um url que não é texto', () => {
    expect(openRequestPath({ type: OPEN_MESSAGE, url: 42 })).toBeUndefined();
    expect(openRequestPath({ type: OPEN_MESSAGE })).toBeUndefined();
  });

  it('o nome da mensagem é o mesmo dos dois lados', () => {
    // O `sw.js` não passa pelo bundler, logo a cadeia está escrita lá à mão: se mudar, muda nos dois.
    expect(OPEN_MESSAGE).toBe('habblaud-push-open');
  });
});
