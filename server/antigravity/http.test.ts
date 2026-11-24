import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { AntigravityLive } from '../sources/antigravity/live';
import { antigravityAccountOf, parseAntigravityEvent } from './http';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

async function startServer(antigravityLive?: AntigravityLive): Promise<{ base: string; accounts: AccountsService }> {
  const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore('/tmp/habblaud-test-names-agy-http.json'),
    version: 'test',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
  });
  const hub = new Hub(office, { throttleMs: 10, pingMs: 60_000 });
  const handler = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 'test',
    inDocker: false,
    antigravityLive,
  });
  const server = createServer((req, res) => {
    const handled = handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected address');
  return { base: `http://127.0.0.1:${addr.port}`, accounts };
}

function send(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        method: opts.method ?? 'POST',
        headers: { Host: `127.0.0.1:${u.port}`, Connection: 'close', ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('parseAntigravityEvent & antigravityAccountOf', () => {
  it('valida camelCase hookEventName e snake_case hook_event_name', () => {
    expect(parseAntigravityEvent({ account: '  antigravity-cli  ', antigravityHome: ' /home/u/.gemini/antigravity-cli ', event: { hookEventName: 'PreToolUse', conversationId: 'c1' } })).toEqual({
      account: 'antigravity-cli',
      antigravityHome: '/home/u/.gemini/antigravity-cli',
      event: { hookEventName: 'PreToolUse', conversationId: 'c1' },
    });
    expect(parseAntigravityEvent({ event: { hook_event_name: 'Stop' } })).toEqual({
      event: { hook_event_name: 'Stop' },
    });
    expect(() => parseAntigravityEvent(null)).toThrow();
    expect(() => parseAntigravityEvent({ event: {} })).toThrow();
  });

  it('resolve account id a partir de antigravityHome quando bate com uma conta', () => {
    const entries = [
      {
        id: 'antigravity-cli',
        provider: 'antigravity' as const,
        dir: '/home/u/.gemini/antigravity-cli',
        detected: {
          id: 'antigravity-cli',
          provider: 'antigravity' as const,
          configDir: '/home/u/.gemini/antigravity-cli',
          short: 'G',
          name: 'Antigravity',
          color: '#7aa2f7',
        },
      },
    ];
    expect(antigravityAccountOf(entries, 'fallback', '/home/u/.gemini/antigravity-cli/')).toBe('antigravity-cli');
    expect(antigravityAccountOf(entries, 'fallback', '/other')).toBe('fallback');
    expect(antigravityAccountOf(entries, undefined, 'relative/path')).toBeUndefined();
  });
});

describe('POST /api/antigravity/events', () => {
  it('repassa evento válido ao antigravityLive com conta resolvida pelo antigravityHome', async () => {
    const calls: Array<{ account: string | undefined; event: Record<string, unknown> }> = [];
    const { base, accounts } = await startServer({
      applyHookEvent(account, event) {
        calls.push({ account, event });
        return event.hookEventName === 'PreToolUse';
      },
    });
    accounts.setProviderAccounts('antigravity', [
      {
        dir: '/tmp/agy-home',
        detected: {
          id: 'agy-home',
          provider: 'antigravity',
          configDir: '/tmp/agy-home',
          short: 'G',
          name: 'Antigravity',
          color: '#7aa2f7',
        },
      },
    ]);

    const ok = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        antigravityHome: '/tmp/agy-home',
        event: { hookEventName: 'PreToolUse', conversationId: 'c1' },
      }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    expect(calls).toEqual([{ account: 'agy-home', event: { hookEventName: 'PreToolUse', conversationId: 'c1' } }]);

    const ignored = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { hookEventName: 'UnknownEvent' } }),
    });
    expect(ignored.status).toBe(200);
    expect(JSON.parse(ignored.body)).toEqual({ ok: false });
  });

  it('devolve {ok: false} quando antigravityLive está desligado e aplica guardas HTTP', async () => {
    const { base } = await startServer();

    const noLive = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { hookEventName: 'SessionStart' } }),
    });
    expect(noLive.status).toBe(200);
    expect(JSON.parse(noLive.body)).toEqual({ ok: false });

    const badHost = await send(base, '/api/antigravity/events', {
      headers: { Host: 'evil.example:4747', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { hookEventName: 'SessionStart' } }),
    });
    expect(badHost.status).toBe(403);

    const wrongMethod = await send(base, '/api/antigravity/events', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);

    const wrongCt = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongCt.status).toBe(415);

    const badBody = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: {} }),
    });
    expect(badBody.status).toBe(400);

    const tooLarge = await send(base, '/api/antigravity/events', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { hookEventName: 'SessionStart', pad: 'x'.repeat(300 * 1024) } }),
    });
    expect(tooLarge.status).toBe(413);
  });
});
