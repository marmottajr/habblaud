import { describe, expect, it } from 'vitest';
import { parseOmpEvent } from './omp-events';

const base = { sessionId: 's1', at: 1 };

describe('parseOmpEvent: models', () => {
  it('aceita models em session_start, descarta itens grandes ou não-texto e limita a 200', () => {
    const models = ['a/b', 'x'.repeat(201), 5, ...Array.from({ length: 300 }, (_, i) => `p/m${i}`)];
    const ev = parseOmpEvent({ ...base, event: 'session_start', models });
    expect(ev?.models?.[0]).toBe('a/b');
    expect(ev?.models?.includes('x'.repeat(201))).toBe(false);
    // o corte de 200 vem antes do filtro: 3 itens iniciais + 197 válidos, 2 deles inválidos
    expect(ev!.models!.length).toBe(198);
  });

  it('aceita models no heartbeat e ignora nos outros eventos', () => {
    expect(parseOmpEvent({ ...base, event: 'heartbeat', models: ['a/b'] })?.models).toEqual(['a/b']);
    expect(parseOmpEvent({ ...base, event: 'agent_start', models: ['a/b'] })?.models).toBeUndefined();
  });
});
