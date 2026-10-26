// AsideStore: ciclo da pergunta, limites, cancelamento, perda de notícia, gravação em disco, reinício e id hostil.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ASIDE_TOPICS_MAX, ASIDE_TURNS_MAX, type AsideRequest } from '../../shared/asides';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { InvalidRequest, type SendResult } from '../messages/registry';
import { tempDir } from '../test/fixtures';
import { AsideStore } from './store';

setQuiet(true);

const SID = '0199b0c0-1234-7abc-8def-0123456789ab';
const AGENT = `acc:${SID}`;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(opts: { dir?: string | null; sessionId?: string; queueResult?: (n: number) => SendResult } = {}) {
  let now = 1_000_000;
  let n = 0;
  let dir = opts.dir;
  if (dir === undefined) {
    const t = tempDir();
    cleanups.push(t.cleanup);
    dir = join(t.dir, 'asides');
  }
  const agents = new Map<string, AgentInfo>();
  agents.set(AGENT, { id: AGENT, kind: 'main', sessionId: opts.sessionId ?? SID } as AgentInfo);
  agents.set('claude:1', { id: 'claude:1', kind: 'main', sessionId: 's' } as AgentInfo);
  agents.set('sub:1', { id: 'sub:1', kind: 'sub', sessionId: SID } as AgentInfo);
  const calls: Array<{ agentId: string; req: AsideRequest }> = [];
  const discarded: string[] = [];
  const make = () =>
    new AsideStore({
      dir,
      office: { get: (id) => agents.get(id) },
      queue: (agentId, req) => {
        calls.push({ agentId, req });
        return opts.queueResult?.(calls.length) ?? { message: { id: `m-${++n}`, agentId, status: 'queued', createdAt: now, updatedAt: now } };
      },
      discard: (id) => (discarded.push(id), true),
      now: () => now,
      lostMs: 30_000,
    });
  const store = make();
  const file = join(dir ?? '', `${SID}.json`);
  return { store, make, calls, discarded, dir, file, agents, advance: (ms: number) => (now += ms) };
}

function topicOf(r: ReturnType<AsideStore['ask']>) {
  if (!('topic' in r)) throw new Error(`recusada: ${JSON.stringify(r)}`);
  return r.topic;
}

/** Entrega e responde por completo a última pergunta. */
function answer(s: ReturnType<typeof setup>, text: string, msg = `m-${s.calls.length}`) {
  const req = s.calls[s.calls.length - 1]!.req;
  s.store.settled(msg, 'delivered');
  s.store.progress({ sessionId: SID, turnId: req.turnId, text, state: 'complete' });
}

describe('AsideStore: perguntar', () => {
  it('sem topicId cria a conversa, chama queue com index 0 e history vazio e grava o arquivo 0600', () => {
    const s = setup();
    const topic = topicOf(s.store.ask({ agentId: AGENT, question: '  o que faz?  ' }));
    expect(topic.turns).toHaveLength(1);
    expect(topic.turns[0]).toMatchObject({ question: 'o que faz?', answer: '', status: 'queued' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.req).toMatchObject({ topicId: topic.id, turnId: topic.turns[0]!.id, index: 0, question: 'o que faz?', history: [] });
    const saved = JSON.parse(readFileSync(s.file, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.topics[0].id).toBe(topic.id);
    if (process.platform !== 'win32') {
      expect(statSync(s.file).mode & 0o777).toBe(0o600);
      expect(statSync(s.dir!).mode & 0o777).toBe(0o700);
    }
  });

  it('a segunda pergunta no mesmo tópico leva index 1 e history com a primeira, inclusive a resposta', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'um' }));
    answer(s, 'resposta um');
    topicOf(s.store.ask({ agentId: AGENT, question: 'dois', topicId: t.id }));
    const req = s.calls[1]!.req;
    expect(req.index).toBe(1);
    expect(req.history).toEqual([{ question: 'um', answer: 'resposta um', createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
    expect(s.store.list(AGENT)?.topics).toHaveLength(1);
  });

  it('busy com pergunta em andamento; full na 51ª; o 21º tópico tira o mais antigo', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    expect(s.store.ask({ agentId: AGENT, question: 'b', topicId: t.id })).toMatchObject({ error: 'busy', reason: expect.stringMatching(/respondendo/) });
    answer(s, 'ok');
    for (let i = 1; i < ASIDE_TURNS_MAX; i++) {
      topicOf(s.store.ask({ agentId: AGENT, question: `q${i}`, topicId: t.id }));
      answer(s, 'ok');
    }
    expect(s.store.ask({ agentId: AGENT, question: 'x', topicId: t.id })).toMatchObject({ error: 'full' });

    const s2 = setup();
    const first = topicOf(s2.store.ask({ agentId: AGENT, question: 'primeira' }));
    answer(s2, 'ok');
    for (let i = 1; i <= ASIDE_TOPICS_MAX; i++) {
      topicOf(s2.store.ask({ agentId: AGENT, question: `t${i}` }));
      answer(s2, 'ok');
    }
    const topics = s2.store.list(AGENT)!.topics;
    expect(topics).toHaveLength(ASIDE_TOPICS_MAX);
    expect(topics.some((x) => x.id === first.id)).toBe(false);
    expect(topics[0]!.turns[0]!.question).toBe(`t${ASIDE_TOPICS_MAX}`);
  });

  it('queue que recusa devolve o erro e não deixa tópico nem arquivo', () => {
    const s = setup({ queueResult: () => ({ error: 'unavailable', reason: 'sem plugin' }) });
    expect(s.store.ask({ agentId: AGENT, question: 'a' })).toEqual({ error: 'unavailable', reason: 'sem plugin' });
    expect(s.store.list(AGENT)?.topics).toEqual([]);
    expect(existsSync(s.file)).toBe(false);
  });

  it('valida o corpo e o agente', () => {
    const s = setup();
    for (const body of [{}, { agentId: AGENT }, { agentId: AGENT, question: '  ' }, { agentId: AGENT, question: 'x'.repeat(20_001) }, { agentId: AGENT, question: 'a', topicId: 't-nao' }, { agentId: AGENT, question: 'a', topicId: 5 }]) {
      expect(() => s.store.ask(body), JSON.stringify(body).slice(0, 60)).toThrow(InvalidRequest);
    }
    expect(s.store.ask({ agentId: 'nao-existe', question: 'a' })).toEqual({ error: 'not-found' });
    expect(s.store.ask({ agentId: 'claude:1', question: 'a' })).toMatchObject({ error: 'unavailable' });
    expect(s.store.ask({ agentId: 'sub:1', question: 'a' })).toMatchObject({ error: 'unavailable' });
    expect(s.store.list('claude:1')).toBeUndefined();
    expect(s.store.list('nao-existe')).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });

  it('sessionId que não casa com SESSION_ID: unavailable e nenhum arquivo fora da pasta', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const dir = join(t.dir, 'asides');
    const s = setup({ dir, sessionId: '../../etc' });
    expect(s.store.ask({ agentId: AGENT, question: 'a' })).toMatchObject({ error: 'unavailable' });
    expect(s.calls).toHaveLength(0);
    expect(readdirSync(t.dir)).toEqual([]);
  });
});

describe('AsideStore: ciclo da resposta', () => {
  it('settled: failed com a pergunta queued a deixa failed; delivered a põe em running', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    s.store.settled('m-1', 'failed', 'x');
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]).toMatchObject({ status: 'failed', error: 'x' });
    // pergunta já final: ignora a confirmação atrasada
    s.store.settled('m-1', 'delivered');
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.status).toBe('failed');
    const t2 = topicOf(s.store.ask({ agentId: AGENT, question: 'b', topicId: t.id }));
    s.store.settled('m-2', 'delivered');
    expect(s.store.list(AGENT)!.topics[0]!.turns[1]).toMatchObject({ id: t2.turns[1]!.id, status: 'running' });
  });

  it('progress: texto crescendo, o menor que chega depois é ignorado, complete grava em disco, running não', () => {
    const s = setup();
    topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    const turnId = s.calls[0]!.req.turnId;
    const post = (text: string, state: 'running' | 'complete' = 'running') => s.store.progress({ sessionId: SID, turnId, text, state });
    const turn = () => s.store.list(AGENT)!.topics[0]!.turns[0]!;
    const onDisk = () => JSON.parse(readFileSync(s.file, 'utf8')).topics[0].turns[0];

    expect(post('ol')).toEqual({ cancel: false });
    expect(turn()).toMatchObject({ status: 'running', answer: 'ol' }); // chegou antes do ack: queued vira running
    post('olá mundo');
    post('olá');
    expect(turn().answer).toBe('olá mundo');
    expect(onDisk()).toMatchObject({ status: 'queued', answer: '' }); // o parcial não vai ao disco
    expect(post('olá mundo!', 'complete')).toEqual({ cancel: false });
    expect(turn()).toMatchObject({ status: 'complete', answer: 'olá mundo!' });
    expect(onDisk()).toMatchObject({ status: 'complete', answer: 'olá mundo!' });
    // já final: a notícia seguinte manda abortar e não muda nada
    expect(post('outra coisa')).toEqual({ cancel: true });
    expect(turn().answer).toBe('olá mundo!');
  });

  it('pergunta desconhecida ou de outra sessão dá cancel: true; corpo inválido lança', () => {
    const s = setup();
    topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    const turnId = s.calls[0]!.req.turnId;
    expect(s.store.progress({ sessionId: SID, turnId: 'q-nao', text: '', state: 'running' })).toEqual({ cancel: true });
    expect(s.store.progress({ sessionId: '0199b0c0-5678-7abc-8def-0123456789ab', turnId, text: 'x', state: 'running' })).toEqual({ cancel: true });
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.answer).toBe('');
    expect(() => s.store.progress({ sessionId: '../x', turnId, text: '', state: 'running' })).toThrow(InvalidRequest);
  });

  it('cancel: queued vira cancelled na hora; running recebe cancel na próxima notícia e fecha como cancelled', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    expect(s.store.cancel(t.id, { agentId: AGENT })).toEqual({ ok: true });
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.status).toBe('cancelled');
    expect(s.store.cancel(t.id, { agentId: AGENT })).toEqual({ error: 'idle' });
    expect(s.store.cancel('t-nao', { agentId: AGENT })).toEqual({ error: 'not-found' });
    expect(() => s.store.cancel(t.id, {})).toThrow(InvalidRequest);

    topicOf(s.store.ask({ agentId: AGENT, question: 'b', topicId: t.id }));
    const turnId = s.calls[1]!.req.turnId;
    s.store.settled('m-2', 'delivered');
    s.store.progress({ sessionId: SID, turnId, text: 'par', state: 'running' });
    expect(s.store.cancel(t.id, { agentId: AGENT })).toEqual({ ok: true });
    expect(s.store.list(AGENT)!.topics[0]!.turns[1]!.status).toBe('running');
    expect(s.store.progress({ sessionId: SID, turnId, text: 'parcial', state: 'running' })).toEqual({ cancel: true });
    expect(s.store.list(AGENT)!.topics[0]!.turns[1]).toMatchObject({ status: 'running', answer: 'par' });
    expect(s.store.progress({ sessionId: SID, turnId, text: 'parcial', state: 'cancelled' })).toEqual({ cancel: true });
    expect(s.store.list(AGENT)!.topics[0]!.turns[1]).toMatchObject({ status: 'cancelled', answer: 'parcial' });
    // livre de novo para perguntar
    topicOf(s.store.ask({ agentId: AGENT, question: 'c', topicId: t.id }));
  });

  it('cancel de pergunta queued retira a mensagem da fila, uma vez, e não deixa settled mexer no turno', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    s.store.cancel(t.id, { agentId: AGENT });
    expect(s.discarded).toEqual(['m-1']);
    s.store.settled('m-1', 'delivered');
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.status).toBe('cancelled');
    expect(s.store.cancel(t.id, { agentId: AGENT })).toEqual({ error: 'idle' });
    expect(s.discarded).toEqual(['m-1']);
  });

  it('cancel de pergunta já entregue (running) não chama discard; o cancelamento sai pelo progress', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    const turnId = s.calls[0]!.req.turnId;
    s.store.settled('m-1', 'delivered');
    expect(s.store.cancel(t.id, { agentId: AGENT })).toEqual({ ok: true });
    expect(s.discarded).toEqual([]);
    expect(s.store.progress({ sessionId: SID, turnId, text: '', state: 'running' })).toEqual({ cancel: true });
  });

  it('remove: apaga a conversa; com pergunta em andamento dá busy', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    expect(s.store.remove(t.id, AGENT)).toEqual({ error: 'busy' });
    answer(s, 'ok');
    expect(s.store.remove(t.id, AGENT)).toEqual({ ok: true });
    expect(s.store.list(AGENT)!.topics).toEqual([]);
    expect(s.store.remove(t.id, AGENT)).toEqual({ error: 'not-found' });
    expect(JSON.parse(readFileSync(s.file, 'utf8')).topics).toEqual([]);
  });

  it('tick: em andamento sem notícia por lostMs vira failed', () => {
    const s = setup();
    topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    const turnId = s.calls[0]!.req.turnId;
    s.store.settled('m-1', 'delivered');
    s.advance(29_999);
    s.store.tick();
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.status).toBe('running');
    s.store.progress({ sessionId: SID, turnId, text: 'x', state: 'running' });
    s.advance(29_999);
    s.store.tick();
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]!.status).toBe('running');
    s.advance(1);
    s.store.tick();
    expect(s.store.list(AGENT)!.topics[0]!.turns[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/parou de mandar/) });
    expect(JSON.parse(readFileSync(s.file, 'utf8')).topics[0].turns[0].status).toBe('failed');
  });
});

describe('AsideStore: disco', () => {
  it('reinício: um store novo na mesma pasta lê as conversas e o que estava running vira failed (interrompida)', () => {
    const s = setup();
    const t = topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    answer(s, 'resposta');
    topicOf(s.store.ask({ agentId: AGENT, question: 'b', topicId: t.id }));
    s.store.settled('m-2', 'delivered');
    const again = s.make();
    const topics = again.list(AGENT)!.topics;
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turns[0]).toMatchObject({ status: 'complete', answer: 'resposta' });
    expect(topics[0]!.turns[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/reiniciou/) });
    // a correção também foi para o disco
    expect(JSON.parse(readFileSync(s.file, 'utf8')).topics[0].turns[1].status).toBe('failed');
    // a conversa continua: nova pergunta já passa
    expect(() => topicOf(again.ask({ agentId: AGENT, question: 'c', topicId: t.id }))).not.toThrow();
  });

  it('arquivo com JSON quebrado vira .corrupt e a sessão começa vazia', () => {
    const s = setup();
    mkdirSync(s.dir!, { recursive: true });
    writeFileSync(s.file, '{quebrado');
    expect(s.store.list(AGENT)).toEqual({ topics: [] });
    expect(existsSync(`${s.file}.corrupt`)).toBe(true);
    expect(existsSync(s.file)).toBe(false);
  });

  it('descarta itens fora do formato um por um e corta os campos nos limites', () => {
    const s = setup();
    mkdirSync(s.dir!, { recursive: true });
    const good = { id: 't-1', createdAt: 1, updatedAt: 2, turns: [{ id: 'q-1', question: 'a', answer: 'x'.repeat(70_000), status: 'complete', createdAt: 1, updatedAt: 2 }, { id: 'q-2', question: '', answer: '', status: 'complete', createdAt: 1, updatedAt: 1 }, { id: 'q-3', question: 'q', answer: '', status: 'estranho', createdAt: 1, updatedAt: 1 }] };
    writeFileSync(s.file, JSON.stringify({ version: 1, topics: [good, { id: 5 }, null, { id: 't-2', createdAt: 1, updatedAt: 1, turns: 'x' }] }));
    const topics = s.store.list(AGENT)!.topics;
    expect(topics.map((x) => x.id)).toEqual(['t-1']);
    expect(topics[0]!.turns).toHaveLength(1);
    expect(topics[0]!.turns[0]!.answer.length).toBe(64 * 1024);
  });

  it('dir null: só memória', () => {
    const s = setup({ dir: null });
    topicOf(s.store.ask({ agentId: AGENT, question: 'a' }));
    expect(s.store.list(AGENT)!.topics).toHaveLength(1);
  });
});
