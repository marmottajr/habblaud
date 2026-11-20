// Fonte do omp de ponta a ponta: uma agent dir temporária (sessões sintéticas e cópias das fixtures reais), o
// AccountsService e um Office de verdade, com arquivo crescendo, subagentes, session_exit, 10 min parado e os eventos da
// extensão (batimento perdido com relógio manual, espelho da aprovação no terminal).
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import type { OmpEvent } from '../../../shared/omp-events';
import { OMP_HEARTBEAT_LOST_MS, OMP_HEARTBEAT_MS } from '../../../shared/omp-events';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { normalizeCwd } from '../../model/rooms';
import { tempDir } from '../../test/fixtures';
import { PRESENT_MS } from './files';
import { OmpSource, SCAN_MS, USAGE_EVERY_MS, type OmpSourceOptions } from './source';

setQuiet(true);

const FIX = join(import.meta.dirname, 'fixtures');
const CWD = process.platform === 'win32' ? 'C:\\proj\\loja' : '/projetos/loja';
const SID = '01a20000-0000-7000-8000-000000000001';
const KEY = `omp:${SID}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(opts: { agents?: number; source?: Partial<OmpSourceOptions> } = {}) {
  const tmp = tempDir();
  const dirs = Array.from({ length: opts.agents ?? 1 }, (_, i) => {
    const dir = join(tmp.dir, i ? `.omp${i + 1}` : '.omp', 'agent');
    mkdirSync(join(dir, 'sessions', '-proj'), { recursive: true });
    return dir;
  });
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new OmpSource({ accounts, office, dirs, env: {}, home: tmp.dir, now, watch: false, ...opts.source });
  cleanups.unshift(() => source.stop());
  cleanups.push(tmp.cleanup);

  const ctx = {
    dirs,
    accounts,
    office,
    source,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      return office.commit();
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    event(ev: Partial<OmpEvent> & Pick<OmpEvent, 'event'>): boolean {
      return source.applyEvent({ sessionId: SID, at: clock, cwd: CWD, ...ev });
    },
    ts: () => new Date(clock).toISOString(),
    /** Caminho de uma sessão principal nova (nome `<início>_<id>.jsonl`). */
    path(id = SID, account = 0): string {
      return join(dirs[account], 'sessions', '-proj', `2026-10-19T13-00-00-000Z_${id}.jsonl`);
    },
    /** Grava o cabeçalho (slot de título + session) e as linhas dadas. */
    session(path: string, lines: object[], o: { id?: string; cwd?: string; parent?: string } = {}) {
      const header = [
        { type: 'title', v: 1, title: '', updatedAt: ctx.ts(), pad: ' '.repeat(80) },
        { type: 'session', version: 3, id: o.id ?? SID, timestamp: ctx.ts(), cwd: o.cwd ?? CWD, ...(o.parent ? { parentSession: o.parent } : {}) },
      ];
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, [...header, ...lines].map((l) => `${JSON.stringify(l)}\n`).join(''));
    },
    append(path: string, lines: object[]) {
      appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    },
  };
  return ctx;
}

type Ctx = ReturnType<typeof setup>;

let n = 0;
const id8 = () => (++n).toString(16).padStart(8, '0');
const L = {
  model: (c: Ctx, model = 'anthropic/claude-teste-1') => ({ type: 'model_change', id: id8(), parentId: null, timestamp: c.ts(), model }),
  user: (c: Ctx, text = 'Rode os testes') => ({ type: 'message', id: id8(), timestamp: c.ts(), message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' } }),
  tool: (c: Ctx, callId: string, name: string, args: object, usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }) => ({
    type: 'message',
    id: id8(),
    timestamp: c.ts(),
    message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }], model: 'claude-teste-1', usage, stopReason: 'toolUse' },
  }),
  result: (c: Ctx, callId: string, name: string, isError = false) => ({
    type: 'message',
    id: id8(),
    timestamp: c.ts(),
    message: { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'saída' }], isError },
  }),
  stop: (c: Ctx) => ({
    type: 'message',
    id: id8(),
    timestamp: c.ts(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Pronto' }], model: 'claude-teste-1', usage: { input: 2, output: 7, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' },
  }),
  exit: (c: Ctx) => ({ type: 'custom', customType: 'session_exit', data: { reason: 'manual', kind: 'normal' }, id: id8(), timestamp: c.ts() }),
};

describe('fonte do omp: presença pelo arquivo', () => {
  it('sessão viva aparece na sala do cwd, com título, modelo, tokens e status; session_exit tira em um ciclo', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.model(c), L.user(c), L.tool(c, 'toolu_1', 'bash', { command: 'npm test', i: 'Rodando testes' })]);
    c.source.boot();
    let a = c.agent()!;
    expect(a).toMatchObject({ provider: 'omp', account: '.omp', sessionId: SID, roomId: normalizeCwd(CWD), kind: 'main', status: 'working' });
    expect(a.title).toBe('Rode os testes');
    expect(a.model).toBe('claude-teste-1');
    expect(a.stats).toMatchObject({ toolCalls: 1, tokensIn: 110, tokensOut: 5 });
    expect(a.activity).toMatchObject({ tool: 'Bash', kind: 'test' });
    expect(c.source.sources()).toEqual([{ label: '.omp', provider: 'omp', path: c.dirs[0], sessions: 1, ok: true }]);
    expect(c.source.transcriptPathOf(KEY)).toBe(path);
    const parser = c.source.terminalParser(KEY)!;
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => parser.push(l)).map((e) => e.kind)).toEqual(['user', 'tool']);
    expect(c.source.terminalParser('omp:desconhecido')).toBeUndefined();

    c.advance(1_000);
    c.append(path, [L.result(c, 'toolu_1', 'bash'), L.stop(c)]);
    c.poll();
    a = c.agent()!;
    expect(a.status).toBe('idle');
    expect(a.stats.tokensIn).toBe(112);
    expect(a.stats.tokensOut).toBe(12);

    c.advance(1_000);
    c.append(path, [L.exit(c)]);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
    expect(c.source.sources()[0].sessions).toBe(0);
  });

  it('arquivo crescendo: nova instrução volta a trabalhar, ferramenta com erro, subagente aparece e entrega', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.model(c), L.user(c, 'Primeira'), L.stop(c)]);
    c.source.boot();
    expect(c.agent()!.status).toBe('idle');

    c.advance(1_000);
    c.append(path, [L.user(c, 'Segunda'), L.tool(c, 'toolu_2', 'read', { path: 'src/app.ts:1-20' })]);
    c.poll();
    expect(c.agent()!).toMatchObject({ status: 'working', activity: { tool: 'Read', detail: 'src/app.ts' } });

    // Subagente: `<arquivo sem .jsonl>/<Nome>.jsonl`, com parentSession.
    c.advance(1_000);
    const subId = '01a20000-0000-7000-8000-0000000000aa';
    const subPath = path.replace(/\.jsonl$/, '') + `${join('/', 'ArchScout.jsonl')}`;
    c.session(subPath, [L.model(c), L.user(c, 'Mapeie a arquitetura'), L.tool(c, 'toolu_s1', 'grep', { pattern: 'TODO' })], { id: subId, parent: path });
    c.poll();
    const sub = c.agent(`${KEY}:ArchScout`)!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: KEY, role: 'ArchScout', sessionId: subId, status: 'working', provider: 'omp' });

    // O subagente termina o turno: entrega (done).
    c.advance(1_000);
    c.append(subPath, [L.stop(c), L.exit(c)]);
    c.poll();
    expect(c.agent(`${KEY}:ArchScout`)!.status).toBe('done');
    expect(c.agent()!.status).toBe('working');
  });

  it('título do slot mudou no lugar (linha 1 reescrita): relê sem duplicar e passa a usar o título', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.model(c), L.user(c, 'Instrução')]);
    c.source.boot();
    const before = c.agent()!.stats.toolCalls;
    c.advance(1_000);
    c.append(path, [{ type: 'title_change', id: id8(), timestamp: c.ts(), title: 'Título novo', source: 'auto' }]);
    // O omp reescreve a linha 1 (mesma largura): o começo do arquivo muda.
    const raw = readFileSync(path, 'utf8').split('\n');
    const slot = JSON.stringify({ type: 'title', v: 1, title: 'Título novo', updatedAt: c.ts(), pad: '' });
    raw[0] = slot.padEnd(raw[0].length - 1 > slot.length ? raw[0].length : slot.length);
    writeFileSync(path, raw.join('\n'));
    c.poll();
    c.poll();
    expect(c.agent()!.title).toBe('Título novo');
    expect(c.agent()!.stats.toolCalls).toBe(before);
    expect(c.agents().filter((a) => a.id === KEY)).toHaveLength(1);
  });

  it('parada há 11 min sem session_exit sai; escrita nova a traz de volta', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.model(c), L.user(c), L.stop(c)]);
    c.source.boot();
    expect(c.agent()!.status).toBe('idle');
    c.advance(PRESENT_MS + 60_000);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
    c.advance(SCAN_MS);
    c.append(path, [L.user(c, 'voltei')]);
    utimesSync(path, new Date(c.now()), new Date(c.now()));
    c.poll();
    expect(c.agent()!.status).toBe('working');
  });

  it('sessão que já terminou com session_exit (fixture real) e sem cabeçalho completo não entram', () => {
    const c = setup();
    copyFileSync(join(FIX, 'main-clean-exit.jsonl'), join(c.dirs[0], 'sessions', '-proj', '2026-10-12T00-58-56-948Z_01a12d9e-b033-7000-a6b5-5c32fc303cf1.jsonl'));
    writeFileSync(c.path('01a20000-0000-7000-8000-0000000000bb'), '{"type":"title","v":1,"title":"","pad":""}\n');
    c.source.boot();
    expect(c.agents()).toEqual([]);
  });

  it('sessão de uma fixture real em andamento: cwd sem .git, sala do projeto que as ferramentas tocam, com o título do title_change', () => {
    const c = setup({ source: { roomByProject: () => true } });
    const id = '01a13a52-fa11-7000-b7af-bfa3171c863d';
    const path = c.path(id);
    copyFileSync(join(FIX, 'main-task.jsonl'), path);
    utimesSync(path, new Date(c.now()), new Date(c.now())); // a cópia pode manter o mtime da fixture
    c.source.boot();
    const a = c.agent(`omp:${id}`)!;
    expect(a).toMatchObject({ provider: 'omp', sessionId: id, roomId: normalizeCwd('C:\\Users\\dev\\proj\\src'), title: 'Título da sessão', status: 'working' });
    expect(a.model).toBe('claude-fable-5-1');
    expect(a.stats.tokensIn).toBeGreaterThan(0);
  });

  it('sala por projeto desligada (padrão) fica no cwd; ligar em Configurações muda a sala no próximo ciclo, sem reiniciar', () => {
    let on = false;
    const c = setup({ source: { roomByProject: () => on } });
    const id = '01a13a52-fa11-7000-b7af-bfa3171c863d';
    const path = c.path(id);
    copyFileSync(join(FIX, 'main-task.jsonl'), path);
    utimesSync(path, new Date(c.now()), new Date(c.now()));
    c.source.boot();
    expect(c.agent(`omp:${id}`)!.roomId).toBe(normalizeCwd('C:\\Users\\dev\\proj'));
    on = true;
    c.poll();
    expect(c.agent(`omp:${id}`)!.roomId).toBe(normalizeCwd('C:\\Users\\dev\\proj\\src'));
    on = false;
    c.poll();
    expect(c.agent(`omp:${id}`)!.roomId).toBe(normalizeCwd('C:\\Users\\dev\\proj'));
  });

  it('duas agent dirs: uma conta por pasta, a sessão leva a conta da sua pasta; HABBLAUD_OMP sem pastas = sem fonte', () => {
    const c = setup({ agents: 2 });
    expect(c.source.accountEntries().map((e) => e.id)).toEqual(['.omp', '.omp2']);
    const other = '01a20000-0000-7000-8000-000000000002';
    c.session(c.path(other, 1), [L.user(c)], { id: other });
    c.source.boot();
    expect(c.agent(`omp:${other}`)).toMatchObject({ account: '.omp2', status: 'working' });
    expect(c.accounts.allEntries().filter((e) => e.provider === 'omp')).toHaveLength(2);
  });
});

describe('fonte do omp: eventos da extensão', () => {
  it('session_start cria o agente sem arquivo; o arquivo que surge passa a dar atividade', () => {
    const c = setup();
    expect(c.event({ event: 'session_start', sessionFile: c.path() })).toBe(true);
    expect(c.agent()).toMatchObject({ provider: 'omp', roomId: normalizeCwd(CWD), status: 'idle', account: '.omp' });
    c.advance(1_000);
    c.session(c.path(), [L.model(c), L.user(c, 'Olá'), L.tool(c, 'toolu_9', 'bash', { command: 'ls' })]);
    c.poll();
    expect(c.agent()).toMatchObject({ title: 'Olá', status: 'working', activity: { tool: 'Bash' } });
  });

  it('sessão retomada (arquivo termina em session_exit) entra com session_start e fica enquanto bate', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.model(c), L.user(c), L.stop(c), L.exit(c)]);
    c.source.boot();
    expect(c.agent()).toBeUndefined();
    c.advance(1_000);
    c.event({ event: 'session_start', sessionFile: path });
    expect(c.agent()!.status).toBe('idle');
    c.advance(OMP_HEARTBEAT_MS);
    c.event({ event: 'heartbeat' });
    c.poll();
    expect(c.agent()!.status).toBe('idle');
    c.event({ event: 'session_shutdown' });
    expect(c.agent()!.status).toBe('offline');
  });

  it('session_start com models expõe AgentInfo.models', () => {
    const c = setup();
    c.event({ event: 'session_start', models: ['anthropic/a', 'openai/b'] });
    expect(c.agent()!.models).toEqual(['anthropic/a', 'openai/b']);
  });

  it('heartbeat com models, sem session_start antes (Habblaud reiniciou), expõe AgentInfo.models', () => {
    const c = setup();
    c.event({ event: 'heartbeat', sessionFile: c.path(), models: ['anthropic/a'] });
    c.event({ event: 'session_start', sessionFile: c.path() });
    expect(c.agent()!.models).toEqual(['anthropic/a']);
  });

  it('agent_start/agent_end mudam o status; tool_start vira atividade imediata; tool_end não muda nada', () => {
    const c = setup();
    c.event({ event: 'session_start' });
    c.event({ event: 'agent_start' });
    expect(c.agent()!.status).toBe('working');
    c.event({ event: 'tool_start', toolName: 'bash', toolCallId: 'toolu_x' });
    expect(c.agent()!.activity).toMatchObject({ tool: 'Bash' });
    c.event({ event: 'tool_end', toolName: 'bash', toolCallId: 'toolu_x' });
    expect(c.agent()!.status).toBe('working');
    c.event({ event: 'agent_end' });
    expect(c.agent()!.status).toBe('idle');
  });

  it('tool_start com a chamada já no arquivo mantém a atividade do arquivo (com os argumentos)', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.user(c)]);
    c.source.boot();
    c.advance(500);
    c.append(path, [L.tool(c, 'toolu_k', 'edit', { input: '[src/app.ts#ABCD]\nPUT 1.=1:\n+x' })]);
    c.event({ event: 'tool_start', toolName: 'edit', toolCallId: 'toolu_k' });
    expect(c.agent()!.activity).toMatchObject({ tool: 'Edit', detail: 'src/app.ts' });
    expect(c.office.commit().snapshot.agents.find((a) => a.id === KEY)!.recent.filter((a) => a.id.endsWith('#toolu_k'))).toHaveLength(1);
  });

  it('session_shutdown fecha na hora e o arquivo ainda "vivo" não o reabre', () => {
    const c = setup();
    c.session(c.path(), [L.user(c)]);
    c.source.boot();
    expect(c.agent()!.status).toBe('working');
    c.event({ event: 'session_start' });
    c.advance(500);
    c.event({ event: 'session_shutdown' });
    expect(c.agent()!.status).toBe('offline');
    c.advance(2_000);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
    // Batimento atrasado de quem já saiu não reabre.
    c.event({ event: 'heartbeat' });
    c.poll();
    expect(c.agent()!.status).toBe('offline');
  });

  it('batimento: vivo enquanto bate; ausente por 30 s fecha (relógio manual) e um batimento novo reabre', () => {
    const c = setup();
    c.event({ event: 'session_start' });
    for (let i = 0; i < 4; i++) {
      c.advance(OMP_HEARTBEAT_MS);
      c.event({ event: 'heartbeat' });
      c.poll();
    }
    expect(c.agent()!.status).toBe('idle');
    c.advance(OMP_HEARTBEAT_LOST_MS - 1_000);
    c.poll();
    expect(c.agent()!.status).toBe('idle');
    c.advance(2_000);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
    // Continua fechado enquanto nada acontece (mesmo com o arquivo vivo por mtime).
    c.advance(5_000);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
    c.event({ event: 'heartbeat' });
    expect(c.agent()!.status).toBe('idle');
  });

  it('crash com extensão: arquivo "vivo" por mtime mas sem batimento sai em até 35 s', () => {
    const c = setup();
    const path = c.path();
    c.session(path, [L.user(c), L.tool(c, 'toolu_c', 'bash', { command: 'sleep 1' })]);
    c.source.boot();
    c.event({ event: 'session_start' });
    c.advance(OMP_HEARTBEAT_LOST_MS + 5_000);
    c.poll();
    expect(c.agent()!.status).toBe('offline');
  });

  it('evento sem projeto e sem arquivo: false e nada muda; evento de conta desconhecida (sem fonte): ignorado', () => {
    const c = setup();
    expect(c.source.applyEvent({ event: 'agent_start', sessionId: SID, at: c.now() })).toBe(false);
    expect(c.agents()).toEqual([]);
    expect(c.event({ event: 'session_shutdown' })).toBe(true);
    expect(c.agents()).toEqual([]);
  });

  it('espelho da aprovação: approval_requested marca waiting + "aprovar no terminal: <ferramenta>"; resolved volta a trabalhar; sem pedido no painel', () => {
    const c = setup();
    c.event({ event: 'session_start' });
    c.event({ event: 'agent_start' });
    c.advance(100);
    c.event({ event: 'approval_requested', toolName: 'bash' });
    let a = c.agent()!;
    expect(a.status).toBe('waiting');
    expect(a.waitingFor).toBe('aprovar no terminal: bash');
    expect(a.permission).toBeUndefined();
    c.advance(100);
    c.event({ event: 'approval_resolved', toolName: 'bash', approved: true });
    a = c.agent()!;
    expect(a.status).toBe('working');
    expect(a.waitingFor).toBeUndefined();
    // Fim do turno também limpa a espera.
    c.event({ event: 'approval_requested', toolName: 'edit' });
    c.advance(100);
    c.event({ event: 'agent_end' });
    expect(c.agent()).toMatchObject({ status: 'idle' });
    expect(c.agent()!.waitingFor).toBeUndefined();
  });
});

const USAGE_FIX = readFileSync(join(FIX, 'usage.json'), 'utf8');
/** A saída real do omp usage com a leitura feita agora (relógio do teste) e janelas que só reiniciam daqui a 1 h. */
function usageNow(at: number): string {
  const j = JSON.parse(USAGE_FIX) as { reports: Array<{ fetchedAt: number; limits: Array<{ window: { resetsAt: number } }> }> };
  for (const r of j.reports) {
    r.fetchedAt = at;
    for (const l of r.limits) l.window.resetsAt = at + 3_600_000;
  }
  return JSON.stringify(j);
}

async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function usageSetup(usage = true) {
  const calls: Array<{ bin: string; dir: string }> = [];
  let fail = false;
  const c = setup({
    source: {
      usage,
      ompBin: 'omp',
      runUsage: (bin, dir) => {
        calls.push({ bin, dir });
        return fail ? Promise.reject(new Error('sem rede')) : Promise.resolve(usageNow(c.now()));
      },
    },
  });
  return {
    c,
    calls,
    failNext(v: boolean) {
      fail = v;
    },
    account: () => c.accounts.list(new Map()).find((a) => a.id === '.omp')!,
  };
}

describe('fonte do omp: uso do plano via omp usage', () => {
  it('sem sessão aberta não roda o omp; com sessão, lê as janelas do provedor do modelo em uso a cada 5 min', async () => {
    const u = usageSetup();
    u.c.source.boot();
    u.c.poll();
    expect(u.calls).toEqual([]);
    expect(u.account().usage).toBeUndefined();

    u.c.session(u.c.path(), [L.model(u.c, 'anthropic/claude-opus-5-5'), L.user(u.c)]);
    u.c.advance(SCAN_MS);
    u.c.poll();
    expect(u.calls).toEqual([{ bin: 'omp', dir: u.c.dirs[0] }]);
    await flush();
    expect(u.account()).toMatchObject({
      usage: { source: 'omp', ompProvider: 'anthropic', fiveHour: { utilization: 11 }, sevenDay: { utilization: 41 } },
      usageStatus: 'ok',
    });

    u.c.advance(4 * 60_000);
    u.c.poll();
    expect(u.calls).toHaveLength(1);
    u.c.advance(USAGE_EVERY_MS - 4 * 60_000);
    u.c.poll();
    expect(u.calls).toHaveLength(2);
  });

  it('troca de provedor lê na hora; provedor sem janelas fica sem números, com a nota do omp', async () => {
    const u = usageSetup();
    const path = u.c.path();
    u.c.session(path, [L.model(u.c, 'anthropic/claude-opus-5-5'), L.user(u.c)]);
    u.c.source.boot();
    await flush();
    expect(u.calls).toHaveLength(1);

    u.c.advance(1_000);
    u.c.append(path, [L.model(u.c, 'ollama-cloud/gemma4:31b-cloud')]);
    u.c.poll();
    expect(u.calls).toHaveLength(2);
    await flush();
    const usage = u.account().usage!;
    expect(usage).toMatchObject({ source: 'omp', ompProvider: 'ollama-cloud' });
    expect(usage.fiveHour).toBeUndefined();
    expect(usage.note).toMatch(/^Ollama/);
  });

  it('falha: o último uso fica e a próxima tentativa é depois de 1 min', async () => {
    const u = usageSetup();
    const path = u.c.path();
    u.c.session(path, [L.model(u.c, 'anthropic/claude-opus-5-5'), L.user(u.c)]);
    u.c.source.boot();
    await flush();

    u.failNext(true);
    u.c.advance(USAGE_EVERY_MS);
    u.c.poll();
    await flush();
    expect(u.calls).toHaveLength(2);
    expect(u.account().usage).toMatchObject({ ompProvider: 'anthropic', fiveHour: { utilization: 11 } });

    u.failNext(false);
    u.c.advance(30_000);
    u.c.poll();
    expect(u.calls).toHaveLength(2);
    u.c.advance(30_000);
    u.c.poll();
    expect(u.calls).toHaveLength(3);
  });

  it('desligado (HABBLAUD_OMP_USAGE=0, padrão da fonte): nunca roda o omp', () => {
    const u = usageSetup(false);
    u.c.session(u.c.path(), [L.model(u.c, 'anthropic/claude-opus-5-5'), L.user(u.c)]);
    u.c.source.boot();
    u.c.poll();
    expect(u.calls).toEqual([]);
  });
});
