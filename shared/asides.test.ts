import { describe, expect, it } from 'vitest';
import { ASIDE_ANSWER_MAX, isFinalAside, parseAsideProgress } from './asides';

const SID = '123e4567-e89b-12d3-a456-426614174000';
const ok = { sessionId: SID, turnId: 'q-1', text: 'oi', state: 'running' };

describe('parseAsideProgress', () => {
  it('aceita um corpo válido', () => {
    expect(parseAsideProgress(ok)).toEqual(ok);
    expect(parseAsideProgress({ ...ok, state: 'failed', error: 'x' })).toEqual({ ...ok, state: 'failed', error: 'x' });
    expect(parseAsideProgress({ ...ok, text: '' })?.text).toBe('');
  });

  it('recusa cada campo inválido', () => {
    expect(parseAsideProgress(null)).toBeUndefined();
    expect(parseAsideProgress([])).toBeUndefined();
    expect(parseAsideProgress({ ...ok, sessionId: undefined })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, sessionId: 'abc' })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, turnId: '' })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, turnId: 'x'.repeat(201) })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, turnId: 5 })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, text: 5 })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, text: undefined })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, state: 'queued' })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, state: 1 })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, error: 1 })).toBeUndefined();
  });

  it('corta text e error nos limites', () => {
    const big = parseAsideProgress({ ...ok, text: 'a'.repeat(ASIDE_ANSWER_MAX + 10), state: 'failed', error: 'e'.repeat(900) });
    expect(big?.text.length).toBe(ASIDE_ANSWER_MAX);
    expect(big?.text.endsWith('\n…')).toBe(true);
    expect(big?.error?.length).toBe(500);
  });

  it('recusa sessionId com path traversal', () => {
    expect(parseAsideProgress({ ...ok, sessionId: '../x' })).toBeUndefined();
    expect(parseAsideProgress({ ...ok, sessionId: `${SID}/../x` })).toBeUndefined();
  });
});

describe('isFinalAside', () => {
  it('só complete, failed e cancelled são finais', () => {
    expect(['queued', 'running'].map((s) => isFinalAside(s as never))).toEqual([false, false]);
    expect(['complete', 'failed', 'cancelled'].map((s) => isFinalAside(s as never))).toEqual([true, true, true]);
  });
});
