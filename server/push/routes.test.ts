// As rotas /api/push/* de verdade, pelo guard e pelo handler da API do upstream.
//
// O que se mede aqui são as guardas que só se vêem por HTTP:
// o endpoint deformado dá 400, o anfitrião fora da lista dá 400, o teto de aparelhos dá 409 e o teto de
// ritmo dá 429 com `Retry-After`. Mais a trava da porta e os métodos.
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
import { fakePushServer } from '../test/fake-push-server';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createPushRoutes } from './routes';
import { createPushService, WRITES_PER_MIN, type PushService } from './service';
import { MAX_SUBSCRIPTIONS } from './store';

setQuiet(true);

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const ENDPOINT = 'https://web.push.apple.com/aparelho-a';
const LOCAL = { Host: '127.0.0.1' };

const tmps: Array<{ cleanup: () => void }> = [];

interface Srv {
  base: string;
  push?: PushService;
  close(): Promise<void>;
}

async function serve(opts: { env?: NodeJS.ProcessEnv; withPush?: boolean } = {}): Promise<Srv> {
  const tmp = tempDir('push-routes-');
  tmps.push(tmp);
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => late.office?.markDirty() });
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 10 });
  // `fetch` que nunca sai da máquina, e que recusa os cabeçalhos que o servidor de push recusa: um 200 desta rota
  // com o `Topic` inválido era o que escondia o aviso que não chegava.
  const fetchFake = fakePushServer().fetch;
  const push = opts.withPush === false ? undefined : createPushService({ dataDir: tmp.dir, env: opts.env ?? {}, fetch: fetchFake });
  push?.registerType({ id: 'needs-you', label: 'Alguém precisa de você', enabled: true, ttlS: 600, urgency: 'high' });
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    push: push ? createPushRoutes(push) : undefined,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    push,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const srvs: Srv[] = [];
async function up(opts: Parameters<typeof serve>[0] = {}): Promise<Srv> {
  const s = await serve(opts);
  srvs.push(s);
  return s;
}

afterEach(async () => {
  for (const s of srvs.splice(0)) await s.close();
  for (const t of tmps.splice(0)) t.cleanup();
});

describe('GET /api/push/status', () => {
  it('responde com a chave pública e os tipos', async () => {
    const s = await up();
    const r = await request(s.base, '/api/push/status', { headers: LOCAL });
    expect(r.status).toBe(200);
    const body = r.json as { publicKey: string; types: unknown[]; subscribed: boolean };
    expect(Buffer.from(body.publicKey, 'base64url')).toHaveLength(65);
    expect(body.subscribed).toBe(false);
    expect(JSON.stringify(body)).not.toContain('privateKey');
  });

  it('com HABBLAUD_PUSH=0 nenhuma rota de push existe', async () => {
    const s = await up({ env: { HABBLAUD_PUSH: '0' } });
    for (const path of ['/api/push/status', '/api/push/subscribe', '/api/push/test']) {
      expect((await request(s.base, path, { headers: LOCAL })).status).toBe(404);
    }
  });

  it('com `Host` externo, nenhuma rota de push responde', async () => {
    const s = await up();
    // O guard do upstream apanha o Host desconhecido antes de a rota existir; com um Host permitido mas não
    // loopback, a trava da própria rota responde 403.
    expect((await request(s.base, '/api/push/status', { headers: { Host: 'mau.example' } })).status).toBe(403);
    expect((await request(s.base, '/api/push/status', { headers: { Host: 'habblaud.lan' } })).status).toBe(403);
  });

  it('só GET', async () => {
    const s = await up();
    // Com corpo JSON, porque o guard do upstream recusa um POST sem `Content-Type` com 415 antes da rota.
    const r = await request(s.base, '/api/push/status', { method: 'POST', headers: LOCAL, body: {} });
    expect(r.status).toBe(405);
  });

  it('uma rota desconhecida dentro do prefixo dá 404', async () => {
    const s = await up();
    expect((await request(s.base, '/api/push/inventado', { headers: LOCAL })).status).toBe(404);
  });
});

describe('POST /api/push/subscribe', () => {
  it('inscreve e devolve o estado deste aparelho', async () => {
    const s = await up();
    const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT, keys: KEYS, label: 'iPhone' } });
    expect(r.status).toBe(200);
    expect((r.json as { subscribed: boolean }).subscribed).toBe(true);
  });

  // Era esta entrada que ficava gravada e derrubava o processo a cada aviso, a cada reinício.
  it('um endpoint deformado dá 400 e não fica gravado', async () => {
    const s = await up();
    for (const mau of ['https://[', 'https://', 'https://:80', 'http://web.push.apple.com/x', 'nada']) {
      const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: mau, keys: KEYS } });
      expect(r.status).toBe(400);
    }
    expect((await request(s.base, '/api/push/status', { headers: LOCAL })).json).toMatchObject({ devices: 0 });
  });

  // A inscrição deixa de poder apontar para a rede interna ou para um anfitrião do atacante.
  it('um anfitrião fora da lista de serviços de push dá 400', async () => {
    const s = await up();
    for (const mau of ['https://192.0.2.1/x', 'https://127.0.0.1:4747/api/push/test', 'https://exemplo.pt/push', 'https://web.push.apple.com.mau.pt/x']) {
      const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: mau, keys: KEYS } });
      expect(r.status).toBe(400);
    }
  });

  it('HABBLAUD_PUSH_HOSTS alarga a lista', async () => {
    const s = await up({ env: { HABBLAUD_PUSH_HOSTS: 'push.exemplo.pt' } });
    const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: 'https://push.exemplo.pt/x', keys: KEYS } });
    expect(r.status).toBe(200);
  });

  it('sem chaves dá 400', async () => {
    const s = await up();
    const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } });
    expect(r.status).toBe(400);
  });

  // Teto de quantidade.
  it('acima do teto de aparelhos dá 409', async () => {
    const s = await up();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      // O teto de ritmo é de dez por minuto, o mesmo número: a inscrição faz-se pelo serviço para não o gastar.
      s.push!.subscribe({ endpoint: `https://web.push.apple.com/ap-${i}`, keys: KEYS });
    }
    const r = await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: 'https://web.push.apple.com/ap-extra', keys: KEYS } });
    expect(r.status).toBe(409);
  });

  // Teto de ritmo.
  it('acima de dez escritas por minuto dá 429 com Retry-After', async () => {
    const s = await up();
    let last = { status: 0, headers: {} as Record<string, string> };
    for (let i = 0; i <= WRITES_PER_MIN; i++) {
      const r = await request(s.base, '/api/push/unsubscribe', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } });
      last = { status: r.status, headers: {} };
    }
    expect(last.status).toBe(429);
    const texto = (await request(s.base, '/api/push/unsubscribe', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).json as { error: string };
    expect(texto.error).toMatch(/\d+ s/);
  });

  it('só POST', async () => {
    const s = await up();
    for (const path of ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/prefs', '/api/push/test']) {
      expect((await request(s.base, path, { headers: LOCAL })).status).toBe(405);
    }
    expect((await request(s.base, '/api/push/subscribe', { method: 'PUT', headers: LOCAL, body: {} })).status).toBe(405);
  });
});

describe('POST /api/push/prefs e /unsubscribe', () => {
  it('liga e desliga um tipo neste aparelho', async () => {
    const s = await up();
    s.push!.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    const r = await request(s.base, '/api/push/prefs', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT, types: { 'needs-you': false } } });
    expect(r.status).toBe(200);
    expect((r.json as { types: { id: string; enabled: boolean }[] }).types[0].enabled).toBe(false);
  });

  it('um aparelho que não está inscrito dá 404', async () => {
    const s = await up();
    const r = await request(s.base, '/api/push/prefs', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT, types: { 'needs-you': false } } });
    expect(r.status).toBe(404);
  });

  it('sem tipos dá 400', async () => {
    const s = await up();
    s.push!.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect((await request(s.base, '/api/push/prefs', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).status).toBe(400);
  });
});

describe('POST /api/push/test', () => {
  it('manda ao aparelho do corpo e trava o segundo pedido do mesmo minuto', async () => {
    const s = await up();
    s.push!.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    expect((await request(s.base, '/api/push/test', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).status).toBe(200);
    expect((await request(s.base, '/api/push/test', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).status).toBe(429);
  });

  it('um endpoint recusado nem chega ao teto de ritmo', async () => {
    const s = await up();
    expect((await request(s.base, '/api/push/test', { method: 'POST', headers: LOCAL, body: { endpoint: 'https://192.0.2.1/x' } })).status).toBe(400);
  });
});

describe('POST /api/push/state', () => {
  it('o estado de um tipo desligado sobrevive, e é o que a página lê', async () => {
    const s = await up();
    await request(s.base, '/api/push/subscribe', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT, keys: KEYS } });
    const off = await request(s.base, '/api/push/prefs', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT, types: { 'needs-you': false } } });
    expect((off.json as { types: { enabled: boolean }[] }).types[0].enabled).toBe(false);
    // Era isto que faltava: ler OUTRA VEZ, pelo caminho que a página usa. O `GET /status` continua a dar o padrão.
    const lido = await request(s.base, '/api/push/state', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } });
    expect(lido.status).toBe(200);
    const body = lido.json as { types: { id: string; enabled: boolean }[]; subscribed: boolean };
    expect(body.types[0]).toMatchObject({ id: 'needs-you', enabled: false });
    expect(body.subscribed).toBe(true);
  });

  it('o GET /status leva os valores de omissão, e é por isso que o /state existe', async () => {
    const s = await up();
    s.push!.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    s.push!.setTypes(ENDPOINT, { 'needs-you': false });
    const geral = (await request(s.base, '/api/push/status', { headers: LOCAL })).json as { types: { enabled: boolean }[]; subscribed: boolean };
    expect(geral.types[0].enabled).toBe(true);
    expect(geral.subscribed).toBe(false);
  });

  it('um aparelho que não está inscrito lê os valores de omissão e `subscribed: false`', async () => {
    const s = await up();
    const body = (await request(s.base, '/api/push/state', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).json as { subscribed: boolean };
    expect(body.subscribed).toBe(false);
  });

  it('é leitura: não gasta o teto das escritas de inscrição', async () => {
    const s = await up();
    s.push!.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    for (let i = 0; i < WRITES_PER_MIN + 5; i++) {
      expect((await request(s.base, '/api/push/state', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).status).toBe(200);
    }
  });

  it('recusa um endpoint fora da lista, como as outras', async () => {
    const s = await up();
    expect((await request(s.base, '/api/push/state', { method: 'POST', headers: LOCAL, body: { endpoint: 'https://192.0.2.1/x' } })).status).toBe(400);
  });

  it('só POST, e com HABBLAUD_PUSH=0 não existe', async () => {
    const s = await up();
    expect((await request(s.base, '/api/push/state', { headers: LOCAL })).status).toBe(405);
    const off = await up({ env: { HABBLAUD_PUSH: '0' } });
    expect((await request(off.base, '/api/push/state', { method: 'POST', headers: LOCAL, body: { endpoint: ENDPOINT } })).status).toBe(404);
  });
});
