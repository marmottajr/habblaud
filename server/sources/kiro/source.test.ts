import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectKiroAccount, discoverKiroDir } from './accounts';
import { describeKiroTool, parseKiroJsonlLine } from './parser';
import { KiroWatcher, pidAlive } from './watcher';
import { Office } from '../../model/office';
import { NameStore } from '../../model/names';

describe('Kiro integration', () => {
  it('detecta a conta do Kiro com atributos esperados', () => {
    const acc = detectKiroAccount('/tmp/.kiro');
    expect(acc.id).toBe('.kiro');
    expect(acc.provider).toBe('kiro');
    expect(acc.short).toBe('K');
    expect(acc.name).toBe('Kiro');
    expect(acc.color).toBe('#7c3aed');
    expect(acc.plan).toBeUndefined();
  });

  it('detecta plano e email via variáveis de ambiente', () => {
    const acc = detectKiroAccount('/tmp/.kiro', {
      HABBLAUD_KIRO_PLAN: 'KIRO PRO MAX',
      HABBLAUD_KIRO_EMAIL: 'dev@empresa.com',
    } as unknown as NodeJS.ProcessEnv);
    expect(acc.plan).toBe('KIRO PRO MAX');
    expect(acc.email).toBe('dev@empresa.com');
  });

  it('detecta plano lendo o arquivo plan na pasta da conta', () => {
    const dir = join(tmpdir(), `kiro-acc-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan'), 'PRO MAX\n');

    try {
      const acc = detectKiroAccount(dir, {});
      expect(acc.plan).toBe('PRO MAX');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detecta plano e email lendo settings/plan.json', () => {
    const dir = join(tmpdir(), `kiro-acc-json-${Date.now()}`);
    const settingsDir = join(dir, 'settings');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'plan.json'), JSON.stringify({ plan: 'PRO', email: 'user@test.org' }));

    try {
      const acc = detectKiroAccount(dir, {});
      expect(acc.plan).toBe('PRO');
      expect(acc.email).toBe('user@test.org');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('parser de eventos do Kiro', () => {
    it('mapeia evento de Prompt', () => {
      const line = JSON.stringify({
        version: 'v1',
        kind: 'Prompt',
        data: {
          content: [{ kind: 'text', data: 'Liste os arquivos da pasta' }],
          meta: { timestamp: 1700000000 },
        },
      });
      const parsed = parseKiroJsonlLine(line, 1, 1000);
      expect(parsed).toBeDefined();
      expect(parsed?.status).toBe('working');
      expect(parsed?.activity?.kind).toBe('prompt');
      expect(parsed?.activity?.icon).toBe('📨');
      expect(parsed?.activity?.detail).toContain('Liste os arquivos');
      // meta.timestamp vem em segundos
      expect(parsed?.activity?.at).toBe(1700000000 * 1000);
    });

    it('AssistantMessage só com thinking fecha o turno (é a última do turno)', () => {
      const line = JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          content: [{ kind: 'thinking', data: { text: '' } }],
        },
      });
      const parsed = parseKiroJsonlLine(line, 2, 1000);
      expect(parsed).toBeDefined();
      expect(parsed?.status).toBe('idle');
      expect(parsed?.turnEnd).toBe(true);
      expect(parsed?.activities).toEqual([]);
    });

    it('mapeia evento de toolUse shell com comando comum', () => {
      const line = JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          content: [
            {
              kind: 'toolUse',
              data: {
                toolUseId: 'call_1',
                name: 'shell',
                input: {
                  command: 'ls -la',
                  __tool_use_purpose: 'Listar arquivos',
                },
              },
            },
          ],
        },
      });
      const parsed = parseKiroJsonlLine(line, 3, 1000);
      expect(parsed).toBeDefined();
      expect(parsed?.status).toBe('working');
      expect(parsed?.activity?.tool).toBe('shell');
      // O texto sai da mesma heurística do Bash do Claude Code; o "para quê" do Kiro vai para o detalhe.
      expect(parsed?.activity?.detail).toContain('ls -la');
      expect(parsed?.activity?.detail).toContain('Listar arquivos');
      expect(parsed?.tools).toEqual([{ id: 'call_1', name: 'shell', label: parsed?.activity?.text }]);
    });

    it('mapeia evento de toolUse shell com testes', () => {
      const line = JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          content: [
            {
              kind: 'toolUse',
              data: {
                toolUseId: 'call_2',
                name: 'shell',
                input: {
                  command: 'npm test',
                },
              },
            },
          ],
        },
      });
      const parsed = parseKiroJsonlLine(line, 4, 1000);
      expect(parsed?.activity?.kind).toBe('test');
      expect(parsed?.activity?.icon).toBe('🧪');
    });

    it('mapeia evento de resposta final pura para idle', () => {
      const line = JSON.stringify({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          content: [{ kind: 'text', data: 'Aqui está o resultado da análise.' }],
        },
      });
      const parsed = parseKiroJsonlLine(line, 5, 1000);
      expect(parsed?.status).toBe('idle');
      expect(parsed?.activity?.kind).toBe('respond');
      expect(parsed?.activity?.icon).toBe('💬');
    });
  });

  describe('watcher de sessões vivas', () => {
    it('detecta vivacidade pelo PID do processo atual', () => {
      expect(pidAlive(process.pid)).toBe(true);
      expect(pidAlive(99999999)).toBe(false);
    });

    it('reconhece sessão e adiciona a sala no Office', () => {
      const tmp = join(tmpdir(), `kiro-test-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });

      try {
        const names = new NameStore(join(tmp, 'names.json'));
        names.load();
        const office = new Office({
          names,
          version: '0.11.0',
          startedAt: Date.now(),
          accounts: () => [],
          sources: () => [],
          accountName: () => 'Kiro',
        });

        const sessionId = 'test-session-123';
        const projectDir = '/Users/gihovani.demetrio/www/hsb-webview';

        // Cria os arquivos .lock e .json mockados
        writeFileSync(
          join(tmp, `${sessionId}.lock`),
          JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })
        );
        writeFileSync(
          join(tmp, `${sessionId}.json`),
          JSON.stringify({
            session_id: sessionId,
            cwd: projectDir,
            title: 'Revisando hsb-webview',
            session_state: {
              conversation_metadata: {
                user_turn_metadatas: [
                  { loop_id: { agent_id: { name: 'kiro_frontend' } } },
                ],
              },
            },
          })
        );

        const watcher = new KiroWatcher({
          office,
          sessionsDir: tmp,
          now: () => Date.now(),
          // o PID do lock é o do próprio vitest (não é um kiro-cli): só o kill(pid, 0)
          checkPid: true,
        });

        // Executa uma varredura
        watcher.scan();

        const agents = office.list();
        expect(agents.length).toBe(1);
        expect(agents[0].id).toBe(sessionId);
        expect(agents[0].provider).toBe('kiro');
        expect(agents[0].roomId).toBe(projectDir);
        expect(agents[0].role).toBe('frontend');

        const snapshot = office.commit().snapshot;
        expect(snapshot.rooms.some((r) => r.path === projectDir)).toBe(true);

        watcher.stop();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('inicia observador graciosamente mesmo se diretório ainda não existe', () => {
      const tmp = join(tmpdir(), `kiro-nonexistent-${Date.now()}`);
      const names = new NameStore(join(tmpdir(), `names-${Date.now()}.json`));
      const office = new Office({
        names,
        version: '0.11.0',
        startedAt: Date.now(),
        accounts: () => [],
        sources: () => [],
        accountName: () => 'Kiro',
      });

      const watcher = new KiroWatcher({
        office,
        sessionsDir: tmp,
        now: () => Date.now(),
      });

      expect(() => watcher.start()).not.toThrow();
      expect(watcher.sessionCount()).toBe(0);
      watcher.stop();
    });

    it('ignora sessões com locks antigos quando no Docker (inDocker: true)', () => {
      const tmp = join(tmpdir(), `kiro-stale-${Date.now()}`);
      mkdirSync(tmp, { recursive: true });
      const names = new NameStore(join(tmpdir(), `names-${Date.now()}.json`));
      const office = new Office({
        names,
        version: '0.11.0',
        startedAt: Date.now(),
        accounts: () => [],
        sources: () => [],
        accountName: () => 'Kiro',
      });

      try {
        const sessionId = 'stale-uuid-123';
        const lockPath = join(tmp, `${sessionId}.lock`);
        writeFileSync(lockPath, JSON.stringify({ pid: 1234, started_at: new Date(Date.now() - 24 * 3600_000).toISOString() }));
        writeFileSync(join(tmp, `${sessionId}.json`), JSON.stringify({ cwd: '/test/stale' }));

        const now = Date.now();
        // Simula lock com mtime de 15 horas atrás
        const watcher = new KiroWatcher({
          office,
          sessionsDir: tmp,
          inDocker: true,
          now: () => now + 15 * 3600_000,
        });

        watcher.scan();
        expect(watcher.sessionCount()).toBe(0);
        watcher.stop();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
