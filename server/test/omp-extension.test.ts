// Extensão do Habblaud no omp (mod/habblaud-omp/habblaud.ts) com um `pi` e um Habblaud FALSOS: os nomes de evento
// registrados, o corpo enviado, as mensagens (livre/ocupado), o modo de decisão (recusa, corrida terminal×escritório,
// prazo, Habblaud fora do ar). A prova contra um omp de verdade (os nomes de evento errados não dão erro lá) foi feita
// à parte, rodando `omp --mode rpc`/`rpc-ui` com a extensão (tarefas 5.1 a 5.4).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_TOOL,
  ASK_WAIT_MS,
  askResult,
  askToHabblaud,
  create,
  DECISION_UI_MS,
  decisionTimeoutMs,
  dialogDetail,
  needsDecision,
  parseInbox,
  portOf,
  reasonText,
  type Deps,
  type OmpApi,
  type OmpContext,
  type ToolContext,
  type ToolDefinition,
} from '../../mod/habblaud-omp/habblaud';
import { tempDir } from './fixtures';

type Handler = (event: Record<string, unknown>, ctx: OmpContext) => unknown;

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Habblaud falso: guarda as chamadas e responde por rota (`answer` devolve {status, json} ou 'hang'/'down'). */
function fakeHabblaud(answer: (c: Call) => { status: number; json: unknown } | 'down' | 'hang' | undefined) {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const u = new URL(url);
    const call: Call = { method: init?.method ?? 'GET', path: u.pathname, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    calls.push(call);
    const r = answer(call) ?? { status: 200, json: { ok: true } };
    if (r === 'down') return Promise.reject(new Error('ECONNREFUSED'));
    if (r === 'hang') {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => reject(new Error('abortado')), { once: true });
      return promise;
    }
    return Promise.resolve(new Response(JSON.stringify(r.json), { status: r.status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, of: (path: string) => calls.filter((c) => c.path === path) };
}

function setup(opts: { pi?: Partial<OmpApi>; env?: NodeJS.ProcessEnv; answer?: Parameters<typeof fakeHabblaud>[0]; home: string }) {
  const handlers = new Map<string, Handler>();
  const sent: Array<{ text: string; options?: unknown }> = [];
  const pi: OmpApi = {
    on: (event, h) => void handlers.set(event, h),
    sendUserMessage: (text, options) => void sent.push({ text, options }),
    ...opts.pi,
  };
  const habblaud = fakeHabblaud(opts.answer ?? (() => undefined));
  const deps: Deps = { env: opts.env ?? {}, home: opts.home, fetch: habblaud.fetchImpl, now: () => 1_000, shared: {} };
  create(pi, deps);
  return { handlers, sent, habblaud, fire: (name: string, ctx: OmpContext, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx) };
}

interface CtxOpts {
  models?: { provider: string; id: string }[];
  id?: string;
  hasUI?: boolean;
  kind?: 'main' | 'sub';
  idle?: boolean;
  confirm?: (signal?: AbortSignal) => Promise<boolean>;
}

function makeCtx(o: CtxOpts = {}): OmpContext & { confirms: number; aborted: boolean; notices: string[] } {
  const ctx = {
    hasUI: o.hasUI ?? false,
    cwd: '/projetos/demo',
    agent: { kind: o.kind ?? 'main' },
    isIdle: () => o.idle ?? true,
    ...(o.models ? { models: { list: () => o.models!, resolve: (s: string) => o.models!.find((m) => `${m.provider}/${m.id}` === s || m.id === s) } } : {}),
    confirms: 0,
    aborted: false,
    notices: [] as string[],
    ui: {
      confirm: (_t: string, _m: string, opt?: { signal?: AbortSignal }) => {
        ctx.confirms++;
        opt?.signal?.addEventListener('abort', () => (ctx.aborted = true));
        return o.confirm ? o.confirm(opt?.signal) : Promise.withResolvers<boolean>().promise;
      },
      notify: (m: string) => void ctx.notices.push(m),
    },
    sessionManager: {
      getSessionId: () => o.id ?? 'sess-1',
      getSessionFile: () => '/home/u/.omp/agent/sessions/x/2026_sess-1.jsonl',
      getCwd: () => '/projetos/demo',
    },
  };
  return ctx;
}

describe('omp extension: funções puras', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir('habblaud-omp-ext-')));
  afterEach(() => tmp.cleanup());

  it('porta: HABBLAUD_PORT › omp-extension.json › 4747 (arquivo ruim = padrão)', () => {
    expect(portOf({}, tmp.dir)).toBe(4747);
    mkdirSync(join(tmp.dir, '.habblaud'));
    const cfg = join(tmp.dir, '.habblaud', 'omp-extension.json');
    writeFileSync(cfg, '{"port": 4900}');
    expect(portOf({}, tmp.dir)).toBe(4900);
    expect(portOf({ HABBLAUD_PORT: '4800' }, tmp.dir)).toBe(4800);
    expect(portOf({ HABBLAUD_PORT: 'x' }, tmp.dir)).toBe(4900);
    writeFileSync(cfg, '{"port": "4900"}');
    expect(portOf({}, tmp.dir)).toBe(4747);
    writeFileSync(cfg, 'não é json');
    expect(portOf({}, tmp.dir)).toBe(4747);
  });

  it('prazo da decisão: com UI a espera do Habblaud; sem UI, o prazo do omp menos 3 s', () => {
    expect(decisionTimeoutMs(true, {})).toBe(DECISION_UI_MS);
    expect(decisionTimeoutMs(true, { HABBLAUD_OMP_TIMEOUT_MS: '8000' })).toBe(DECISION_UI_MS);
    expect(decisionTimeoutMs(false, {})).toBe(27_000);
    expect(decisionTimeoutMs(false, { HABBLAUD_OMP_TIMEOUT_MS: '60000' })).toBe(57_000);
    expect(decisionTimeoutMs(false, { HABBLAUD_OMP_TIMEOUT_MS: 'x' })).toBe(27_000);
    expect(decisionTimeoutMs(false, { HABBLAUD_OMP_TIMEOUT_MS: '1000' })).toBe(1_000);
  });

  it('só leitura não passa pelo modo de decisão; o resto (inclusive ferramenta desconhecida) passa', () => {
    for (const t of ['read', 'grep', 'glob', 'find', 'web_search', 'fetch', 'ls', 'lsp', 'todo', 'ask']) expect(needsDecision(t)).toBe(false);
    for (const t of ['bash', 'edit', 'write', 'ast_edit', 'eval', 'task', 'mcp_qualquer', 'ferramenta_nova']) expect(needsDecision(t)).toBe(true);
  });

  it('inbox: tolera item ruim, item sem id sai, sem texto vira texto vazio, fora do formato = undefined', () => {
    expect(parseInbox('{"messages":[{"id":"a","text":"oi"},{"text":"sem id"},null,{"id":"b"}]}')).toEqual([
      { id: 'a', text: 'oi' },
      { id: 'b', text: '' },
    ]);
    expect(parseInbox('{"messages":[]}')).toEqual([]);
    expect(parseInbox('{}')).toBeUndefined();
    expect(parseInbox('[]')).toBeUndefined();
    expect(parseInbox('lixo')).toBeUndefined();
  });

  it('reasonText: uma linha, até 500 caracteres; vazio = o padrão', () => {
    expect(reasonText(new Error('a\nb\t c'), 'x')).toBe('a b c');
    expect(reasonText('', 'padrão')).toBe('padrão');
    expect(reasonText(42, 'padrão')).toBe('padrão');
    expect(reasonText('y'.repeat(900), 'x')).toHaveLength(500);
  });

  it('texto do diálogo: comando, caminho ou JSON, cortado', () => {
    expect(dialogDetail('bash', { command: 'ls -la' })).toBe('ls -la');
    expect(dialogDetail('edit', { path: 'a/b.ts', edits: [] })).toBe('a/b.ts');
    expect(dialogDetail('mcp_x', { q: 1 })).toBe('{"q":1}');
    expect(dialogDetail('bash', { command: 'z'.repeat(2000) })).toHaveLength(800);
  });
});

describe('omp extension: eventos', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir('habblaud-omp-ext-')));
  afterEach(() => tmp.cleanup());

  it('registra exatamente os nomes de evento do omp (sem tool_call fora do modo de decisão)', () => {
    const { handlers } = setup({ home: tmp.dir });
    expect([...handlers.keys()].sort()).toEqual(
      ['agent_end', 'agent_start', 'session_shutdown', 'session_start', 'session_switch', 'tool_approval_requested', 'tool_approval_resolved', 'tool_execution_end', 'tool_execution_start'].sort(),
    );
    expect([...setup({ home: tmp.dir, env: { HABBLAUD_OMP_PERMISSOES: '1' } }).handlers.keys()]).toContain('tool_call');
  });

  it('cada evento chega com o id da sessão, na ordem; subagente e erro de rede não chegam ao omp', async () => {
    const t = setup({ home: tmp.dir, env: { HABBLAUD_PORT: '4999' }, answer: (c) => (c.path === '/api/omp/events' && c.body?.event === 'tool_end' ? 'down' : undefined) });
    const ctx = makeCtx();
    t.fire('session_start', ctx, {});
    t.fire('agent_start', ctx);
    t.fire('tool_execution_start', ctx, { toolName: 'bash', toolCallId: 'c1' });
    t.fire('tool_execution_end', ctx, { toolName: 'bash', toolCallId: 'c1' });
    t.fire('tool_approval_requested', ctx, { toolName: 'bash', toolCallId: 'c1', approvalMode: 'yolo' });
    t.fire('tool_approval_resolved', ctx, { toolName: 'bash', toolCallId: 'c1', approved: false });
    t.fire('agent_end', ctx);
    t.fire('agent_start', makeCtx({ kind: 'sub', id: 'sub-1' }));
    await t.fire('session_shutdown', ctx);
    const events = t.habblaud.of('/api/omp/events').map((c) => c.body);
    expect(events.map((e) => e?.event)).toEqual(['session_start', 'agent_start', 'tool_start', 'tool_end', 'approval_requested', 'approval_resolved', 'agent_end', 'session_shutdown']);
    expect(events.every((e) => e?.sessionId === 'sess-1' && typeof e.at === 'number')).toBe(true);
    expect(events[0]).toMatchObject({ cwd: '/projetos/demo', sessionFile: expect.stringContaining('sess-1.jsonl') });
    expect(events[2]).toMatchObject({ toolName: 'bash', toolCallId: 'c1' });
    expect(events[5]).toMatchObject({ approved: false });
  });

  it('sessão trocada dentro do processo: fecha a anterior e abre a nova', async () => {
    const t = setup({ home: tmp.dir });
    t.fire('session_start', makeCtx({ id: 'a' }));
    t.fire('agent_start', makeCtx({ id: 'b' }));
    await t.fire('session_shutdown', makeCtx({ id: 'b' }));
    expect(t.habblaud.of('/api/omp/events').map((c) => `${c.body?.event}:${c.body?.sessionId}`)).toEqual(['session_start:a', 'session_shutdown:a', 'session_start:b', 'agent_start:b', 'session_shutdown:b']);
  });

  it('/new (session_switch): anuncia a sessão nova na hora e a caixa de entrada passa a ser a dela', async () => {
    const t = setup({ home: tmp.dir });
    t.fire('session_start', makeCtx({ id: 'a' }));
    t.fire('session_switch', makeCtx({ id: 'b' }), { reason: 'new' });
    await vi.waitFor(() => expect(t.habblaud.of('/api/mod/inbox').some((c) => c.body?.session === 'b')).toBe(true));
    await t.fire('session_shutdown', makeCtx({ id: 'b' }));
    expect(t.habblaud.of('/api/omp/events').map((c) => `${c.body?.event}:${c.body?.sessionId}`)).toEqual(['session_start:a', 'session_shutdown:a', 'session_start:b', 'session_shutdown:b']);
  });
});

describe('omp extension: mensagens', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir('habblaud-omp-ext-')));
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  const inbox = (messages: unknown[]) => (c: Call) => (c.path === '/api/mod/inbox' ? { status: 200, json: { messages } } : undefined);

  it('agente livre: a primeira inicia o turno (sem deliverAs), as outras entram como continuação; um único ack', async () => {
    const t = setup({ home: tmp.dir, answer: inbox([{ id: 'm1', text: 'rode os testes' }, { id: 'm2', text: 'depois commite' }]) });
    const ctx = makeCtx({ idle: true });
    t.fire('session_start', ctx);
    await vi.waitFor(() => expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1));
    await t.fire('session_shutdown', ctx);
    expect(t.sent).toEqual([{ text: 'rode os testes', options: undefined }, { text: 'depois commite', options: { deliverAs: 'followUp' } }]);
    expect(t.habblaud.of('/api/mod/inbox')[0].body).toEqual({ session: 'sess-1' });
    const acks = t.habblaud.of('/api/mod/inbox/ack');
    expect(acks).toHaveLength(1);
    expect(acks[0].body).toEqual({ session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] });
  });

  it('sessão trocada durante a busca: nada é entregue à nova e o ack da anterior diz que a conversa mudou', async () => {
    const SESSION_CHANGED = 'a conversa mudou (/new ou /resume) antes da entrega';
    let t: ReturnType<typeof setup> | undefined;
    const t0 = setup({
      home: tmp.dir,
      answer: (c) => {
        if (c.path !== '/api/mod/inbox' || c.body?.session !== 'a') return undefined;
        // /new chega enquanto a resposta da busca da sessão "a" está a caminho.
        t?.fire('session_switch', makeCtx({ id: 'b' }), { reason: 'new' });
        return { status: 200, json: { messages: [{ id: 'm1', text: 'oi' }, { id: 'k1', text: '', control: { model: 'x/y' } }] } };
      },
    });
    t = t0;
    t0.fire('session_start', makeCtx({ id: 'a' }));
    await vi.waitFor(() => expect(t0.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1));
    expect(t0.sent).toEqual([]);
    const ack = t0.habblaud.of('/api/mod/inbox/ack')[0].body;
    expect(ack?.session).toBe('a');
    expect(ack?.results).toEqual([
      { id: 'm1', ok: false, error: SESSION_CHANGED },
      { id: 'k1', ok: false, error: SESSION_CHANGED },
    ]);
    await t0.fire('session_shutdown', makeCtx({ id: 'b' }));
  });

  it('session_start leva a lista de modelos do omp (provedor/id)', async () => {
    const t = setup({ home: tmp.dir });
    const ctx = makeCtx({ models: [{ provider: 'anthropic', id: 'a' }, { provider: 'openai', id: 'b' }] });
    t.fire('session_start', ctx);
    await vi.waitFor(() => expect(t.habblaud.of('/api/omp/events')).toHaveLength(1));
    await t.fire('session_shutdown', ctx);
    expect(t.habblaud.of('/api/omp/events')[0].body?.models).toEqual(['anthropic/a', 'openai/b']);
  });

  it('control: troca o modelo (resolve → setModel) e o raciocínio; desconhecido ou recusado vira falha com motivo', async () => {
    const setModel = vi.fn(async (m: unknown) => (m as { id: string }).id !== 'recusado');
    const setThinkingLevel = vi.fn();
    const t = setup({
      home: tmp.dir,
      pi: { setModel, setThinkingLevel },
      answer: inbox([
        { id: 'c1', text: '', control: { model: 'openai/b', thinking: 'high' } },
        { id: 'c2', text: '', control: { model: 'openai/nao-existe' } },
        { id: 'c3', text: '', control: { model: 'recusado', thinking: 'low' } },
        { id: 'c4', text: '', control: { thinking: 'off' } },
      ]),
    });
    const ctx = makeCtx({ models: [{ provider: 'anthropic', id: 'a' }, { provider: 'openai', id: 'b' }, { provider: 'openai', id: 'recusado' }] });
    t.fire('session_start', ctx);
    await vi.waitFor(() => expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1));
    await t.fire('session_shutdown', ctx);
    expect(setModel.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['b', 'recusado']);
    expect(setThinkingLevel.mock.calls).toEqual([['high'], ['off']]);
    expect(t.sent).toEqual([]);
    expect(t.habblaud.of('/api/mod/inbox/ack')[0].body?.results).toEqual([
      { id: 'c1', ok: true },
      { id: 'c2', ok: false, error: 'modelo desconhecido' },
      { id: 'c3', ok: false, error: 'o omp recusou o modelo' },
      { id: 'c4', ok: true },
    ]);
  });

  it('o batimento repete a lista de modelos', async () => {
    vi.useFakeTimers();
    const t = setup({ home: tmp.dir });
    const ctx = makeCtx({ models: [{ provider: 'anthropic', id: 'a' }] });
    t.fire('session_start', ctx);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(t.habblaud.of('/api/omp/events').find((c) => c.body?.event === 'heartbeat')?.body?.models).toEqual(['anthropic/a']);
    await t.fire('session_shutdown', ctx);
  });

  it('agente ocupado: tudo como continuação, sem interromper', async () => {
    const t = setup({ home: tmp.dir, answer: inbox([{ id: 'm1', text: 'oi' }]) });
    const ctx = makeCtx({ idle: false });
    t.fire('session_start', ctx);
    await vi.waitFor(() => expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1));
    await t.fire('session_shutdown', ctx);
    expect(t.sent).toEqual([{ text: 'oi', options: { deliverAs: 'followUp' } }]);
  });

  it('texto vazio e erro na entrega viram falha com motivo; as outras seguem', async () => {
    const handlers = new Map<string, Handler>();
    const pi: OmpApi = {
      on: (e, h) => void handlers.set(e, h),
      sendUserMessage: (text) => {
        if (text === 'boom') throw new Error('sessão\nfechada');
      },
    };
    const habblaud = fakeHabblaud(inbox([{ id: 'm1', text: '  ' }, { id: 'm2', text: 'boom' }, { id: 'm3', text: 'ok' }]));
    create(pi, { env: {}, home: tmp.dir, fetch: habblaud.fetchImpl, now: () => 1, shared: {} });
    const ctx = makeCtx();
    await handlers.get('session_start')?.({}, ctx);
    await vi.waitFor(() => expect(habblaud.of('/api/mod/inbox/ack')).toHaveLength(1));
    await handlers.get('session_shutdown')?.({}, ctx);
    expect(habblaud.of('/api/mod/inbox/ack')[0].body?.results).toEqual([
      { id: 'm1', ok: false, error: 'mensagem vazia' },
      { id: 'm2', ok: false, error: 'sessão fechada' },
      { id: 'm3', ok: true },
    ]);
  });

  it('403 (mensagens desligadas) ou fora do ar: nada é entregue e a próxima pergunta só vem depois de 30 s', async () => {
    vi.useFakeTimers();
    for (const answer of [() => ({ status: 403, json: { error: 'x' } }), () => 'down' as const]) {
      const t = setup({ home: tmp.dir, answer: (c) => (c.path === '/api/mod/inbox' ? answer() : undefined) });
      const ctx = makeCtx();
      t.fire('session_start', ctx);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(t.habblaud.of('/api/mod/inbox')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.habblaud.of('/api/mod/inbox')).toHaveLength(2);
      expect(t.sent).toEqual([]);
      await t.fire('session_shutdown', ctx);
    }
  });
});

describe('omp extension: modo de decisão', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir('habblaud-omp-ext-')));
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  const ENV = { HABBLAUD_OMP_PERMISSOES: '1' };
  const call = (t: ReturnType<typeof setup>, ctx: OmpContext, toolName = 'bash') => t.fire('tool_call', ctx, { toolName, toolCallId: 'c1', input: { command: 'rm -rf x' } }) as Promise<unknown>;
  it('leitura nunca registra pedido; sem o modo ligado nem existe handler de tool_call', async () => {
    const t = setup({ home: tmp.dir, env: ENV });
    expect(await call(t, makeCtx(), 'read')).toBeUndefined();
    expect(t.habblaud.of('/api/permissions')).toHaveLength(0);
  });

  it('recusa no Habblaud: bloqueia com o motivo escrito (ou "recusado no Habblaud"), o diálogo é cancelado', async () => {
    for (const [message, reason] of [['não apague essa pasta', 'não apague essa pasta'], [undefined, 'recusado no Habblaud']] as const) {
      const t = setup({
        home: tmp.dir,
        env: ENV,
        answer: (c) => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1', expiresAt: 1 } } : c.path.endsWith('/wait') ? { status: 200, json: { status: 'decided', behavior: 'deny', ...(message ? { message } : {}) } } : undefined),
      });
      const ctx = makeCtx({ hasUI: true });
      expect(await call(t, ctx)).toEqual({ block: true, reason });
      expect(ctx.aborted).toBe(true);
      expect(t.habblaud.of('/api/permissions')[0].body).toMatchObject({ provider: 'omp', session_id: 'sess-1', tool_name: 'bash', tool_input: { command: 'rm -rf x' }, cwd: '/projetos/demo', timeout_ms: DECISION_UI_MS });
      expect(t.habblaud.of('/api/permissions/p1/decision')).toHaveLength(0);
    }
  });

  it('permitido no Habblaud: a ferramenta segue e o diálogo fecha', async () => {
    const t = setup({ home: tmp.dir, env: ENV, answer: (c) => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1' } } : c.path.endsWith('/wait') ? { status: 200, json: { status: 'decided', behavior: 'allow' } } : undefined) });
    const ctx = makeCtx({ hasUI: true });
    expect(await call(t, ctx)).toBeUndefined();
    expect(ctx.aborted).toBe(true);
  });

  it('respondido no terminal primeiro: retira o pedido ({behavior: terminal}); recusa = "recusado no terminal"', async () => {
    for (const allow of [false, true]) {
      const t = setup({ home: tmp.dir, env: ENV, answer: (c) => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1' } } : c.path.endsWith('/wait') ? 'hang' : undefined) });
      const ctx = makeCtx({ hasUI: true, confirm: async () => allow });
      expect(await call(t, ctx)).toEqual(allow ? undefined : { block: true, reason: 'recusado no terminal' });
      expect(t.habblaud.of('/api/permissions/p1/decision')).toHaveLength(1);
      expect(t.habblaud.of('/api/permissions/p1/decision')[0].body).toEqual({ behavior: 'terminal' });
    }
  });

  it('sem UI e sem resposta: recusa "sem resposta a tempo" antes do prazo do omp, com timeout_ms = prazo − 3 s', async () => {
    const t = setup({ home: tmp.dir, env: { ...ENV, HABBLAUD_OMP_TIMEOUT_MS: '4000' }, answer: (c) => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1' } } : c.path.endsWith('/wait') ? 'hang' : undefined) });
    vi.useFakeTimers();
    const result = call(t, makeCtx({ hasUI: false }));
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ block: true, reason: 'sem resposta a tempo' });
    expect(t.habblaud.of('/api/permissions')[0].body?.timeout_ms).toBe(1_000);
  });

  it('Habblaud fora do ar (ou sem aceitar em 2 s): sem UI recusa "Habblaud fora do ar"; com UI só o diálogo decide', async () => {
    const down = setup({ home: tmp.dir, env: ENV, answer: (c) => (c.path === '/api/permissions' ? 'down' : undefined) });
    expect(await call(down, makeCtx({ hasUI: false }))).toEqual({ block: true, reason: 'Habblaud fora do ar' });
    const withUI = setup({ home: tmp.dir, env: ENV, answer: (c) => (c.path === '/api/permissions' ? 'down' : undefined) });
    expect(await call(withUI, makeCtx({ hasUI: true, confirm: async () => true }))).toBeUndefined();
    expect(withUI.habblaud.of('/api/permissions/p1/decision')).toHaveLength(0);
  });

  it('{skip} (ninguém olhando): sem UI recusa com o motivo; com UI só o diálogo', async () => {
    const answer = (c: Call) => (c.path === '/api/permissions' ? { status: 200, json: { skip: 'no-viewers' } } : undefined);
    const noUI = setup({ home: tmp.dir, env: ENV, answer });
    expect(await call(noUI, makeCtx({ hasUI: false }))).toEqual({ block: true, reason: expect.stringContaining('no-viewers') });
    const ui = setup({ home: tmp.dir, env: ENV, answer });
    expect(await call(ui, makeCtx({ hasUI: true, confirm: async () => false }))).toEqual({ block: true, reason: 'recusado no terminal' });
  });

  it('subagente: passa pelo modo no nome da sessão principal', async () => {
    const t = setup({ home: tmp.dir, env: ENV, answer: (c) => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1' } } : c.path.endsWith('/wait') ? { status: 200, json: { status: 'decided', behavior: 'allow' } } : undefined) });
    t.fire('session_start', makeCtx({ id: 'principal' }));
    expect(await call(t, makeCtx({ kind: 'sub', id: 'sub-9' }))).toBeUndefined();
    expect(t.habblaud.of('/api/permissions')[0].body?.session_id).toBe('principal');
  });

  it('aviso único quando o omp também pergunta (modo diferente de yolo)', () => {
    const t = setup({ home: tmp.dir, env: ENV });
    const ctx = makeCtx({ hasUI: true });
    t.fire('tool_approval_requested', ctx, { toolName: 'bash', approvalMode: 'always-ask' });
    t.fire('tool_approval_requested', ctx, { toolName: 'edit', approvalMode: 'write' });
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.notices[0]).toMatch(/yolo/);
    const yolo = makeCtx({ hasUI: true, id: 'outra' });
    t.fire('tool_approval_requested', yolo, { toolName: 'bash', approvalMode: 'yolo' });
    expect(yolo.notices).toHaveLength(0);
    // sem o modo ligado, nenhum aviso
    const off = setup({ home: tmp.dir });
    const c2 = makeCtx({ hasUI: true });
    off.fire('tool_approval_requested', c2, { toolName: 'bash', approvalMode: 'always-ask' });
    expect(c2.notices).toHaveLength(0);
  });
});

describe('omp extension: ask pelo escritório', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => (tmp = tempDir('habblaud-omp-ext-')));
  afterEach(() => tmp.cleanup());

  const PARAMS = {
    questions: [
      { id: 'banco', question: 'Qual banco?', header: 'Banco', options: [{ label: 'SQLite', description: 'arquivo' }, { label: 'Postgres' }], recommended: 0 },
      { id: 'testes', question: 'Quais testes?', options: [{ label: 'Unidade' }, { label: 'E2E' }], multi: true },
    ],
  };

  it('a chamada vira AskUserQuestion (header, descrição, multiSelect); fora do formato = undefined', () => {
    expect(askToHabblaud(PARAMS)).toEqual({
      questions: [
        { question: 'Qual banco?', header: 'Banco', options: [{ label: 'SQLite', description: 'arquivo' }, { label: 'Postgres' }], multiSelect: false },
        { question: 'Quais testes?', options: [{ label: 'Unidade' }, { label: 'E2E' }], multiSelect: true },
      ],
    });
    expect(askToHabblaud({ questions: [] })).toBeUndefined();
    expect(askToHabblaud({ questions: [{ id: 'x', question: 'Q', options: [{}] }] })).toBeUndefined();
  });

  it('resposta no mesmo texto do ask do omp: uma pergunta (opção, várias, texto livre de várias linhas) e várias perguntas', () => {
    const one = { questions: [PARAMS.questions[0]] };
    expect(askResult(one, [{ question: 0, options: [1] }])).toEqual({
      content: [{ type: 'text', text: 'User selected: Postgres' }],
      details: { question: 'Qual banco?', options: ['SQLite', 'Postgres'], multi: false, selectedOptions: ['Postgres'] },
    });
    expect(askResult(one, [{ question: 0, other: 'MySQL\nversão 8' }])!.content[0].text).toBe('User provided custom input:\n  MySQL\n  versão 8');
    expect(askResult({ questions: [PARAMS.questions[1]] }, [{ question: 0, options: [0, 1], other: 'carga' }])!.content[0].text).toBe('User selected: Unidade, E2E\nUser provided custom input: carga');
    const both = askResult(PARAMS, [
      { question: 0, other: 'MySQL' },
      { question: 1, options: [1] },
    ])!;
    expect(both.content[0].text).toBe('User answers:\nbanco: "MySQL"\ntestes: [E2E]');
    expect(both.details).toMatchObject({ results: [{ id: 'banco', customInput: 'MySQL', selectedOptions: [] }, { id: 'testes', selectedOptions: ['E2E'] }] });
  });

  /** omp falso com o `ask` nativo: o diálogo do terminal fica aberto até `answerLocal` ou o signal. */
  function askSetup(answer: Parameters<typeof fakeHabblaud>[0]) {
    const tools: ToolDefinition[] = [];
    const handlers = new Map<string, Handler>();
    const NATIVE_SCHEMA = { kind: 'schema-do-omp' };
    const pi: OmpApi = {
      on: (event, h) => void handlers.set(event, h),
      sendUserMessage: () => undefined,
      getAllTools: () => [{ name: 'ask', description: 'descrição nativa', parameters: NATIVE_SCHEMA }, ...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))],
      registerTool: (t) => void tools.push(t),
    };
    const habblaud = fakeHabblaud(answer);
    create(pi, { env: {}, home: tmp.dir, fetch: habblaud.fetchImpl, now: () => 1_000, shared: {} });
    const local = Promise.withResolvers<unknown>();
    let nativeSignal: AbortSignal | undefined;
    const ctx: ToolContext = {
      ...makeCtx({ hasUI: true }),
      invokeTool: (_params, options) => {
        nativeSignal = options?.signal;
        options?.signal?.addEventListener('abort', () => local.reject(new Error('Ask input was cancelled')), { once: true });
        return local.promise;
      },
    };
    handlers.get('session_start')?.({}, ctx);
    handlers.get('session_start')?.({}, ctx);
    const run = () => tools[0].execute('call-1', PARAMS, undefined, undefined, ctx);
    return { tools, habblaud, run, local, nativeAborted: () => nativeSignal?.aborted === true, schema: NATIVE_SCHEMA };
  }

  type Answer = ReturnType<Parameters<typeof fakeHabblaud>[0]>;
  const registerOk = (c: Call, wait: Answer): Answer => (c.path === '/api/permissions' ? { status: 201, json: { id: 'p1' } } : c.path.endsWith('/wait') ? wait : undefined);

  it('troca o ask uma vez só, com a descrição e o schema do nativo e aprovação de leitura', () => {
    const t = askSetup(() => undefined);
    expect(t.tools).toHaveLength(1);
    expect(t.tools[0]).toMatchObject({ name: 'ask', description: 'descrição nativa', parameters: t.schema, approval: 'read' });
  });

  it('respondido no escritório: fecha o diálogo do terminal e devolve o texto do ask; o pedido vai como AskUserQuestion', async () => {
    const t = askSetup((c) => registerOk(c, { status: 200, json: { status: 'decided', behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [0, 1] }] } }));
    const result = (await t.run()) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe('User answers:\nbanco: SQLite\ntestes: [Unidade, E2E]');
    expect(t.nativeAborted()).toBe(true);
    expect(t.habblaud.of('/api/permissions')[0].body).toMatchObject({ provider: 'omp', tool_name: ASK_TOOL, timeout_ms: ASK_WAIT_MS, tool_input: askToHabblaud(PARAMS) });
    expect(t.habblaud.of('/api/permissions/p1/decision')).toHaveLength(0);
  });

  it('respondido no terminal primeiro: devolve o nativo e retira o cartão ({behavior: terminal})', async () => {
    const t = askSetup((c) => registerOk(c, 'hang'));
    const pending = t.run();
    t.local.resolve({ content: [{ type: 'text', text: 'User selected: Postgres' }] });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'User selected: Postgres' }] });
    expect(t.habblaud.of('/api/permissions/p1/decision')[0].body).toEqual({ behavior: 'terminal' });
  });

  it('"Não responder" no escritório: fecha o diálogo e vira erro da ferramenta com o motivo', async () => {
    const t = askSetup((c) => registerOk(c, { status: 200, json: { status: 'decided', behavior: 'deny', message: 'decida você' } }));
    await expect(t.run()).rejects.toThrow('User declined to answer: decida você');
    expect(t.nativeAborted()).toBe(true);
  });

  it('Habblaud fora do ar ou sem ninguém olhando: só o diálogo do terminal', async () => {
    for (const answer of [() => 'down' as const, (c: Call) => (c.path === '/api/permissions' ? { status: 200, json: { skip: 'no-viewers' } } : undefined)]) {
      const t = askSetup(answer);
      const pending = t.run();
      t.local.resolve('nativo');
      expect(await pending).toBe('nativo');
      expect(t.nativeAborted()).toBe(false);
    }
  });
});
