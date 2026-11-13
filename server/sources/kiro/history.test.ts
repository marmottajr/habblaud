import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isKiroSessionId, KiroHistory } from './history';

describe('KiroHistory', () => {
  it('valida formato de id de sessão (sem path traversal)', () => {
    expect(isKiroSessionId('session-123')).toBe(true);
    expect(isKiroSessionId('12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(isKiroSessionId('kiro_session_v1')).toBe(true);
    expect(isKiroSessionId('../escapa')).toBe(false);
    expect(isKiroSessionId('session/barra')).toBe(false);
    expect(isKiroSessionId('')).toBe(false);
  });

  it('hasAccount reconhece .kiro e contas cadastradas', () => {
    const history = new KiroHistory({
      accounts: () => [{ id: 'conta-kiro', dir: '/tmp' }],
      openAgentOf: () => undefined,
    });
    expect(history.hasAccount('.kiro')).toBe(true);
    expect(history.hasAccount('conta-kiro')).toBe(true);
    expect(history.hasAccount('outra-conta')).toBe(false);
  });

  it('resolve() devolve 400 para id inválido e 404 para inexistente', () => {
    const history = new KiroHistory({
      accounts: () => [{ id: '.kiro', dir: '/tmp' }],
      openAgentOf: () => undefined,
    });
    expect(history.resolve('.kiro', '../invalid')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(history.resolve('desconhecida', 'valid-id')).toEqual({ status: 404, error: 'conta desconhecida' });
    expect(history.resolve('.kiro', 'sessao-que-nao-existe')).toEqual({ status: 404, error: 'sessão não encontrada' });
  });

  it('lista e resolve sessões a partir do diretório de sessões', async () => {
    const base = join(tmpdir(), `kiro-hist-${Date.now()}`);
    const sessionsDir = join(base, 'sessions', 'cli');
    mkdirSync(sessionsDir, { recursive: true });

    try {
      const sid1 = 'session-alpha-1';
      const sid2 = 'session-beta-2';

      writeFileSync(
        join(sessionsDir, `${sid1}.json`),
        JSON.stringify({
          session_id: sid1,
          cwd: '/Users/test/projeto-a',
          title: 'Refatorando banco',
          started_at: new Date(1700000000000).toISOString(),
        }),
      );
      writeFileSync(
        join(sessionsDir, `${sid1}.jsonl`),
        JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'Refatorando banco' }] } }) + '\n',
      );

      writeFileSync(
        join(sessionsDir, `${sid2}.json`),
        JSON.stringify({
          session_id: sid2,
          cwd: '/Users/test/projeto-b',
          title: 'Criando testes',
          started_at: new Date(1700000050000).toISOString(),
        }),
      );
      writeFileSync(
        join(sessionsDir, `${sid2}.jsonl`),
        JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'Criando testes' }] } }) + '\n',
      );

      const history = new KiroHistory({
        accounts: () => [{ id: '.kiro', dir: base }],
        openAgentOf: (acc, sid) => (sid === sid1 ? 'agente-1' : undefined),
        dir: base,
      });

      // Testa listagem
      const list = await history.list();
      expect(list.length).toBe(2);
      expect(list.some((s) => s.sessionId === sid1)).toBe(true);
      expect(list.some((s) => s.sessionId === sid2)).toBe(true);

      const s1 = list.find((s) => s.sessionId === sid1)!;
      expect(s1.account).toBe('.kiro');
      expect(s1.provider).toBe('kiro');
      expect(s1.project).toBe('/Users/test/projeto-a');
      expect(s1.title).toBe('Refatorando banco');
      expect(s1.open).toBe(true);
      expect(s1.agentId).toBe('agente-1');

      const s2 = list.find((s) => s.sessionId === sid2)!;
      expect(s2.open).toBe(false);
      expect(s2.title).toBe('Criando testes');

      // Testa resolve
      const resolved = history.resolve('.kiro', sid1);
      expect('path' in resolved).toBe(true);
      if ('path' in resolved) {
        expect(resolved.path).toBe(realpathSync(join(sessionsDir, `${sid1}.jsonl`)));
        const parser = resolved.createParser();
        expect(typeof parser.push).toBe('function');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('lista e resolve sessões do 3.x (sessions/<hash>/<id>/session.json + messages.jsonl)', async () => {
    const base = join(tmpdir(), `kiro-hist-v3-${Date.now()}`);
    const sid = 'cli_00000000-0000-4000-8000-000000000001_abc';
    const semTitulo = 'sess_00000000-0000-4000-8000-000000000002';
    const d1 = join(base, 'sessions', 'hashfalso1', sid);
    const d2 = join(base, 'sessions', 'hashfalso2', semTitulo);
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    // sem messages.jsonl: não entra
    mkdirSync(join(base, 'sessions', 'hashfalso1', 'sess_vazia'), { recursive: true });
    const line = (payload: Record<string, unknown>) =>
      JSON.stringify({ id: 'm1', timestamp: '2026-01-02T03:04:05.000Z', payload }) + '\n';

    try {
      writeFileSync(
        join(d1, 'session.json'),
        JSON.stringify({
          id: sid,
          title: 'Sessão de teste',
          agentMode: 'padrao',
          workspacePaths: ['/tmp/projeto-falso'],
          createdAt: '2026-01-02T03:00:00.000Z',
          lastModifiedAt: '2026-01-02T03:05:00.000Z',
          modelId: 'modelo-falso',
        }),
      );
      writeFileSync(join(d1, 'messages.jsonl'), line({ type: 'user', content: 'Oi' }) + line({ type: 'assistant', content: 'Olá', operationType: 'Say' }));
      writeFileSync(join(d2, 'session.json'), JSON.stringify({ id: semTitulo, workspacePaths: ['/tmp/outro'] }));
      writeFileSync(join(d2, 'messages.jsonl'), line({ type: 'user', content: 'Primeiro pedido' }));

      const history = new KiroHistory({ accounts: () => [{ id: '.kiro', dir: base }], openAgentOf: () => undefined, dir: base });
      const list = await history.list();
      expect(list.map((s) => s.sessionId).sort()).toEqual([sid, semTitulo].sort());

      const s1 = list.find((s) => s.sessionId === sid)!;
      expect(s1).toMatchObject({ account: '.kiro', provider: 'kiro', project: '/tmp/projeto-falso', title: 'Sessão de teste', open: false });
      expect(s1.firstAt).toBe(Date.parse('2026-01-02T03:00:00.000Z'));
      expect(list.find((s) => s.sessionId === semTitulo)!.title).toBe('Primeiro pedido');

      // reabrir a sessão encerrada: messages.jsonl + parser que entende o 3.x
      const r = history.resolve('.kiro', sid);
      expect('path' in r).toBe(true);
      if ('path' in r) {
        expect(r.path).toBe(realpathSync(join(d1, 'messages.jsonl')));
        const [e] = r.createParser().push(line({ type: 'user', content: 'Oi' }).trim());
        expect(e).toMatchObject({ kind: 'user', text: 'Oi' });
      }
      expect(history.resolve('.kiro', 'sess_vazia')).toEqual({ status: 404, error: 'sessão não encontrada' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
