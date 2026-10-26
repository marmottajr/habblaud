// Teste do cache de sprites: ao encher, descarta só os mais antigos.
import { describe, expect, it } from 'vitest';
import { Cache } from './cache';

describe('Cache', () => {
  it('acerto não chama make de novo', () => {
    const c = new Cache<number>(8);
    let calls = 0;
    const make = () => ++calls;
    expect(c.get('a', make)).toBe(1);
    expect(c.get('a', make)).toBe(1);
    expect(calls).toBe(1);
  });

  it('ao encher descarta só a quarta parte mais antiga', () => {
    const c = new Cache<number>(8);
    const calls: Record<string, number> = {};
    const get = (k: string) => c.get(k, () => (calls[k] = (calls[k] ?? 0) + 1));
    for (const k of 'abcdefgh') get(k);
    get('i');
    expect(c.size).toBe(7);
    get('c');
    get('h');
    expect(calls.c).toBe(1);
    expect(calls.h).toBe(1);
    get('a');
    get('b');
    expect(calls.a).toBe(2);
    expect(calls.b).toBe(2);
  });

  it('limite 1: cada chave nova substitui a anterior', () => {
    const c = new Cache<number>(1);
    for (const k of 'abcd') {
      c.get(k, () => 0);
      expect(c.size).toBe(1);
    }
  });
});
