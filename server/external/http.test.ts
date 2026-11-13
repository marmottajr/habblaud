// Validação do corpo de POST /api/external/events.
import { describe, expect, it } from 'vitest';
import { HttpError } from '../http/app';
import { parseExternalEvent } from './http';

function err(raw: unknown): string {
  try {
    parseExternalEvent(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return (e as Error).message;
  }
  throw new Error('esperava recusa');
}

describe('parseExternalEvent', () => {
  it('aceita o mínimo e normaliza a ferramenta', () => {
    expect(parseExternalEvent({ tool: 'Grok', session: 's1', event: 'start', cwd: '/p' })).toEqual({ tool: 'grok', session: 's1', event: 'start', cwd: '/p' });
  });

  it('aceita caminho do Windows no cwd', () => {
    expect(parseExternalEvent({ tool: 'grok', session: 's', event: 'idle', cwd: 'C:\\Users\\x\\proj' }).cwd).toBe('C:\\Users\\x\\proj');
  });

  it('leva os campos opcionais; input só com toolName', () => {
    const ev = parseExternalEvent({
      tool: 'grok',
      toolLabel: 'Grok',
      session: 's',
      event: 'activity',
      title: 't',
      model: 'm',
      text: 'x',
      kind: 'run',
      detail: 'd',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(ev).toMatchObject({ toolLabel: 'Grok', title: 't', model: 'm', text: 'x', kind: 'run', detail: 'd', toolName: 'Bash', input: { command: 'ls' } });
    expect(parseExternalEvent({ tool: 'grok', session: 's', event: 'idle', input: { a: 1 } }).input).toBeUndefined();
  });

  it('recusa o que não serve', () => {
    expect(err(null)).toMatch(/objeto JSON/);
    expect(err({ session: 's', event: 'start' })).toMatch(/tool/);
    expect(err({ tool: 'Grok Bot', session: 's', event: 'start' })).toMatch(/tool/);
    expect(err({ tool: 'codex', session: 's', event: 'start' })).toMatch(/suporte próprio/);
    expect(err({ tool: 'claude', session: 's', event: 'start' })).toMatch(/suporte próprio/);
    expect(err({ tool: 'grok', event: 'start' })).toMatch(/session/);
    expect(err({ tool: 'grok', session: 's', event: 'explodir' })).toMatch(/event/);
    expect(err({ tool: 'grok', session: 's', event: 'start', cwd: 'relativo' })).toMatch(/absoluto/);
    expect(err({ tool: 'grok', session: 's', event: 'activity', kind: 'dançar' })).toMatch(/kind/);
    expect(err({ tool: 'grok', session: 's', event: 'start', title: 5 })).toMatch(/texto/);
    expect(err({ tool: 'grok', session: 'x'.repeat(201), event: 'start' })).toMatch(/200/);
  });
});
