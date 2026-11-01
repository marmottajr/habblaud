// A notificação chega à tela de bloqueio de um telefone que anda na rua. Estes testes existem para o texto do aviso
// do escritório (que leva o motivo, o caminho da pasta e o que o agente ia fazer) nunca atravessar para lá.
import { describe, expect, it } from 'vitest';
import type { Notice } from '../../shared/types';
import { NEEDS_YOU, noticePush } from './notices';

const names: Record<string, string> = { 'a-1': 'Ana 2' };
const nameOf = (id: string): string | undefined => names[id];

function notice(over: Partial<Notice> = {}): Notice {
  return { id: 'n1', level: 'alert', text: '✋ Ana 2 precisa de você em cliente-acme: apagar /tmp/dados', agentId: 'a-1', roomId: 'cliente-acme', at: 1, ...over };
}

describe('noticePush', () => {
  it('monta o título só com o nome do agente', () => {
    expect(noticePush(notice(), nameOf)?.title).toBe('Ana 2 precisa de você');
  });

  it('sem agente conhecido, usa o molde genérico', () => {
    expect(noticePush(notice({ agentId: 'desconhecido' }), nameOf)?.title).toBe('Um agente precisa de você');
    expect(noticePush(notice({ agentId: undefined }), nameOf)?.title).toBe('Um agente precisa de você');
  });

  it('só nível alert vira push', () => {
    for (const level of ['info', 'success', 'warn'] as const) expect(noticePush(notice({ level }), nameOf)).toBeUndefined();
    expect(noticePush(notice({ level: 'alert' }), nameOf)).toBeTruthy();
  });

  it('o título segue o molde fechado, sempre', () => {
    const textos = [
      'apagar /tmp/dados',
      'rm -rf /',
      'enviar email a cliente@exemplo.pt',
      'CREDENCIAL=abc123',
      'o João tem consulta às 15h',
      'pedido 4821 do cliente',
    ];
    for (const text of textos) {
      for (const roomId of ['cliente-acme', 'projeto-secreto', undefined]) {
        const push = noticePush(notice({ text, roomId }), nameOf);
        expect(push).toBeTruthy();
        // O molde: nome do agente (ou o genérico) seguido de "precisa de você". Nada mais.
        expect(push!.title).toMatch(/^(Ana 2|Um agente) precisa de você$/);
        expect(push!.title).not.toContain(text);
        if (roomId) expect(push!.title).not.toContain(roomId);
      }
    }
  });

  it('o caminho de abertura leva só o id do agente, escapado', () => {
    expect(noticePush(notice(), nameOf)?.url).toBe('/?app=1&agent=a-1');
    expect(noticePush(notice({ agentId: 'a b&c=1' }), nameOf)?.url).toBe('/?app=1&agent=a%20b%26c%3D1');
    expect(noticePush(notice({ agentId: undefined }), nameOf)?.url).toBe('/?app=1');
    // Sempre caminho da própria origem: nada de esquema, nada de `//`.
    for (const id of ['https://mau.pt/x', '//mau.pt/x', 'javascript:alert(1)']) {
      const url = noticePush(notice({ agentId: id }), nameOf)!.url;
      expect(url.startsWith('/?app=1&agent=')).toBe(true);
      expect(url).not.toContain('//');
    }
  });

  it('o freio agrupa por agente', () => {
    expect(noticePush(notice(), nameOf)?.key).toBe('a-1');
    expect(noticePush(notice({ agentId: undefined }), nameOf)?.key).toBe('sem-agente');
  });

  it('o id do tipo é o que o upstream registra', () => {
    expect(NEEDS_YOU).toBe('needs-you');
  });
});
