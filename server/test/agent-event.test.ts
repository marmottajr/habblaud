// scripts/agent-event.mjs: argumentos e envio (o fetch é falso; nada sai do processo).
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo .mjs sem tipos
import { DEFAULT_PORT, parseArgs, send, UsageError } from '../../scripts/agent-event.mjs';

const CWD = resolve('/projetos/loja');

describe('agent-event: parseArgs', () => {
  it('evento, ferramenta e os padrões (pasta atual, sessão por pasta, porta)', () => {
    const r = parseArgs(['start', '--tool', 'Grok'], {}, CWD);
    expect(r).toEqual({ body: { tool: 'grok', event: 'start', cwd: CWD, session: `grok:${CWD}` }, port: DEFAULT_PORT });
  });

  it('opções com espaço ou com =, input em JSON e a porta do ambiente', () => {
    const r = parseArgs(['activity', '--tool=grok', '--session', 'abc', '--kind', 'read', '--tool-name', 'Read', '--input={"file_path":"a.ts"}', '--text', 'Lendo'], { HABBLAUD_PORT: '5000' }, CWD);
    expect(r.port).toBe(5000);
    expect(r.body).toMatchObject({ session: 'abc', kind: 'read', toolName: 'Read', input: { file_path: 'a.ts' }, text: 'Lendo' });
  });

  it('pasta longa vira um hash na sessão padrão', () => {
    const long = resolve(`/${'p'.repeat(300)}`);
    const r = parseArgs(['idle', '--tool', 'grok'], {}, long);
    expect(r.body.session).toMatch(/^grok:[0-9a-f]{32}$/);
  });

  it('ajuda e erros de uso', () => {
    expect(parseArgs(['--help'])).toBe('help');
    expect(() => parseArgs([], {}, CWD)).toThrow(UsageError);
    expect(() => parseArgs(['voar', '--tool', 'grok'], {}, CWD)).toThrow(/evento desconhecido/);
    expect(() => parseArgs(['start'], {}, CWD)).toThrow(/--tool/);
    expect(() => parseArgs(['start', '--tool'], {}, CWD)).toThrow(/valor/);
    expect(() => parseArgs(['start', '--tool', 'g', '--input', '{x'], {}, CWD)).toThrow(/JSON/);
    expect(() => parseArgs(['start', '--tool', 'g', '--nada'], {}, CWD)).toThrow(/desconhecida/);
  });
});

describe('agent-event: send', () => {
  const body = { tool: 'grok', session: 's', event: 'idle', cwd: CWD };

  it('posta o evento em 127.0.0.1 e sai com 0', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const code = await send(body, 4747, () => {}, async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    });
    expect(code).toBe(0);
    expect(calls[0].url).toBe('http://127.0.0.1:4747/api/external/events');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body);
  });

  it('Habblaud fora do ar: avisa e sai com 0 (o hook nunca quebra a ferramenta)', async () => {
    const errs: string[] = [];
    const code = await send(body, 4747, (m: string) => errs.push(m), async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(code).toBe(0);
    expect(errs[0]).toMatch(/ECONNREFUSED/);
  });

  it('evento recusado: mostra o motivo e sai com 2', async () => {
    const errs: string[] = [];
    const code = await send(body, 4747, (m: string) => errs.push(m), async () => new Response('{"error":"cwd ausente"}', { status: 400 }));
    expect(code).toBe(2);
    expect(errs[0]).toMatch(/HTTP 400.*cwd ausente/);
  });
});
