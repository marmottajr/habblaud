// Rota dos eventos da extensão do omp (POST /api/omp/events) pelas rotas de verdade (guard e app): repassa à fonte do omp
// ao vivo (um falso) só com Host local e, fora do Docker, conexão pelo loopback; só POST com JSON; corpo fora do
// formato = 400 sem tocar a fonte; sem a fonte, {ok: false}. Mais o ciclo ponta a ponta com a OmpSource e o /api/health.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OmpEvent } from '../../shared/omp-events';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { OmpLive } from '../sources/omp/live';
import { OmpSource } from '../sources/omp/source';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

setQuiet(true);

const EVENT: OmpEvent = { event: 'session_start', sessionId: '01a20000-0000-7000-8000-000000000001', cwd: '/p/loja', at: 1_700_000_000_000 };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(live?: OmpLive, extra: { office?: Office } = {}): Promise<{ base: string; api: ReturnType<typeof createApiHandler> }> {
  const tmp = tempDir();
  const office = extra.office ?? new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, ompLive: live });
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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, api };
}

describe('POST /api/omp/events', () => {
  it('repassa o evento validado à fonte do omp e devolve {ok}', async () => {
    const calls: OmpEvent[] = [];
    const { base } = await serve({ applyEvent: (e) => (calls.push(e), true) });
    const r = await request(base, '/api/omp/events', { method: 'POST', body: { ...EVENT, extra: 'ignorado', toolName: ' bash ' } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls).toEqual([{ ...EVENT, toolName: 'bash' }]);
  });

  it('sem a fonte do omp (ou se ela falha ou recusa): 200 {ok: false}', async () => {
    let s = await serve();
    expect(await request(s.base, '/api/omp/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: false } });
    await close!();
    s = await serve({
      applyEvent: () => {
        throw new Error('quebrou');
      },
    });
    expect(await request(s.base, '/api/omp/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: false } });
    await close!();
    s = await serve({ applyEvent: () => false });
    expect(await request(s.base, '/api/omp/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('corpo fora do formato: 400 e a fonte não é chamada; GET: 405; sem JSON: 415; acima de 256 KB: 413', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyEvent: (e) => (calls.push(e), true) });
    const bad = [{}, [], 'x', { ...EVENT, event: 'nada' }, { ...EVENT, sessionId: '' }, { ...EVENT, at: 'ontem' }, { event: 'heartbeat', at: 1 }];
    for (const body of bad) expect((await request(base, '/api/omp/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    expect((await request(base, '/api/omp/events')).status).toBe(405);
    expect((await request(base, '/api/omp/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await request(base, '/api/omp/events', { method: 'POST', body: { ...EVENT, cwd: 'x'.repeat(300 * 1024) } })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('Host que não é local: 403 e a fonte não é chamada', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyEvent: (e) => (calls.push(e), true) });
    for (const host of ['habblaud.lan:4747', '192.168.0.10:4747']) {
      expect((await request(base, '/api/omp/events', { method: 'POST', headers: { Host: host }, body: EVENT })).status, host).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('conexão que não vem do loopback (IP da rede com Host local): 403, fora do Docker', async () => {
    const calls: unknown[] = [];
    const { api } = await serve({ applyEvent: (e) => (calls.push(e), true) });
    const fake = (remoteAddress: string) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(EVENT))]), {
        method: 'POST',
        url: '/api/omp/events',
        headers: { host: 'localhost:4747', 'content-type': 'application/json' },
        socket: { remoteAddress },
      });
      const done = Promise.withResolvers<void>();
      const out = { status: 0, body: '' };
      const res = {
        setHeader() {},
        writeHead(status: number) {
          out.status = status;
        },
        end(data?: string) {
          out.body = data ?? '';
          done.resolve();
        },
      };
      const handled = api(req as never, res as never, new URL('http://x/api/omp/events'));
      return { handled, out, done: done.promise };
    };
    const lan = fake('192.168.0.77');
    expect(lan.handled).toBe(true);
    expect(lan.out.status).toBe(403);
    expect(calls).toHaveLength(0);
    // O IPv4 em IPv6 do loopback passa.
    const lo = fake('::ffff:127.0.0.1');
    await lo.done;
    expect(lo.out.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('ponta a ponta: o evento cria o agente omp no Office real, /api/health lista ompEvents e a fonte', async () => {
    const tmp = tempDir();
    const dir = join(tmp.dir, '.omp', 'agent');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
    const source = new OmpSource({ accounts, office, dirs: [dir], env: {}, home: tmp.dir, watch: false });
    try {
      const { base } = await serve(source, { office });
      expect(await request(base, '/api/omp/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: true } });
      const agent = office.commit().snapshot.agents.find((a) => a.id === `omp:${EVENT.sessionId}`);
      expect(agent).toMatchObject({ provider: 'omp', status: 'idle', account: '.omp' });
      const health = await request(base, '/api/health');
      expect(health.json).toMatchObject({ ompEvents: true });
    } finally {
      source.stop();
      await close?.();
      close = undefined;
      tmp.cleanup();
    }
  });
});
