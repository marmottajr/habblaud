// Rotas do bate-papo paralelo pelas rotas de verdade (guard e app): a página (GET/POST/cancel/DELETE em /api/asides) e a
// extensão (POST /api/omp/aside). Travas: sem o recurso (deps.asides) = 403; pela porta remota, /api/omp/aside = 403.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createAsideRoutes, handleAsideProgress } from './http';
import { AsideStore } from './store';

setQuiet(true);

const SID = '0199b0c0-1234-7abc-8def-0123456789ab';
const AGENT = `.omp:${SID}`;
// O guard exige Content-Type JSON em todo método que muda coisas, mesmo sem corpo.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(opts: { asides?: boolean; remote?: boolean } = {}) {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  office.addMain({ id: AGENT, provider: 'omp', account: '.omp', sessionId: SID, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'idle' });
  office.addMain({ id: 'acc:1', account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'idle' });
  const queued: string[] = [];
  const store = new AsideStore({
    dir: null,
    office,
    queue: (agentId, req) => (queued.push(req.question), { message: { id: `m-${queued.length}`, agentId, status: 'queued', createdAt: 0, updatedAt: 0 } }),
    discard: () => true,
  });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 't',
    inDocker: false,
    ...(opts.asides === false ? {} : { asides: { page: createAsideRoutes(store), progress: (req, res) => handleAsideProgress(req, res, store) } }),
    ...(opts.remote ? { remote: { is: () => true, allows: () => true } } : {}),
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => {
        tmp.cleanup();
        ok();
      });
    });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, queued };
}

const asTopic = (j: unknown) => (j as { topic: { id: string; turns: Array<{ id: string; status: string; answer: string }> } }).topic;

describe('/api/asides (página)', () => {
  it('GET sem agentId dá 400; agente desconhecido ou fora do omp dá 404; lista vazia dá 200', async () => {
    const { base } = await serve();
    expect(await request(base, '/api/asides')).toMatchObject({ status: 400 });
    expect(await request(base, '/api/asides?agentId=nao-existe')).toMatchObject({ status: 404 });
    expect(await request(base, '/api/asides?agentId=acc:1')).toMatchObject({ status: 404 });
    expect(await request(base, `/api/asides?agentId=${encodeURIComponent(AGENT)}`)).toMatchObject({ status: 200, json: { topics: [] } });
  });

  it('POST pergunta (201), lista, para (409 sem pergunta rodando é idle), apaga e valida', async () => {
    const { base, queued } = await serve();
    expect(await request(base, '/api/asides', { method: 'POST', body: {} })).toMatchObject({ status: 400 });
    expect(await request(base, '/api/asides', { method: 'POST', body: { agentId: 'nao-existe', question: 'oi' } })).toMatchObject({ status: 404 });
    expect(await request(base, '/api/asides', { method: 'POST', body: { agentId: 'acc:1', question: 'oi' } })).toMatchObject({ status: 409 });

    const r = await request(base, '/api/asides', { method: 'POST', body: { agentId: AGENT, question: 'o que faz?' } });
    expect(r.status).toBe(201);
    const topic = asTopic(r.json);
    expect(queued).toEqual(['o que faz?']);
    // segunda pergunta enquanto a primeira espera: 409 com o motivo
    expect(await request(base, '/api/asides', { method: 'POST', body: { agentId: AGENT, question: 'e agora?', topicId: topic.id } })).toMatchObject({
      status: 409,
      json: { error: expect.stringMatching(/respondendo/) },
    });
    const list = await request(base, `/api/asides?agentId=${encodeURIComponent(AGENT)}`);
    expect((list.json as { topics: unknown[] }).topics).toHaveLength(1);

    expect(await request(base, `/api/asides/${topic.id}`, { method: 'DELETE', headers: JSON_HEADERS })).toMatchObject({ status: 400 });
    expect(await request(base, `/api/asides/${topic.id}?agentId=${encodeURIComponent(AGENT)}`, { method: 'DELETE', headers: JSON_HEADERS })).toMatchObject({ status: 409 });
    expect(await request(base, `/api/asides/${topic.id}/cancel`, { method: 'POST', body: { agentId: AGENT } })).toMatchObject({ status: 200, json: { ok: true } });
    expect(await request(base, `/api/asides/${topic.id}/cancel`, { method: 'POST', body: { agentId: AGENT } })).toMatchObject({ status: 409 });
    expect(await request(base, '/api/asides/t-nao/cancel', { method: 'POST', body: { agentId: AGENT } })).toMatchObject({ status: 404 });
    expect(await request(base, `/api/asides/${topic.id}?agentId=${encodeURIComponent(AGENT)}`, { method: 'DELETE', headers: JSON_HEADERS })).toMatchObject({ status: 200, json: { ok: true } });
    expect(await request(base, `/api/asides/${topic.id}?agentId=${encodeURIComponent(AGENT)}`, { method: 'DELETE', headers: JSON_HEADERS })).toMatchObject({ status: 404 });
    expect(await request(base, '/api/asides', { method: 'PUT', headers: JSON_HEADERS })).toMatchObject({ status: 405 });
  });

  it('sem deps.asides as rotas da página dão 403', async () => {
    const { base } = await serve({ asides: false });
    expect(await request(base, `/api/asides?agentId=${encodeURIComponent(AGENT)}`)).toMatchObject({ status: 403 });
    expect(await request(base, '/api/asides', { method: 'POST', body: { agentId: AGENT, question: 'oi' } })).toMatchObject({ status: 403 });
  });
});

describe('POST /api/omp/aside (extensão)', () => {
  it('corpo válido chega ao store (texto acumulado, cancel false); inválido dá 400', async () => {
    const { base, store } = await serve();
    const t = asTopic((await request(base, '/api/asides', { method: 'POST', body: { agentId: AGENT, question: 'oi' } })).json);
    const turnId = t.turns[0]!.id;
    const r = await request(base, '/api/omp/aside', { method: 'POST', body: { sessionId: SID, turnId, text: 'olá', state: 'running' } });
    expect(r).toMatchObject({ status: 200, json: { cancel: false } });
    expect(store.list(AGENT)!.topics[0]!.turns[0]).toMatchObject({ status: 'running', answer: 'olá' });
    expect(await request(base, '/api/omp/aside', { method: 'POST', body: { sessionId: SID, turnId, text: 'olá', state: 'nada' } })).toMatchObject({ status: 400 });
    expect(await request(base, '/api/omp/aside', { method: 'POST', body: { sessionId: '../x', turnId, text: '', state: 'running' } })).toMatchObject({ status: 400 });
    expect(await request(base, '/api/omp/aside', { method: 'GET' })).toMatchObject({ status: 405 });
  });

  it('aceita uma resposta grande com aspas e quebras de linha (corpo acima de 256 KiB escapado)', async () => {
    const { base, store } = await serve();
    const t = asTopic((await request(base, '/api/asides', { method: 'POST', body: { agentId: AGENT, question: 'oi' } })).json);
    const text = '"\n'.repeat(32 * 1024);
    const r = await request(base, '/api/omp/aside', { method: 'POST', body: { sessionId: SID, turnId: t.turns[0]!.id, text, state: 'complete' } });
    expect(r.status).toBe(200);
    expect(store.list(AGENT)!.topics[0]!.turns[0]!.answer.length).toBe(text.length);
  });

  it('sem deps.asides: 403', async () => {
    const { base } = await serve({ asides: false });
    expect(await request(base, '/api/omp/aside', { method: 'POST', body: {} })).toMatchObject({ status: 403 });
  });

  it('pela porta remota: 403 (a rota é só do próprio computador)', async () => {
    const { base } = await serve({ remote: true });
    expect(await request(base, '/api/omp/aside', { method: 'POST', body: {} })).toMatchObject({ status: 403 });
  });
});
