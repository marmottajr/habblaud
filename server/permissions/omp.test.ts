// Pedidos do omp no registro de permissões: o agente pela sessão (session_id) entre os agentes do omp, sem
// sugestões, recusa só com motivo (interromper e "sempre permitir" = unsupported), retirada pela extensão
// ({behavior: 'terminal'}), sem busca da resposta no transcript, títulos com as ferramentas do omp e as perguntas do
// `ask` (mandadas como AskUserQuestion), que se respondem com `answer`.
// Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { parseHookInput, PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const SESSION = '0199b0c0-1234-7abc-8def-0123456789ab';
const OTHER_SESSION = '0199b0c0-5678-7abc-8def-0123456789ab';
const MAIN = `.omp:${SESSION}`;
const OTHER = `.omp:${OTHER_SESSION}`;
const CLAUDE = 'acc:1';
const CODEX = '.codex:thread-1';

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'omp', account: '.omp', sessionId: SESSION, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  office.addMain({ id: OTHER, provider: 'omp', account: '.omp', sessionId: OTHER_SESSION, cwd: '/p/api', role: 'Agente principal', startedAt: 0, status: 'working' });
  office.addMain({ id: CLAUDE, account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  office.addMain({ id: CODEX, provider: 'codex', account: '.codex', sessionId: 'thread-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  const scans: string[] = [];
  permissions = new PermissionRegistry({
    office,
    viewers: () => 1,
    transcriptPathOf: (id) => {
      scans.push(id);
      return undefined;
    },
    now: clock.now,
  });
  return { office, registry: permissions, clock, scans };
}

function ompInput(over: Record<string, unknown> = {}) {
  return {
    provider: 'omp',
    session_id: SESSION,
    tool_name: 'bash',
    tool_input: { command: 'npm test' },
    cwd: '/p/loja',
    timeout_ms: 25_000,
    ...over,
  };
}

function registered(r: ReturnType<PermissionRegistry['register']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

const snapAgent = (office: Office, id: string) => office.commit().snapshot.agents.find((a) => a.id === id);

describe('parseHookInput: omp', () => {
  it('aceita provider omp: sem sugestões nem conta do Codex', () => {
    const r = parseHookInput({ ...ompInput(), permission_suggestions: [{ type: 'addRules' }], account: 'x', codexHome: '/x' });
    expect(r).toMatchObject({ provider: 'omp', sessionId: SESSION, tool: 'bash', suggestions: undefined });
    expect(r.account).toBeUndefined();
    expect(r.codexHome).toBeUndefined();
  });

  it('provider desconhecido é tratado como Claude', () => {
    expect(parseHookInput({ ...ompInput(), provider: 'outro' }).provider).toBeUndefined();
  });
});

describe('PermissionRegistry: pedidos do omp', () => {
  it('publica no agente do omp certo: provider omp, "aprovar um comando", título no vocabulário do Habblaud', () => {
    const { office, registry } = setup();
    const id = registered(registry.register(ompInput()));
    const a = snapAgent(office, MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.waitingFor).toBe('aprovar um comando');
    expect(a.permission).toMatchObject({ id, provider: 'omp', tool: 'bash', title: 'Bash(npm test)', expiresAt: 1_025_000 });
    expect(a.permission!.suggestions).toBeUndefined();
    expect(snapAgent(office, OTHER)!.permission).toBeUndefined();
    expect(snapAgent(office, CLAUDE)!.permission).toBeUndefined();
    expect(snapAgent(office, CODEX)!.permission).toBeUndefined();
    expect(registry.detail(id)).toMatchObject({ input: 'npm test', inputKind: 'command' });
  });

  it('sessão desconhecida, ou a de um Claude/Codex, não casa: unknown-session', () => {
    const { registry } = setup();
    expect(registry.register(ompInput({ session_id: 'nao-existe' }))).toEqual({ skip: 'unknown-session' });
    expect(registry.register(ompInput({ session_id: 'sess-1' }))).toEqual({ skip: 'unknown-session' });
    expect(registry.register(ompInput({ session_id: 'thread-1' }))).toEqual({ skip: 'unknown-session' });
    // Pedido do Claude Code ou do Codex com a sessão do omp: não acha o agente do omp.
    expect(registry.register({ session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ skip: 'unknown-session' });
    expect(registry.register({ provider: 'codex', session_id: SESSION, account: '.codex', tool_name: 'Bash', tool_input: {} })).toEqual({ skip: 'unknown-session' });
  });

  it('decisões: deny com motivo chega ao long-poll; interromper e "sempre permitir" = unsupported; answer = invalid-answer', async () => {
    const { registry } = setup();
    const id = registered(registry.register(ompInput()));
    expect(registry.decide(id, { behavior: 'deny', message: 'não', interrupt: true })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    const w = registry.wait(id, 10_000)!;
    expect(registry.decide(id, { behavior: 'deny', message: 'não apague essa pasta' })).toBe('ok');
    expect(await w.result).toEqual({ status: 'decided', behavior: 'deny', message: 'não apague essa pasta' } satisfies WaitResult);

    const id2 = registered(registry.register(ompInput()));
    const w2 = registry.wait(id2, 10_000)!;
    expect(registry.decide(id2, { behavior: 'allow' })).toBe('ok');
    expect(await w2.result).toEqual({ status: 'decided', behavior: 'allow' });
  });

  it('retirada pela extensão ({behavior: terminal}) solta o long-poll como released/terminal e tira o pedido do painel', async () => {
    const { office, registry } = setup();
    const id = registered(registry.register(ompInput()));
    const w = registry.wait(id, 10_000)!;
    expect(registry.decide(id, { behavior: 'terminal' })).toBe('ok');
    expect(await w.result).toEqual({ status: 'released', reason: 'terminal' });
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    expect(registry.decide(id, { behavior: 'terminal' })).toBe('not-found');
  });

  it('pergunta do omp (o ask como AskUserQuestion) se responde com answer, não se aprova; a extensão recebe as posições', async () => {
    const { registry } = setup();
    const questions = [{ question: 'Qual banco?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false }];
    const id = registered(registry.register(ompInput({ tool_name: 'AskUserQuestion', tool_input: { questions } })));
    expect(registry.detail(id)!.questions).toEqual([expect.objectContaining({ index: 0, question: 'Qual banco?' })]);
    expect(registry.decide(id, { behavior: 'allow' })).toBe('invalid-answer');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0, 1] }] })).toBe('invalid-answer');
    const w = registry.wait(id, 25_000)!;
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [1] }] })).toBe('ok');
    expect(await w.result).toEqual({ status: 'decided', behavior: 'answer', answers: [{ question: 0, options: [1] }] });
  });

  it('ferramenta do omp sem tradução segue com o nome bruto', () => {
    const { registry } = setup();
    const id = registered(registry.register(ompInput({ tool_name: 'minha_ferramenta', tool_input: { x: 1 } })));
    expect(registry.detail(id)).toMatchObject({ tool: 'minha_ferramenta', title: expect.stringContaining('minha_ferramenta') });
  });

  it('sem a busca da resposta no terminal: o transcript nunca é lido', () => {
    const { office, registry, clock, scans } = setup();
    const id = registered(registry.register(ompInput()));
    const w = registry.wait(id, 25_000)!;
    office.setStatus(MAIN, 'waiting', 'aprovar um comando');
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      if (i === 5) office.setStatus(MAIN, 'working');
      registry.tick();
    }
    expect(scans).toEqual([]);
    expect(registry.size).toBe(1);
    w.cancel();
  });

  it('agente do omp que sai solta o pedido como released/gone', async () => {
    const { office, registry, clock } = setup();
    const id = registered(registry.register(ompInput()));
    const w = registry.wait(id, 10_000)!;
    office.closeMain(MAIN);
    clock.advance(500);
    registry.tick();
    expect(await w.result).toEqual({ status: 'released', reason: 'gone' });
  });
});
