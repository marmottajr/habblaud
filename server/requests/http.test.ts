// Rotas de /api/requests: desligado sem token, token obrigatório nas rotas do serviço, Host local, sem CORS, o fluxo
// completo (registrar → snapshot → escolher → long-poll) e a escolha única.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createRequestRoutes, tokenMatches } from './http';
import { RequestRegistry } from './registry';

setQuiet(true);

const TOKEN = 'segredo-de-teste';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Srv {
  base: string;
  office: Office;
  hub: Hub;
  close(): Promise<void>;
}

let srv: Srv | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

async function serve(opts: { enabled?: boolean } = {}): Promise<Srv> {
  const tmp = tempDir();
  const enabled = opts.enabled ?? true;
  const late: { reg?: RequestRegistry } = {};
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: true,
    requests: enabled ? () => late.reg?.pending() ?? [] : undefined,
  });
  const hub = new Hub(office, { throttleMs: 10 });
  const reg = enabled ? new RequestRegistry({ onChange: () => office.markDirty(), tickMs: 50 }) : undefined;
  late.reg = reg;
  reg?.start();
  const api = createApiHandler({
    office,
    hub,
    accounts: new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} }),
    sources: () => [],
    version: 't',
    inDocker: false,
    terminal: true,
    requests: reg ? createRequestRoutes(reg, TOKEN) : undefined,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    office,
    hub,
    close: () =>
      new Promise((ok) => {
        reg?.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      }),
  };
}

const pedido = (over: Record<string, unknown> = {}) => ({
  source: 'painel',
  externalId: 'dec-1',
  title: 'Qual banco usar?',
  options: [
    { id: 'pg', label: 'Postgres' },
    { id: 'sqlite', label: 'SQLite' },
  ],
  recommended: 'pg',
  ...over,
});

const register = (s: Srv, over: Record<string, unknown> = {}, headers: Record<string, string> = AUTH) =>
  request(s.base, '/api/requests', { method: 'POST', body: pedido(over), headers });

describe('tokenMatches', () => {
  it('só Bearer com o token exato', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`bearer  ${TOKEN} `, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches('Bearer ', TOKEN)).toBe(false);
  });
});

describe('trava', () => {
  it('desligado (sem token): 403 em todas as rotas e nada no snapshot', async () => {
    srv = await serve({ enabled: false });
    for (const [method, path] of [
      ['POST', '/api/requests'],
      ['GET', '/api/requests/x/wait'],
      ['GET', '/api/requests/x'],
      ['POST', '/api/requests/x/decision'],
    ]) {
      const r = await request(srv.base, path, { method, body: method === 'POST' ? {} : undefined, headers: AUTH });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json).toMatchObject({ error: expect.stringMatching(/desligados/) });
    }
    expect((await request(srv.base, '/api/snapshot')).json as OfficeSnapshot).not.toHaveProperty('requests');
    expect((await request(srv.base, '/api/health')).json).toMatchObject({ requests: false });
  });

  it('rotas do serviço sem token ou com token errado: 401', async () => {
    srv = await serve();
    expect((await register(srv, {}, {})).status).toBe(401);
    expect((await register(srv, {}, { Authorization: 'Bearer errado' })).status).toBe(401);
    expect((await request(srv.base, '/api/requests/x/wait?timeout=0.1')).status).toBe(401);
    expect((await request(srv.base, '/api/requests/x')).status).toBe(401);
    expect((await request(srv.base, '/api/requests/x/withdraw', { method: 'POST', body: {} })).status).toBe(401);
  });

  it('Host que não é local: 403, mesmo com o token', async () => {
    srv = await serve();
    const r = await register(srv, {}, { ...AUTH, Host: 'habblaud.lan' });
    expect(r.status).toBe(403);
    const d = await request(srv.base, '/api/requests/x/decision', { method: 'POST', body: { option: 'pg' }, headers: { Host: 'habblaud.lan' } });
    expect(d.status).toBe(403);
  });

  it('sem CORS: nenhum cabeçalho Access-Control-*, nem no OPTIONS; POST de outra origem barrado', async () => {
    srv = await serve();
    const raw = (method: string) =>
      new Promise<http.IncomingHttpHeaders>((ok, fail) => {
        const u = new URL(srv!.base);
        const req = http.request(
          { host: u.hostname, port: u.port, path: '/api/requests', method, headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } },
          (res) => {
            res.resume();
            res.on('end', () => ok(res.headers));
          },
        );
        req.on('error', fail);
        req.end();
      });
    for (const method of ['OPTIONS', 'GET']) {
      const headers = await raw(method);
      expect(Object.keys(headers).filter((k) => k.startsWith('access-control-')), method).toEqual([]);
    }
    expect((await register(srv, {}, { ...AUTH, Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('fluxo', () => {
  it('registrar → snapshot → long-poll → escolher (uma vez só)', async () => {
    srv = await serve();
    const r = await register(srv);
    expect(r.status).toBe(201);
    const { id } = r.json as { id: string };
    expect(r.json).toMatchObject({ id, status: 'pending', source: 'painel', externalId: 'dec-1' });
    // Repetir é seguro: 200 com o mesmo pedido.
    const again = await register(srv);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id });

    srv.office.markDirty();
    await new Promise((ok) => setTimeout(ok, 30));
    const snap = (await request(srv.base, '/api/snapshot')).json as OfficeSnapshot;
    expect(snap.requests).toEqual([expect.objectContaining({ id, title: 'Qual banco usar?', recommended: 'pg' })]);
    expect(snap.agents).toEqual([]);

    const waiting = request(srv.base, `/api/requests/${id}/wait?timeout=5`, { headers: AUTH });
    await new Promise((ok) => setTimeout(ok, 30));
    // A página escolhe sem token (a trava é o Host local, como nas permissões).
    expect((await request(srv.base, `/api/requests/${id}/decision`, { method: 'POST', body: { option: 'mysql' } })).status).toBe(400);
    expect((await request(srv.base, `/api/requests/${id}/decision`, { method: 'POST', body: { option: 'sqlite' } })).status).toBe(200);
    const w = await waiting;
    expect(w.status).toBe(200);
    expect(w.json).toMatchObject({ id, status: 'decided', option: 'sqlite' });

    const second = await request(srv.base, `/api/requests/${id}/decision`, { method: 'POST', body: { option: 'pg' } });
    expect(second.status).toBe(409);
    expect((await request(srv.base, `/api/requests/${id}`, { headers: AUTH })).json).toMatchObject({ status: 'decided', option: 'sqlite' });
    expect((await request(srv.base, `/api/requests/${id}/withdraw`, { method: 'POST', body: {}, headers: AUTH })).status).toBe(409);

    srv.office.markDirty();
    await new Promise((ok) => setTimeout(ok, 30));
    expect(((await request(srv.base, '/api/snapshot')).json as OfficeSnapshot).requests).toEqual([]);
  });

  it('long-poll sem escolha volta pendente; retirar encerra; corpo inválido 400; desconhecido 404; métodos 405', async () => {
    srv = await serve();
    const { id } = (await register(srv)).json as { id: string };
    const w = await request(srv.base, `/api/requests/${id}/wait?timeout=0.1`, { headers: AUTH });
    expect(w.json).toMatchObject({ status: 'pending' });
    expect((await request(srv.base, `/api/requests/${id}/withdraw`, { method: 'POST', body: {}, headers: AUTH })).status).toBe(200);
    expect((await request(srv.base, `/api/requests/${id}`, { headers: AUTH })).json).toMatchObject({ status: 'withdrawn' });
    expect((await request(srv.base, `/api/requests/${id}/decision`, { method: 'POST', body: { option: 'pg' } })).status).toBe(404);
    expect((await register(srv, { options: [] })).status).toBe(400);
    expect((await request(srv.base, '/api/requests/nao-existe/wait?timeout=0.1', { headers: AUTH })).status).toBe(404);
    expect((await request(srv.base, '/api/requests/nao-existe/decision', { method: 'POST', body: {} })).status).toBe(400);
    expect((await request(srv.base, '/api/requests', { headers: AUTH })).status).toBe(405);
    expect((await request(srv.base, `/api/requests/${id}/wait`, { method: 'POST', body: {}, headers: AUTH })).status).toBe(405);
  });
});
