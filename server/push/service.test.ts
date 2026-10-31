// Freios, chaves e moldes de texto do serviço de push. O que estes testes protegem: o celular não vibrar dez vezes
// por minuto, a chave privada nascer a 600, e nenhum texto de dentro do escritório entrar numa notificação.
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BURST_MAX, BURST_TOTAL_MAX, BURST_WINDOW_MS, createPushService, KEY_FILE, KEY_KEEP_MS, loadVapidKeys, PER_KEY_MS, PushService, safePath, SUMMARY_DELAY_MS, SUMMARY_EVERY_MS, SUMMARY_TOPIC, TEST_MS, TEXT_MAX, WRITE_WINDOW_MS, WRITES_PER_MIN } from './service';
import { MAX_SUBSCRIPTIONS } from './store';
import { generateVapidKeys } from './vapid';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const ENDPOINT = 'https://web.push.apple.com/abc123456789';
const TYPE = { id: 'needs-you', label: 'Alguém precisa de você', enabled: true, ttlS: 600, urgency: 'high' } as const;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'habblaud-push-'));
}

/** Servidor de push de mentira: guarda cada POST e responde 201, como a Apple responde. */
function fakePush(status = 201) {
  const calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as Uint8Array });
    return { status, ok: status < 300, text: async () => '' } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function service(opts: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): PushService {
  const svc = new PushService(generateVapidKeys(), { dataDir: dir(), env: {}, fetch: opts.fetch, now: opts.now });
  svc.registerType({ ...TYPE });
  return svc;
}

describe('loadVapidKeys', () => {
  it('gera o par na primeira vez, a 600', () => {
    const d = dir();
    const keys = loadVapidKeys(d, {});
    expect(statSync(join(d, KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(loadVapidKeys(d, {}).privateKey).toBe(keys.privateKey);
  });

  it('a variável de ambiente ganha do arquivo', () => {
    const d = dir();
    const file = loadVapidKeys(d, {});
    const env = generateVapidKeys();
    const used = loadVapidKeys(d, { HABBLAUD_PUSH_VAPID_PRIVATE: env.privateKey });
    expect(used.privateKey).toBe(env.privateKey);
    expect(used.publicKey).toBe(env.publicKey);
    expect(used.privateKey).not.toBe(file.privateKey);
  });

  it('HABBLAUD_PUSH=0 desliga o serviço inteiro', () => {
    expect(createPushService({ dataDir: dir(), env: { HABBLAUD_PUSH: '0' } })).toBeUndefined();
    expect(createPushService({ dataDir: dir(), env: {} })).toBeTruthy();
  });
});

describe('inscrições', () => {
  it('o status leva a chave pública e os tipos', () => {
    const svc = service();
    const s = svc.status();
    expect(Buffer.from(s.publicKey, 'base64url')).toHaveLength(65);
    expect(s.types).toEqual([{ id: TYPE.id, label: TYPE.label, enabled: true }]);
    expect(s.subscribed).toBe(false);
  });

  it('o status de um endpoint inscrito diz que está inscrito', () => {
    const svc = service();
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS, label: 'iPhone' });
    expect(svc.status(ENDPOINT).subscribed).toBe(true);
    expect(svc.status('https://web.push.apple.com/outro').subscribed).toBe(false);
  });

  it('um tipo desligado neste aparelho não recebe', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    svc.setTypes(ENDPOINT, { 'needs-you': false });
    await svc.notify('needs-you', { title: 'x' });
    expect(api.calls).toHaveLength(0);
  });

  it('404 do servidor de push apaga a inscrição morta', async () => {
    const api = fakePush(404);
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'x' });
    expect(svc.status(ENDPOINT).subscribed).toBe(false);
  });
});

describe('envio', () => {
  it('manda VAPID, aes128gcm, TTL, Urgency e Topic', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'Ana 2 precisa de ti' });
    expect(api.calls).toHaveLength(1);
    const h = api.calls[0].headers;
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('600');
    expect(h.Urgency).toBe('high');
    expect(h.Topic).toBe('needs-you');
  });

  it('o corpo vai cifrado: nem o título aparece nos bytes', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'Ana 2 precisa de ti' });
    expect(Buffer.from(api.calls[0].body).includes('Ana')).toBe(false);
  });

  it('corta o texto e tira as quebras de linha', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: `a\nb${'c'.repeat(TEXT_MAX * 2)}` });
    // O corte acontece antes da cifra; o teste do molde em si é a cifra não deixar nada legível (acima).
    expect(TEXT_MAX).toBeLessThanOrEqual(120);
  });
});

describe('freios', () => {
  it('um push por tipo e origem por minuto', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'x', key: 'agente-a' });
    await svc.notify('needs-you', { title: 'x', key: 'agente-a' });
    expect(api.calls).toHaveLength(1);
    // Outro agente na mesma janela passa: o freio é por tipo e origem, não global.
    await svc.notify('needs-you', { title: 'x', key: 'agente-b' });
    expect(api.calls).toHaveLength(2);
    t += PER_KEY_MS + 1;
    await svc.notify('needs-you', { title: 'x', key: 'agente-a' });
    expect(api.calls).toHaveLength(3);
  });

  it('o teto do processo engole o excesso e conta quantos', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    for (let i = 0; i < BURST_MAX + 5; i++) {
      await svc.notify('needs-you', { title: 'x', key: `agente-${i}` });
      t += 1000;
    }
    expect(api.calls).toHaveLength(BURST_MAX);
    expect(svc.takeSuppressed()).toBe(5);
    expect(svc.takeSuppressed()).toBe(0);
  });

  it('tipo não registrado não manda nada', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('inexistente', { title: 'x' });
    expect(api.calls).toHaveLength(0);
  });

  it('o teste é um por minuto e só para o aparelho que pediu', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    svc.subscribe({ endpoint: 'https://web.push.apple.com/outro-aparelho', keys: KEYS });
    expect((await svc.test(ENDPOINT, { title: 'Habblaud', body: 'Teste' })).sent).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toBe(ENDPOINT);
    expect((await svc.test(ENDPOINT, { title: 'Habblaud', body: 'Teste' })).status).toBe(429);
    t += TEST_MS + 1;
    expect((await svc.test(ENDPOINT, { title: 'Habblaud', body: 'Teste' })).sent).toBe(true);
  });

  it('teste para um aparelho que não está inscrito dá 404', async () => {
    const svc = service({ fetch: fakePush().fetch });
    expect((await svc.test(ENDPOINT, { title: 'Habblaud', body: 'Teste' })).status).toBe(404);
  });
});

describe('safePath', () => {
  it('aceita só caminho da própria origem', () => {
    expect(safePath('/?app=1')).toBe('/?app=1');
    expect(safePath('https://exemplo.pt/x')).toBeUndefined();
    expect(safePath('//exemplo.pt/x')).toBeUndefined();
    expect(safePath('javascript:alert(1)')).toBeUndefined();
    expect(safePath(undefined)).toBeUndefined();
  });
});

describe('resumo da rajada', () => {
  it('10 pushes, depois um resumo só, depois silêncio', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    // 15 avisos em 2 minutos, cada um de um agente diferente (o freio por agente não entra em jogo).
    for (let i = 0; i < 15; i++) {
      await svc.notify('needs-you', { title: 'x', key: `agente-${i}` });
      t += 8_000;
    }
    expect(api.calls).toHaveLength(BURST_MAX);
    // O temporizador do resumo dispararia aqui; o teste chama direto para não esperar os 20 s.
    await svc.flushSummary();
    expect(api.calls).toHaveLength(BURST_MAX + 1);
    expect(api.calls.at(-1)!.headers.Topic).toBe(SUMMARY_TOPIC);
    // Um resumo por rajada: o segundo pedido não manda nada.
    await svc.notify('needs-you', { title: 'x', key: 'agente-99' });
    await svc.flushSummary();
    expect(api.calls).toHaveLength(BURST_MAX + 1);
    svc.stop();
  });

  it('sem nada engolido não há resumo', async () => {
    const api = fakePush();
    const svc = service({ fetch: api.fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'x' });
    await svc.flushSummary();
    expect(api.calls).toHaveLength(1);
  });

  it('a janela nova volta a mandar pushes normais', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    for (let i = 0; i < BURST_MAX + 3; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 1000;
    }
    expect(api.calls).toHaveLength(BURST_MAX);
    t += BURST_WINDOW_MS + 1;
    await svc.notify('needs-you', { title: 'x', key: 'depois' });
    expect(api.calls).toHaveLength(BURST_MAX + 1);
    expect(api.calls.at(-1)!.headers.Topic).toBe('needs-you');
    svc.stop();
  });
});

describe('endpoint deformado e anfitrião fora da lista', () => {
  it('uma linha deformada já no ficheiro não derruba a passagem de um aviso', async () => {
    const d = dir();
    // Linha como a que a validação antiga deixava entrar: passava a expressão regular e estourava no `new URL`.
    writeFileSync(join(d, 'push-subscriptions.json'), JSON.stringify([{ endpoint: 'https://[', keys: KEYS, types: {} }]), { mode: 0o600 });
    const api = fakePush();
    const svc = new PushService(generateVapidKeys(), { dataDir: d, env: {}, fetch: api.fetch });
    svc.registerType({ ...TYPE });
    // Não estoura e não vai à rede: a linha é descartada na leitura do ficheiro.
    await expect(svc.notify('needs-you', { title: 'x' })).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  it('um anfitrião fora da lista, gravado à força, é recusado no envio e a inscrição sai', async () => {
    const d = dir();
    // Forma válida (passa a leitura), anfitrião que não é de serviço de push nenhum: a segunda barreira apanha-o.
    writeFileSync(join(d, 'push-subscriptions.json'), JSON.stringify([{ endpoint: 'https://192.0.2.1/x', keys: KEYS, types: {} }]), { mode: 0o600 });
    const api = fakePush();
    const svc = new PushService(generateVapidKeys(), { dataDir: d, env: {}, fetch: api.fetch });
    svc.registerType({ ...TYPE });
    await svc.notify('needs-you', { title: 'x' });
    expect(api.calls).toHaveLength(0);
    expect(svc.status('https://192.0.2.1/x').subscribed).toBe(false);
  });

  it('`accepts` é o que a rota usa, e recusa o que a lista não tem', () => {
    const svc = service();
    expect(svc.accepts(ENDPOINT)).toBe(true);
    expect(svc.accepts('https://[')).toBe(false);
    expect(svc.accepts('https://192.0.2.1/x')).toBe(false);
    expect(svc.accepts('http://web.push.apple.com/x')).toBe(false);
    expect(svc.accepts(undefined)).toBe(false);
  });

  it('HABBLAUD_PUSH_HOSTS alarga a lista do serviço', () => {
    const svc = new PushService(generateVapidKeys(), { dataDir: dir(), env: { HABBLAUD_PUSH_HOSTS: 'push.exemplo.pt' } });
    expect(svc.accepts('https://push.exemplo.pt/x')).toBe(true);
    expect(svc.pushHosts).toContain('push.exemplo.pt');
  });

  it('um erro do envio não vira promessa rejeitada', async () => {
    const svc = service({
      fetch: (() => {
        throw new Error('rede explodiu de forma inesperada');
      }) as unknown as typeof globalThis.fetch,
    });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await expect(svc.notify('needs-you', { title: 'x' })).resolves.toBeUndefined();
  });

  it('um redirecionamento do servidor de push é falha, e não um salto seguido', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      // O `redirect: 'manual'` tem de chegar ao fetch: é o que impede o Node de seguir o 302 e devolver o corpo
      // do alvo a quem chamou.
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeTruthy();
      return { status: 302, ok: false, text: async () => '' } as Response;
    }) as unknown as typeof globalThis.fetch;
    const svc = service({ fetch });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    const r = await svc.test(ENDPOINT, { title: 'Habblaud', body: 'Teste' });
    expect(r.sent).toBe(false);
    expect(r.status).toBe(302);
    expect(calls).toHaveLength(1);
    // Um 302 não é inscrição morta: não se apaga o aparelho por causa de um servidor de push mal configurado.
    expect(svc.status(ENDPOINT).subscribed).toBe(true);
  });
});

describe('tetos de inscrição', () => {
  const nth = (i: number): string => `https://web.push.apple.com/aparelho-${i}`;

  it('o teto de aparelhos é dez, e o décimo primeiro é recusado', () => {
    const svc = service();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      expect(svc.isFull(nth(i))).toBe(false);
      svc.subscribe({ endpoint: nth(i), keys: KEYS });
    }
    expect(svc.isFull(nth(99))).toBe(true);
    // Um aparelho que já está inscrito volta a passar: reinscrever-se é atualizar, não acrescentar.
    expect(svc.isFull(nth(0))).toBe(false);
  });

  it('dez escritas por minuto, e a seguir diz quantos segundos esperar', () => {
    let t = 1_000_000;
    const svc = service({ now: () => t });
    for (let i = 0; i < WRITES_PER_MIN; i++) expect(svc.takeWrite()).toBe(0);
    const wait = svc.takeWrite();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    t += WRITE_WINDOW_MS + 1;
    expect(svc.takeWrite()).toBe(0);
  });
});

describe('poda e registo', () => {
  it('o freio por tipo e origem não cresce para sempre', async () => {
    let t = 1_000_000;
    const svc = service({ fetch: fakePush().fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    await svc.notify('needs-you', { title: 'x', key: 'antigo' });
    t += KEY_KEEP_MS + 1;
    await svc.notify('needs-you', { title: 'x', key: 'novo' });
    // A entrada velha saiu: o mesmo `key` antigo volta a passar sem esperar.
    await svc.notify('needs-you', { title: 'x', key: 'antigo' });
    expect(svc.keyCount).toBe(2);
  });

  it('cada escrita de inscrição deixa uma linha de log, sem chaves e sem o endpoint inteiro', () => {
    const logs: string[] = [];
    const svc = new PushService(generateVapidKeys(), { dataDir: dir(), env: {}, log: (m) => logs.push(m) });
    svc.registerType({ ...TYPE });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    svc.setTypes(ENDPOINT, { 'needs-you': false });
    svc.unsubscribe(ENDPOINT);
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain('needs-you=desligado');
    for (const line of logs) {
      expect(line).not.toContain(KEYS.p256dh);
      expect(line).not.toContain(KEYS.auth);
      expect(line).not.toContain(ENDPOINT);
      expect(line).toContain('…');
    }
  });
});

describe('tetos por tipo e travão do processo', () => {
  const OUTRO = { id: 'outro-aviso', label: 'Alguém respondeu', enabled: true, ttlS: 600, urgency: 'high' } as const;

  function dois(opts: { fetch?: typeof globalThis.fetch; now?: () => number }): PushService {
    const svc = new PushService(generateVapidKeys(), { dataDir: dir(), env: {}, fetch: opts.fetch, now: opts.now });
    svc.registerType({ ...TYPE });
    svc.registerType({ ...OUTRO });
    return svc;
  }

  it('o teto de um tipo não gasta o do outro', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = dois({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    // Uma manhã de «precisa de você» enche o teto desse tipo.
    for (let i = 0; i < BURST_MAX + 4; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 5_000;
    }
    expect(api.calls.filter((c) => c.headers.Topic === 'needs-you')).toHaveLength(BURST_MAX);
    // A resposta do Ana passa: é o aviso que você está mesmo à espera.
    await svc.notify('outro-aviso', { title: 'Alguém respondeu na sala', key: 'm1' });
    expect(api.calls.filter((c) => c.headers.Topic === 'outro-aviso')).toHaveLength(1);
  });

  it('o travão do processo existe por cima dos tetos por tipo', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = dois({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    for (let i = 0; i < BURST_MAX; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 1_000;
    }
    for (let i = 0; i < BURST_MAX + 5; i++) {
      await svc.notify('outro-aviso', { title: 'y', key: `m-${i}` });
      t += 1_000;
    }
    // Dez de cada um dá vinte, que é o travão: nada passa daí, venha de onde vier.
    expect(api.calls).toHaveLength(BURST_TOTAL_MAX);
    expect(BURST_TOTAL_MAX).toBeGreaterThan(BURST_MAX);
    svc.stop();
  });
});

describe('segunda transbordagem na mesma janela', () => {
  it('a janela que reabre aos poucos volta a dar resumo, e com a contagem certa', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    // Primeira rajada: enche o teto e engole seis.
    for (let i = 0; i < BURST_MAX + 6; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 5_000;
    }
    await svc.flushSummary();
    const primeiro = api.calls.filter((c) => c.headers.Topic === SUMMARY_TOPIC).length;
    expect(primeiro).toBe(1);
    // Agora passa meia janela: a rajada NÃO está vazia (era isso que o booleano antigo exigia), mas o resumo
    // seguinte tem de poder sair.
    t += SUMMARY_EVERY_MS + 1;
    for (let i = 0; i < BURST_MAX + 4; i++) {
      await svc.notify('needs-you', { title: 'x', key: `b-${i}` });
      t += 1_000;
    }
    await svc.flushSummary();
    expect(api.calls.filter((c) => c.headers.Topic === SUMMARY_TOPIC)).toHaveLength(2);
    svc.stop();
  });

  it('um resumo recusado não come o contador', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    for (let i = 0; i < BURST_MAX + 3; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 1_000;
    }
    await svc.flushSummary();
    expect(svc.suppressedCount).toBe(0);
    // Mais avisos engolidos, e um pedido de resumo demasiado cedo: recusado, e o número fica de pé.
    for (let i = 0; i < 3; i++) await svc.notify('needs-you', { title: 'x', key: `c-${i}` });
    const antes = svc.suppressedCount;
    expect(antes).toBe(3);
    await svc.flushSummary();
    expect(svc.suppressedCount).toBe(antes);
    svc.stop();
  });
});

describe('o resumo só vai a quem quer o tipo que transbordou', () => {
  it('um aparelho com o tipo desligado não recebe o resumo dessa rajada', async () => {
    const api = fakePush();
    let t = 1_000_000;
    const B = 'https://web.push.apple.com/aparelho-b';
    const svc = service({ fetch: api.fetch, now: () => t });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    svc.subscribe({ endpoint: B, keys: KEYS });
    svc.setTypes(B, { 'needs-you': false });
    for (let i = 0; i < BURST_MAX + 3; i++) {
      await svc.notify('needs-you', { title: 'x', key: `a-${i}` });
      t += 1_000;
    }
    await svc.flushSummary();
    const resumos = api.calls.filter((c) => c.headers.Topic === SUMMARY_TOPIC);
    expect(resumos).toHaveLength(1);
    expect(resumos[0].url).toBe(ENDPOINT);
    svc.stop();
  });
});

/**
 * Com relógio falso e temporizadores falsos, e **sem chamar `flushSummary()` à mão**: é a única forma de medir que o
 * resumo sai sozinho. O teste anterior chamava o flush, logo passava com o defeito dentro.
 */
describe('o resumo sai sozinho, também no segundo lote', () => {
  afterEach(() => vi.useRealTimers());

  /** Serviço com o relógio do vitest: o `now` por omissão é `Date.now`, que os temporizadores falsos controlam. */
  function comRelogioFalso(): { svc: PushService; calls: ReturnType<typeof fakePush>['calls'] } {
    const api = fakePush();
    const svc = new PushService(generateVapidKeys(), { dataDir: dir(), env: {}, fetch: api.fetch });
    svc.registerType({ ...TYPE });
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS });
    return { svc, calls: api.calls };
  }

  const resumos = (calls: { headers: Record<string, string> }[]): number => calls.filter((c) => c.headers.Topic === SUMMARY_TOPIC).length;

  /** Enche o teto e engola `extra` avisos, cada um de um agente diferente. */
  async function transbordar(svc: PushService, extra: number): Promise<void> {
    for (let i = 0; i < BURST_MAX + extra; i++) {
      await svc.notify('needs-you', { title: 'x', key: `k-${Math.random()}` });
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }

  it('o primeiro resumo sai depois do atraso, sem ninguém o pedir', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { svc, calls } = comRelogioFalso();
    await transbordar(svc, 4);
    expect(resumos(calls)).toBe(0);
    await vi.advanceTimersByTimeAsync(SUMMARY_DELAY_MS + 1_000);
    expect(resumos(calls)).toBe(1);
    svc.stop();
  });

  it('o resumo do segundo lote sai sozinho, dentro da meia janela', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { svc, calls } = comRelogioFalso();
    await transbordar(svc, 4);
    await vi.advanceTimersByTimeAsync(SUMMARY_DELAY_MS + 1_000);
    expect(resumos(calls)).toBe(1);
    // Segundo lote **dentro** da meia janela: é o caso em que o agendamento não acontecia e o aviso ficava retido.
    await svc.notify('needs-you', { title: 'x', key: 'segundo-lote' });
    expect(svc.suppressedCount).toBe(1);
    // Chegada a meia janela, o resumo sai por conta do temporizador. Nada de `flushSummary()` aqui.
    await vi.advanceTimersByTimeAsync(SUMMARY_EVERY_MS + SUMMARY_DELAY_MS);
    expect(resumos(calls)).toBe(2);
    expect(svc.suppressedCount).toBe(0);
    svc.stop();
  });

  it('nada fica retido: um aviso engolido acaba sempre em resumo', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { svc, calls } = comRelogioFalso();
    // Três lotes seguidos, todos dentro da mesma janela de rajada.
    await transbordar(svc, 2);
    await vi.advanceTimersByTimeAsync(SUMMARY_DELAY_MS + 1_000);
    for (const nome of ['lote-2', 'lote-3']) {
      await svc.notify('needs-you', { title: 'x', key: nome });
      await vi.advanceTimersByTimeAsync(SUMMARY_EVERY_MS + SUMMARY_DELAY_MS);
    }
    expect(resumos(calls)).toBe(3);
    expect(svc.suppressedCount).toBe(0);
    svc.stop();
  });

  it('o `stop()` leva o temporizador do resumo consigo', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { svc, calls } = comRelogioFalso();
    await transbordar(svc, 2);
    svc.stop();
    await vi.advanceTimersByTimeAsync(SUMMARY_EVERY_MS * 3);
    expect(resumos(calls)).toBe(0);
  });
});

describe('loadVapidKeys: rasto da identidade gerada', () => {
  it('uma identidade gerada agora deixa uma linha com o caminho, e nunca a chave', () => {
    const d = dir();
    const linhas: string[] = [];
    const keys = loadVapidKeys(d, {}, (m) => linhas.push(m));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain(join(d, KEY_FILE));
    expect(linhas[0]).not.toContain(keys.privateKey);
    expect(linhas[0]).not.toContain(keys.publicKey);
  });

  it('uma identidade que já existe, no ficheiro ou no ambiente, não diz nada', () => {
    const d = dir();
    loadVapidKeys(d, {});
    const linhas: string[] = [];
    loadVapidKeys(d, {}, (m) => linhas.push(m));
    loadVapidKeys(dir(), { HABBLAUD_PUSH_VAPID_PRIVATE: generateVapidKeys().privateKey }, (m) => linhas.push(m));
    expect(linhas).toEqual([]);
  });

  it('o serviço passa o log adiante: o arranque que gera a identidade conta-o', () => {
    const linhas: string[] = [];
    expect(createPushService({ dataDir: dir(), env: {}, log: (m) => linhas.push(m) })).toBeTruthy();
    expect(linhas.filter((l) => l.includes('identidade nova gerada'))).toHaveLength(1);
  });
});
