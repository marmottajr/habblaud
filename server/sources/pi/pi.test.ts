// Testes da fonte do Pi coding agent: descoberta de contas, parser de sessão JSONL, terminal,
// histórico (inclusive path traversal) e PiSource (arquivos + eventos ao vivo da extensão).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { detectPiAccounts, discoverPiDirs, isPiAgentDir, piDirId } from './accounts';
import { isPiSessionId, parsePiSessionName } from './files';
import { PiHistory } from './history';
import { createPiState, parsePiLine } from './session';
import { PiSource } from './source';
import { createPiTerminalParser } from './terminal';

const temps: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-pi-'));
  temps.push(d);
  return d;
}

afterEach(() => {
  while (temps.length) {
    try {
      rmSync(temps.pop()!, { recursive: true, force: true });
    } catch {
      // ignora
    }
  }
});

function makeOffice(dataDir: string, accounts: AccountsService, now: () => number): Office {
  const names = new NameStore(join(dataDir, 'names.json'));
  return new Office({
    names,
    version: '1.0.0-test',
    startedAt: now(),
    accounts: (sessions) => accounts.list(sessions),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
}

function makePiTree(home: string): { piDir: string; sessionFile: string; sessionId: string; cwd: string } {
  const piDir = join(home, '.pi', 'agent');
  const cwd = join(home, 'CODE', 'demo-app');
  const projDir = join(piDir, 'sessions', '--home-user-CODE-demo-app--');
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(piDir, 'extensions'), { recursive: true });
  const sessionId = '01a20940-c9e7-7187-8e4b-4e6797c7229f';
  const sessionFile = join(projDir, `2026-11-23T16-32-50-665Z_${sessionId}.jsonl`);
  return { piDir, sessionFile, sessionId, cwd };
}

describe('Pi accounts & files', () => {
  it('descobre ~/.pi/agent e gera id legível (.pi)', () => {
    const home = makeTmp();
    const { piDir } = makePiTree(home);
    expect(isPiAgentDir(piDir)).toBe(true);
    expect(discoverPiDirs({}, home)).toEqual([piDir]);
    expect(piDirId(piDir)).toBe('.pi');
    const accs = detectPiAccounts([piDir], { home, env: {} });
    expect(accs).toHaveLength(1);
    expect(accs[0]).toMatchObject({ id: '.pi', provider: 'pi', short: 'P', name: 'Pi' });
  });

  it('valida nomes e ids de sessão do Pi', () => {
    expect(parsePiSessionName('2026-11-23T16-32-50-665Z_01a20940-c9e7-7187-8e4b-4e6797c7229f.jsonl')).toEqual({
      sessionId: '01a20940-c9e7-7187-8e4b-4e6797c7229f',
    });
    expect(parsePiSessionName('not-a-session.txt')).toBeUndefined();
    expect(isPiSessionId('01a20940-c9e7-7187-8e4b-4e6797c7229f')).toBe(true);
    expect(isPiSessionId('../etc/passwd')).toBe(false);
  });
});

describe('Pi JSONL parser & terminal parser', () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-123456', timestamp: '2026-11-23T16:32:50.000Z', cwd: '/proj/app' }),
    JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-11-23T16:32:51.000Z', provider: 'ollama', modelId: 'qwen3.8-flash' }),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: 'm1',
      timestamp: '2026-11-23T16:33:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Rode os testes do projeto' }] },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-11-23T16:33:05.000Z',
      message: {
        role: 'assistant',
        model: 'qwen3.8-flash',
        content: [
          { type: 'thinking', thinking: 'Vou rodar npm test' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'npm test' } },
        ],
        usage: { input: 1000, output: 120, cacheRead: 200, cacheWrite: 50, cost: { total: 0.015 } },
        stopReason: 'toolUse',
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'tr1',
      parentId: 'a1',
      timestamp: '2026-11-23T16:33:08.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'all 12 tests passed' }],
        isError: false,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a2',
      parentId: 'tr1',
      timestamp: '2026-11-23T16:33:12.000Z',
      message: {
        role: 'assistant',
        model: 'qwen3.8-flash',
        content: [{ type: 'text', text: 'Todos os 12 testes passaram!' }],
        usage: { input: 500, output: 40, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.005 } },
        stopReason: 'stop',
        durationMs: 4000,
      },
    }),
  ];

  it('extrai modelo, título, tokens, custo, shells e status', () => {
    const state = createPiState();
    const statuses: string[] = [];
    let shellCountAfterCall = 0;
    for (let i = 0; i < lines.length; i++) {
      const r = parsePiLine(state, lines[i], { idPrefix: '.pi:sess-123456', now: 1_795_451_600_000 });
      if (r.status) statuses.push(r.status);
      if (i === 3) shellCountAfterCall = state.shells.size;
    }
    expect(state.meta.cwd).toBe('/proj/app');
    expect(state.model).toBe('qwen3.8-flash');
    expect(state.title).toBe('Rode os testes do projeto');
    expect(state.stats.toolCalls).toBe(1);
    expect(state.stats.tokensIn).toBe(1000 + 200 + 50 + 500 + 1000);
    expect(state.stats.tokensOut).toBe(160);
    expect(state.stats.costUSD).toBeCloseTo(0.02, 5);
    expect(shellCountAfterCall).toBe(1);
    expect(state.shells.size).toBe(0);
    expect(statuses).toEqual(['working', 'working', 'working', 'idle']);
  });

  it('converte a sessão para TerminalEntry (user, thinking, tool, result, assistant, system)', () => {
    const parser = createPiTerminalParser();
    const entries = lines.flatMap((l) => parser.push(l));
    expect(entries.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'assistant', 'system']);
    const tool = entries.find((e) => e.kind === 'tool');
    expect(tool && tool.kind === 'tool' ? tool.title : '').toBe('Bash(npm test)');
    const res = entries.find((e) => e.kind === 'result');
    expect(res && res.kind === 'result' ? res.toolUseId : '').toBe('call_1');
  });
});

describe('PiSource (arquivos + extensão ao vivo) e PiHistory', () => {
  it('lê sessão recente do disco, acompanha novas linhas e responde ao histórico', async () => {
    const home = makeTmp();
    const dataDir = makeTmp();
    const { piDir, sessionFile, sessionId, cwd } = makePiTree(home);
    const nowMs = Date.now();
    const now = () => nowMs;

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date(nowMs - 10_000).toISOString(), cwd }),
        JSON.stringify({
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: new Date(nowMs - 5_000).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'Corrigir bug no parser' }] },
        }),
      ].join('\n') + '\n',
    );

    const accounts = new AccountsService({ dirs: [], home, env: {}, onChange: () => {}, now });
    const office = makeOffice(dataDir, accounts, now);
    const source = new PiSource({ accounts, office, dirs: [piDir], home, env: {}, now, watch: false, pollMs: 60_000 });
    source.start();

    const agents = office.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: `.pi:${sessionId}`,
      provider: 'pi',
      account: '.pi',
      sessionId,
      status: 'working',
      title: 'Corrigir bug no parser',
    });
    expect(source.transcriptPathOf(agents[0].id)).toBe(sessionFile);

    // Histórico lista a sessão como aberta e bloqueia path traversal
    const history = new PiHistory({
      accounts: () => accounts.entriesOf('pi'),
      openAgentOf: (acc, sid) => office.list().find((a) => a.account === acc && a.sessionId === sid)?.id,
      now,
    });
    const recent = await history.list();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ provider: 'pi', sessionId, project: cwd, open: true, title: 'Corrigir bug no parser' });
    expect('path' in history.resolve('.pi', sessionId)).toBe(true);
    expect(history.resolve('.pi', '../secret')).toMatchObject({ status: 400 });

    // Anexa término de turno no disco e atualiza via evento ao vivo
    appendFileSync(
      sessionFile,
      JSON.stringify({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: new Date(nowMs - 1_000).toISOString(),
        message: { role: 'assistant', model: 'qwen3.8-flash', content: [{ type: 'text', text: 'Pronto!' }], stopReason: 'stop' },
      }) + '\n',
    );
    source.applyLiveEvent('.pi', { type: 'agent_settled', sessionId, cwd, sessionFile });
    expect(office.get(`.pi:${sessionId}`)?.status).toBe('idle');

    source.stop();
  });

  it('aplica ciclo de vida completo vindo da extensão ao vivo (sem depender de arquivo)', () => {
    const home = makeTmp();
    const dataDir = makeTmp();
    const { piDir, cwd } = makePiTree(home);
    let clock = Date.now();
    const now = () => clock;

    const accounts = new AccountsService({ dirs: [], home, env: {}, onChange: () => {}, now });
    const office = makeOffice(dataDir, accounts, now);
    const source = new PiSource({ accounts, office, dirs: [piDir], home, env: {}, now, watch: false, pollMs: 60_000 });
    source.start();

    const sid = 'live-session-001';
    expect(source.applyLiveEvent(undefined, { type: 'session_start', sessionId: sid, cwd, piDir, model: 'claude-sonnet-4', idle: true })).toBe(true);
    const id = `.pi:${sid}`;
    expect(office.get(id)).toMatchObject({ provider: 'pi', status: 'idle', model: 'claude-sonnet-4' });

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'before_agent_start', sessionId: sid, cwd, piDir, prompt: 'Refatorar API' });
    expect(office.get(id)?.status).toBe('working');
    expect(office.get(id)?.title).toBe('Refatorar API');

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'tool_execution_start', sessionId: sid, cwd, piDir, toolCallId: 'tc1', toolName: 'bash', args: { command: 'npm run build' } });
    expect(office.get(id)?.shells).toHaveLength(1);

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'ui_prompt_start', sessionId: sid, cwd, piDir, title: 'Confirmar ação?' });
    expect(office.get(id)?.status).toBe('waiting');
    expect(office.get(id)?.waitingFor).toBe('Confirmar ação?');

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'ui_prompt_end', sessionId: sid, cwd, piDir, idle: false });
    expect(office.get(id)?.status).toBe('working');

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'tool_execution_end', sessionId: sid, cwd, piDir, toolCallId: 'tc1', toolName: 'bash', isError: false });
    expect(office.get(id)?.shells).toBeUndefined();

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'agent_settled', sessionId: sid, cwd, piDir });
    expect(office.get(id)?.status).toBe('idle');

    clock += 1_000;
    source.applyLiveEvent(undefined, { type: 'session_shutdown', sessionId: sid, cwd, piDir });
    expect(office.get(id)?.status).toBe('offline');

    source.stop();
  });
});
