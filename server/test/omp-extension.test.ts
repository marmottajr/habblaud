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

  describe('ack da caixa de entrada', () => {
    /** Caixa que entrega o lote uma vez só; `ack` responde pelo que o teste pedir (undefined = 200). */
    function once(ack: () => { status: number; json: unknown } | 'down' | undefined) {
      let delivered = false;
      return (c: Call) => {
        if (c.path === '/api/mod/inbox') {
          const messages = delivered ? [] : [{ id: 'm1', text: 'oi' }];
          delivered = true;
          return { status: 200, json: { messages } };
        }
        return c.path === '/api/mod/inbox/ack' ? ack() : undefined;
      };
    }

    it('ack perdido é repetido com o mesmo corpo até chegar', async () => {
      vi.useFakeTimers();
      let n = 0;
      const t = setup({ home: tmp.dir, answer: once(() => (++n <= 2 ? 'down' : undefined)) });
      const ctx = makeCtx();
      t.fire('session_start', ctx);
      await vi.advanceTimersByTimeAsync(2_000);
      const acks = t.habblaud.of('/api/mod/inbox/ack');
      expect(acks).toHaveLength(3);
      for (const a of acks) expect(a.body).toEqual({ session: 'sess-1', results: [{ id: 'm1', ok: true }] });
      expect(t.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(3);
      await t.fire('session_shutdown', ctx);
    });

    it('ack que o servidor recusou com 4xx não é repetido', async () => {
      vi.useFakeTimers();
      const t = setup({ home: tmp.dir, answer: once(() => ({ status: 400, json: {} })) });
      const ctx = makeCtx();
      t.fire('session_start', ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1);
      await t.fire('session_shutdown', ctx);
    });

    it('ack que nunca chega para depois de 4 tentativas (1 + ACK_RETRY_MS) e a caixa de entrada segue funcionando', async () => {
      vi.useFakeTimers();
      const t = setup({ home: tmp.dir, answer: once(() => ({ status: 503, json: {} })) });
      const ctx = makeCtx();
      t.fire('session_start', ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(4);
      expect(t.habblaud.of('/api/mod/inbox').length).toBeGreaterThanOrEqual(2);
      await t.fire('session_shutdown', ctx);
    });

    it('encerrar a sessão no meio das repetições para de repetir', async () => {
      vi.useFakeTimers();
      const t = setup({ home: tmp.dir, answer: once(() => 'down') });
      const ctx = makeCtx();
      t.fire('session_start', ctx);
      await vi.advanceTimersByTimeAsync(10);
      expect(t.habblaud.of('/api/mod/inbox/ack')).toHaveLength(1);
      await t.fire('session_shutdown', ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.habblaud.of('/api/mod/inbox/ack').length).toBeLessThanOrEqual(2);
    });
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

describe('omp extension: pergunta paralela', () => {
  type EphemeralOpts = Parameters<NonNullable<OmpContext['runEphemeralTurn']>>[0];
  type AsideItem = { topicId: string; turnId: string; index: number; question: string; history: Array<{ question: string; answer: string; createdAt: number; updatedAt: number }> };
  const REQ: AsideItem = { topicId: 't-1', turnId: 'q-1', index: 0, question: 'o que faz?', history: [] };
  const MODEL = { provider: 'anthropic', id: 'sonnet', api: 'anthropic-messages' };

  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir('habblaud-omp-ext-');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    tmp.cleanup();
  });

  /** Um omp com o Habblaud falso: o inbox entrega os itens uma vez; `runEphemeralTurn` fica nas mãos do teste. */
  function rig(o: { items?: AsideItem[]; noEphemeral?: boolean; model?: { provider: string; id: string; api?: string }; asideAnswer?: (c: Call) => ReturnType<Parameters<typeof fakeHabblaud>[0]> } = {}) {
    const state = { cancel: false, delivered: false };
    const turn = Promise.withResolvers<{ replyText: string }>();
    const runs: EphemeralOpts[] = [];
    const t = setup({
      home: tmp.dir,
      answer: (c) => {
        if (c.path === '/api/mod/inbox') {
          const messages = state.delivered ? [] : (o.items ?? [REQ]).map((aside, i) => ({ id: `a${i + 1}`, text: '', aside }));
          state.delivered = true;
          return { status: 200, json: { messages } };
        }
        if (c.path === '/api/omp/aside') return o.asideAnswer?.(c) ?? { status: 200, json: { cancel: state.cancel } };
        return undefined;
      },
    });
    const ctx = Object.assign(makeCtx(), {
      models: { list: () => [], current: () => o.model },
      ...(o.noEphemeral
        ? {}
        : {
            runEphemeralTurn: (opts: EphemeralOpts) => {
              runs.push(opts);
              return turn.promise;
            },
          }),
    });
    return { t, ctx, state, turn, runs, posts: () => t.habblaud.of('/api/omp/aside').map((c) => c.body), acks: () => t.habblaud.of('/api/mod/inbox/ack').map((c) => c.body) };
  }

  it('confirma na hora, antes de a resposta acabar; os deltas viram POSTs com o texto acumulado e o fim manda complete', async () => {
    const r = rig();
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.acks()).toEqual([{ session: 'sess-1', results: [{ id: 'a1', ok: true }] }]);
    expect(r.runs).toHaveLength(1);

    r.runs[0].onTextDelta?.('Olá');
    await vi.advanceTimersByTimeAsync(600);
    r.runs[0].onTextDelta?.(' mundo');
    await vi.advanceTimersByTimeAsync(600);
    const running = r.posts().filter((b) => b?.state === 'running');
    expect(running.map((b) => b?.text)).toEqual(expect.arrayContaining(['Olá', 'Olá mundo']));
    expect(running[0]).toMatchObject({ sessionId: 'sess-1', turnId: 'q-1' });

    r.turn.resolve({ replyText: 'Olá mundo!' });
    await vi.advanceTimersByTimeAsync(50);
    expect(r.posts().at(-1)).toEqual({ sessionId: 'sess-1', turnId: 'q-1', text: 'Olá mundo!', state: 'complete' });
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('chama runEphemeralTurn com dedupeReply false, conversationKey hb:<tópico>:<índice>, sem maxTokens nem tools', async () => {
    const r = rig({ items: [{ ...REQ, index: 3 }] });
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.runs[0]).toMatchObject({ promptText: 'o que faz?', conversationKey: 'hb:t-1:3', dedupeReply: false });
    expect(r.runs[0]).not.toHaveProperty('maxTokens');
    expect(r.runs[0]).not.toHaveProperty('tools');
    expect(r.runs[0].signal).toBeInstanceOf(AbortSignal);
    r.turn.resolve({ replyText: 'ok' });
    await vi.advanceTimersByTimeAsync(50);
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('o history sai no formato do /btw do omp (user/assistant); sem o modelo ou sem api, vai como texto na pergunta', async () => {
    const history = [
      { question: 'um', answer: 'r1', createdAt: 1, updatedAt: 2 },
      { question: 'dois', answer: '', createdAt: 3, updatedAt: 3 },
    ];
    const withModel = rig({ items: [{ ...REQ, index: 2, history }], model: MODEL });
    withModel.t.fire('session_start', withModel.ctx);
    await vi.advanceTimersByTimeAsync(50);
    const h = withModel.runs[0].history as Array<Record<string, unknown>>;
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(h[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'um' }], attribution: 'agent', timestamp: 1 });
    expect(h[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'r1' }], api: 'anthropic-messages', provider: 'anthropic', model: 'sonnet', stopReason: 'stop', timestamp: 2 });
    expect(h[1].usage).toMatchObject({ totalTokens: 0, cost: { total: 0 } });
    expect(withModel.runs[0].promptText).toBe('o que faz?');
    withModel.turn.resolve({ replyText: '' });
    await vi.advanceTimersByTimeAsync(50);
    await withModel.t.fire('session_shutdown', withModel.ctx);

    const noApi = rig({ items: [{ ...REQ, index: 2, history }], model: { provider: 'anthropic', id: 'sonnet' } });
    noApi.t.fire('session_start', noApi.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(noApi.runs[0].history).toBeUndefined();
    expect(noApi.runs[0].promptText).toContain('Pergunta anterior: um\nResposta: r1');
    expect(noApi.runs[0].promptText).toContain('Pergunta anterior: dois');
    expect(noApi.runs[0].promptText.endsWith('Pergunta: o que faz?')).toBe(true);
    noApi.turn.resolve({ replyText: '' });
    await vi.advanceTimersByTimeAsync(50);
    await noApi.t.fire('session_shutdown', noApi.ctx);
  });

  it('uma resposta {cancel: true} aborta o signal e o último POST é cancelled', async () => {
    const r = rig();
    r.ctx.runEphemeralTurn = (opts) => {
      r.runs.push(opts);
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('abortado')), { once: true }));
    };
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    r.runs[0].onTextDelta?.('par');
    r.state.cancel = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(r.runs[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.posts().at(-1)).toMatchObject({ turnId: 'q-1', state: 'cancelled', text: 'par' });
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('runEphemeralTurn que rejeita dá failed com o texto do erro', async () => {
    const r = rig();
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    r.turn.reject(new Error('Active model changed during ephemeral turn; retry.'));
    await vi.advanceTimersByTimeAsync(50);
    expect(r.posts().at(-1)).toMatchObject({ state: 'failed', error: 'Active model changed during ephemeral turn; retry.' });
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('sem runEphemeralTurn no contexto: ack ok: false com o motivo e nada vai a /api/omp/aside', async () => {
    const r = rig({ noEphemeral: true });
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.acks()[0]?.results).toEqual([{ id: 'a1', ok: false, error: 'este omp não faz perguntas paralelas pela extensão (atualize o omp)' }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.posts()).toEqual([]);
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('uma segunda pergunta durante a primeira dá ack ok: false', async () => {
    const r = rig({ items: [REQ, { ...REQ, turnId: 'q-2', index: 1 }] });
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.acks()[0]?.results).toEqual([
      { id: 'a1', ok: true },
      { id: 'a2', ok: false, error: 'já há uma pergunta paralela em andamento' },
    ]);
    expect(r.runs).toHaveLength(1);
    r.turn.resolve({ replyText: 'ok' });
    await vi.advanceTimersByTimeAsync(50);
    await r.t.fire('session_shutdown', r.ctx);
  });

  it('fechar a sessão ou trocar de conversa aborta a pergunta em andamento', async () => {
    const r = rig();
    r.t.fire('session_start', r.ctx);
    await vi.advanceTimersByTimeAsync(50);
    r.t.fire('session_switch', makeCtx({ id: 'sess-2' }), { reason: 'new' });
    expect(r.runs[0].signal?.aborted).toBe(true);
    r.turn.reject(new Error('abortado'));
    await vi.advanceTimersByTimeAsync(50);
    // o fim da pergunta vai com o id da sessão em que ela foi feita
    expect(r.posts().at(-1)).toMatchObject({ sessionId: 'sess-1', turnId: 'q-1', state: 'cancelled' });
    await r.t.fire('session_shutdown', makeCtx({ id: 'sess-2' }));

    const s = rig();
    s.t.fire('session_start', s.ctx);
    await vi.advanceTimersByTimeAsync(50);
    await s.t.fire('session_shutdown', s.ctx);
    expect(s.runs[0].signal?.aborted).toBe(true);
    s.turn.reject(new Error('abortado'));
    await vi.advanceTimersByTimeAsync(50);
  });

  it('Habblaud fora do ar durante a resposta: nenhuma rejeição escapa e a pergunta termina', async () => {
    const escaped: unknown[] = [];
    const onRejection = (e: unknown) => void escaped.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const r = rig({ asideAnswer: () => 'down' });
      r.t.fire('session_start', r.ctx);
      await vi.advanceTimersByTimeAsync(50);
      r.runs[0].onTextDelta?.('texto');
      await vi.advanceTimersByTimeAsync(1_500);
      r.turn.resolve({ replyText: 'texto' });
      await vi.advanceTimersByTimeAsync(50);
      expect(r.posts().length).toBeGreaterThan(1);
      await r.t.fire('session_shutdown', r.ctx);
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(escaped).toEqual([]);
  });

  it('parseInbox: aside válido entra com o texto vazio; aside fora do formato entra sem aside (vira "mensagem vazia")', () => {
    const body = JSON.stringify({
      messages: [
        { id: 'a', text: '', aside: { ...REQ, history: [{ question: 'x', answer: 'y', createdAt: 1, updatedAt: 2 }, { question: 5 }] } },
        { id: 'b', text: '', aside: { topicId: 't', turnId: 'q', index: 'zero', question: 'p', history: [] } },
        { id: 'c', text: '', aside: 'não' },
      ],
    });
    expect(parseInbox(body)).toEqual([
      { id: 'a', text: '', aside: { ...REQ, history: [{ question: 'x', answer: 'y', createdAt: 1, updatedAt: 2 }] } },
      { id: 'b', text: '' },
      { id: 'c', text: '' },
    ]);
  });
});
