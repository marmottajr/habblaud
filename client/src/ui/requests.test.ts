import { describe, expect, it } from 'vitest';
import type { ExternalRequestInfo } from '../../../shared/types';
import { currentRequest, orderedOptions, requestExpiryText, stepRequest } from './requests';

function req(id: string, over: Partial<ExternalRequestInfo> = {}): ExternalRequestInfo {
  return { id, source: 'painel', externalId: id, title: id, options: [{ id: 'a', label: 'A' }], createdAt: 0, expiresAt: 3_600_000, ...over };
}

describe('pedidos externos (cartão)', () => {
  it('mostra o atual enquanto existir; senão o mais antigo', () => {
    const list = [req('r1'), req('r2')];
    expect(currentRequest(list, 'r2')?.id).toBe('r2');
    expect(currentRequest(list, 'sumiu')?.id).toBe('r1');
    expect(currentRequest([], 'r1')).toBeUndefined();
  });

  it('‹ › dão a volta nas pontas', () => {
    const list = [req('r1'), req('r2'), req('r3')];
    expect(stepRequest(list, 'r3', 1)?.id).toBe('r1');
    expect(stepRequest(list, 'r1', -1)?.id).toBe('r3');
    expect(stepRequest(list, 'sumiu', 1)?.id).toBe('r2');
    expect(stepRequest([], 'r1', 1)).toBeUndefined();
  });

  it('a recomendada vem primeiro', () => {
    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    expect(orderedOptions({ options, recommended: 'c' }).map((o) => o.id)).toEqual(['c', 'a', 'b']);
    expect(orderedOptions({ options }).map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('prazo', () => {
    expect(requestExpiryText(1_000, 2_000)).toBe('expirando…');
    expect(requestExpiryText(30_000, 0)).toBe('expira em menos de 1 min');
    expect(requestExpiryText(5 * 60_000, 0)).toBe('expira em 5 min');
  });
});
