import { describe, expect, it } from 'vitest';
import { createDshTerminalParser } from './terminal';

const line = (o: unknown) => JSON.stringify(o);

describe('DshTerminalParser', () => {
  it('converte prompt, raciocínio, texto, ferramenta e resultado', () => {
    const p = createDshTerminalParser();
    const out = [
      line({ type: 'session', cwd: 'D:\\proj' }),
      line({ type: 'user/message', seq: 1, time: '2026-01-01T00:00:00Z', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'oi<system-reminder>x</system-reminder>' }] } }),
      line({
        type: 'assistant/message',
        seq: 2,
        time: '2026-01-01T00:00:01Z',
        data: { message: { content: [{ type: 'reasoning', text: 'pensando' }, { type: 'text', text: 'olá' }, { type: 'tool-call', id: 't1', name: 'pwsh', arguments: '{"command":"dir"}' }] } },
      }),
      line({ type: 'tool/call', seq: 3, data: { callId: 't1', name: 'pwsh', arguments: '{"command":"dir"}' } }),
      line({ type: 'tool/result', seq: 4, data: { message: { toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] } } }),
    ].flatMap((l) => p.push(l));
    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'assistant', 'tool', 'result']);
    const tool = out.find((e) => e.kind === 'tool') as { tool?: string; input?: string };
    expect(tool.tool).toBe('Bash');
    expect(tool.input).toBe('dir');
  });

  it('ignora linhas que não são JSON', () => {
    expect(createDshTerminalParser().push('lixo')).toEqual([]);
  });
});
