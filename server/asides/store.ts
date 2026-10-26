// Bate-papo paralelo: as conversas (tópicos) e perguntas de cada sessão, em memória e em disco.
// A pergunta entra na fila das mensagens (MessageRegistry.aside); o plugin da sessão a inicia e manda a
// resposta por POST /api/mod/aside (progress). Um arquivo por sessão: <dir>/<sessionId>.json (0600, pasta 0700).
// O sessionId só vira nome de arquivo depois de passar por SESSION_ID (uuid): nunca monte o caminho sem isso.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASIDE_ANSWER_MAX,
  ASIDE_LOST_MS,
  ASIDE_QUESTION_MAX,
  ASIDE_TOPICS_MAX,
  ASIDE_TURNS_MAX,
  clipAnswer,
  isFinalAside,
  parseAsideProgress,
  SESSION_ID,
  type AsideRequest,
  type AsideStatus,
  type AsideTopic,
  type AsideTurn,
} from '../../shared/asides';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { InvalidRequest, type OfficeLike, type SendResult } from '../messages/registry';

const ID_MAX = 300;
const ERROR_MAX = 500;
const STATUSES: readonly AsideStatus[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];

export interface AsideStoreOptions {
  /** Pasta dos arquivos (<dataDir>/asides); null = só memória (testes). */
  dir: string | null;
  office: Pick<OfficeLike, 'get'>;
  /** = MessageRegistry.aside */
  queue: (agentId: string, req: AsideRequest) => SendResult;
  /** = MessageRegistry.discard: tira da fila a mensagem de uma pergunta cancelada antes de o plugin buscá-la. */
  discard: (messageId: string) => boolean;
  now?: () => number;
  /** Em andamento sem notícia do plugin por este tempo: falha. Padrão ASIDE_LOST_MS. */
  lostMs?: number;
  tickMs?: number;
}

export type AskResult =
  | { topic: AsideTopic }
  | { error: 'not-found' | 'too-many' }
  | { error: 'unavailable' | 'busy' | 'full'; reason: string };

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function idStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX ? v : undefined;
}

function time(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export class AsideStore {
  /** sessionId → conversas, da mais antiga para a mais nova. */
  private readonly sessions = new Map<string, AsideTopic[]>();
  private readonly turns = new Map<string, { sessionId: string; topicId: string }>();
  private readonly byMessage = new Map<string, string>();
  private readonly lastProgress = new Map<string, number>();
  private readonly cancels = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly lostMs: number;

  constructor(private readonly opts: AsideStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.lostMs = opts.lostMs ?? ASIDE_LOST_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`asides-tick:${errMsg(err)}`, tr('Bate-papo paralelo: falha no relógio ({0}).', [errMsg(err)]));
      }
    }, this.opts.tickMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Conversas da sessão atual do agente, da mais nova para a mais velha; undefined = agente desconhecido, subagente ou sem id de sessão válido. */
  list(agentId: string): { topics: AsideTopic[] } | undefined {
    const sessionId = this.asideSession(agentId);
    if (!sessionId) return undefined;
    return { topics: structuredClone([...this.topics(sessionId)].reverse()) };
  }

  ask(raw: unknown): AskResult {
    const r = rec(raw);
    const agentId = idStr(r?.agentId);
    if (!r || !agentId) throw new InvalidRequest('esperado {agentId, question, topicId?}');
    const question = typeof r.question === 'string' ? r.question.trim() : '';
    if (!question || question.length > ASIDE_QUESTION_MAX) throw new InvalidRequest(`question: de 1 a ${ASIDE_QUESTION_MAX} caracteres`);
    if (r.topicId !== undefined && !idStr(r.topicId)) throw new InvalidRequest('topicId inválido');

    const agent = this.opts.office.get(agentId);
    if (!agent) return { error: 'not-found' };
    const sessionId = this.asideSession(agentId);
    if (!sessionId) return { error: 'unavailable', reason: tr('este agente não responde perguntas paralelas') };

    const topics = this.topics(sessionId);
    const existing = r.topicId === undefined ? undefined : topics.find((t) => t.id === r.topicId);
    if (r.topicId !== undefined && !existing) throw new InvalidRequest('topicId desconhecido');
    if (topics.some((t) => t.turns.some((q) => !isFinalAside(q.status)))) {
      return { error: 'busy', reason: tr('o bate-papo paralelo ainda está respondendo: espere ou pare') };
    }
    if (existing && existing.turns.length >= ASIDE_TURNS_MAX) {
      return { error: 'full', reason: tr('esta conversa chegou a {0} perguntas: comece uma nova', [ASIDE_TURNS_MAX]) };
    }

    const now = this.now();
    const turn: AsideTurn = { id: this.newId('q', now), question, answer: '', status: 'queued', createdAt: now, updatedAt: now };
    const topic: AsideTopic = existing ?? { id: this.newId('t', now), createdAt: now, updatedAt: now, turns: [] };
    const req: AsideRequest = {
      topicId: topic.id,
      turnId: turn.id,
      index: topic.turns.length,
      question,
      history: topic.turns.map((q) => ({ question: q.question, answer: q.answer, createdAt: q.createdAt, updatedAt: q.updatedAt })),
    };
    // A fila é consultada antes de mexer no estado: recusada, nada precisa ser desfeito.
    const sent = this.opts.queue(agentId, req);
    if (!('message' in sent)) return sent;

    if (!existing) {
      topics.push(topic);
      while (topics.length > ASIDE_TOPICS_MAX) this.dropTopic(topics, 0);
    }
    topic.turns.push(turn);
    topic.updatedAt = now;
    this.turns.set(turn.id, { sessionId, topicId: topic.id });
    this.byMessage.set(sent.message.id, turn.id);
    this.save(sessionId);
    return { topic: structuredClone(topic) };
  }

  /** Gancho do registro: a mensagem da pergunta foi entregue (vira running) ou falhou (vira failed, se ainda esperava). */
  settled(messageId: string, status: 'delivered' | 'failed', error?: string): void {
    const turnId = this.byMessage.get(messageId);
    const found = turnId ? this.find(turnId) : undefined;
    if (!turnId || !found) return;
    this.byMessage.delete(messageId);
    const { sessionId, turn } = found;
    if (turn.status !== 'queued') return;
    const now = this.now();
    if (status === 'failed') {
      this.finishTurn(found, 'failed', error?.trim() ? error.slice(0, ERROR_MAX) : tr('a pergunta não chegou à sessão'), now);
    } else {
      turn.status = 'running';
      turn.updatedAt = now;
      this.lastProgress.set(turnId, now);
    }
    this.save(sessionId);
  }

  /** Notícia do plugin (POST /api/mod/aside). `cancel: true` manda o plugin abortar a pergunta. */
  progress(raw: unknown): { cancel: boolean } {
    const p = parseAsideProgress(raw);
    if (!p) throw new InvalidRequest('esperado {sessionId, turnId, text, state, error?}');
    const found = this.find(p.turnId);
    if (!found || found.sessionId !== p.sessionId || isFinalAside(found.turn.status)) return { cancel: true };
    const { turn } = found;
    const now = this.now();

    if (this.cancels.has(turn.id)) {
      // Só o fim da pergunta muda algo: o plugin confirma o cancelamento (ou terminou antes de recebê-lo).
      if (p.state !== 'running') {
        if (p.text && p.text.length >= turn.answer.length) turn.answer = p.text;
        this.finishTurn(found, p.state, p.error, now);
        this.save(found.sessionId);
      }
      return { cancel: true };
    }

    if (p.state === 'running') {
      if (p.text.length >= turn.answer.length) turn.answer = p.text;
      if (turn.status === 'queued') turn.status = 'running';
      turn.updatedAt = now;
      this.lastProgress.set(turn.id, now);
      return { cancel: false };
    }
    // O fim é a palavra final do plugin: o texto dele vale mesmo que seja menor que o último parcial.
    if (p.text) turn.answer = p.text;
    this.finishTurn(found, p.state, p.error, now);
    this.save(found.sessionId);
    return { cancel: false };
  }

  /** Para a pergunta em andamento da conversa. `idle` = nada a parar. */
  cancel(topicId: string, raw: unknown): { ok: true } | { error: 'not-found' | 'idle' } {
    const found = this.findTopic(topicId, raw);
    if (!found) return { error: 'not-found' };
    const turn = found.topic.turns.find((q) => !isFinalAside(q.status));
    if (!turn) return { error: 'idle' };
    if (turn.status === 'queued') {
      // Sem isto a mensagem ficaria na fila e o plugin responderia (com tokens) a uma pergunta cancelada.
      for (const [messageId, turnId] of this.byMessage) {
        if (turnId !== turn.id) continue;
        this.byMessage.delete(messageId);
        this.opts.discard(messageId);
        break;
      }
      this.finishTurn({ sessionId: found.sessionId, topic: found.topic, turn }, 'cancelled', undefined, this.now());
      this.save(found.sessionId);
    } else {
      this.cancels.add(turn.id);
    }
    return { ok: true };
  }

  /** Apaga a conversa (não com pergunta em andamento). */
  remove(topicId: string, agentId: string): { ok: true } | { error: 'not-found' | 'busy' } {
    const found = this.findTopic(topicId, { agentId });
    if (!found) return { error: 'not-found' };
    if (found.topic.turns.some((q) => !isFinalAside(q.status))) return { error: 'busy' };
    const topics = this.topics(found.sessionId);
    this.dropTopic(topics, topics.indexOf(found.topic));
    this.save(found.sessionId);
    return { ok: true };
  }

  /** Pergunta em andamento sem notícia do plugin há `lostMs`: falha. */
  tick(): void {
    const now = this.now();
    const changed = new Set<string>();
    for (const [turnId, at] of [...this.lastProgress]) {
      if (now - at < this.lostMs) continue;
      const found = this.find(turnId);
      if (found && !isFinalAside(found.turn.status)) {
        this.finishTurn(found, 'failed', tr('o plugin da sessão parou de mandar notícias da resposta'), now);
        changed.add(found.sessionId);
      } else this.lastProgress.delete(turnId);
    }
    for (const sessionId of changed) this.save(sessionId);
  }

  // ---- internos ----

  /** Sessão de um agente principal ao vivo, só se o id servir de nome de arquivo. */
  private asideSession(agentId: string): string | undefined {
    const a = this.opts.office.get(agentId);
    return a && a.kind === 'main' && SESSION_ID.test(a.sessionId) ? a.sessionId : undefined;
  }

  private newId(prefix: 't' | 'q', now: number): string {
    return `${prefix}-${now.toString(36)}-${randomBytes(6).toString('base64url')}`;
  }

  private find(turnId: string): { sessionId: string; topic: AsideTopic; turn: AsideTurn } | undefined {
    const at = this.turns.get(turnId);
    const topic = at ? this.sessions.get(at.sessionId)?.find((t) => t.id === at.topicId) : undefined;
    const turn = topic?.turns.find((q) => q.id === turnId);
    return at && topic && turn ? { sessionId: at.sessionId, topic, turn } : undefined;
  }

  private findTopic(topicId: string, raw: unknown): { sessionId: string; topic: AsideTopic } | undefined {
    const agentId = idStr(rec(raw)?.agentId);
    if (!agentId) throw new InvalidRequest('esperado {agentId}');
    const sessionId = this.asideSession(agentId);
    const topic = sessionId ? this.topics(sessionId).find((t) => t.id === topicId) : undefined;
    return sessionId && topic ? { sessionId, topic } : undefined;
  }

  private finishTurn(f: { sessionId: string; topic: AsideTopic; turn: AsideTurn }, status: AsideStatus, error: string | undefined, now: number): void {
    f.turn.status = status;
    f.turn.updatedAt = now;
    f.topic.updatedAt = now;
    if (status === 'failed') f.turn.error = (error?.trim() ? error : tr('falha na pergunta paralela')).slice(0, ERROR_MAX);
    this.lastProgress.delete(f.turn.id);
    this.cancels.delete(f.turn.id);
  }

  private dropTopic(topics: AsideTopic[], at: number): void {
    const [gone] = topics.splice(at, 1);
    for (const q of gone?.turns ?? []) {
      this.turns.delete(q.id);
      this.lastProgress.delete(q.id);
      this.cancels.delete(q.id);
    }
  }

  private topics(sessionId: string): AsideTopic[] {
    let t = this.sessions.get(sessionId);
    if (!t) {
      const loaded = this.load(sessionId);
      t = loaded.topics;
      this.sessions.set(sessionId, t);
      for (const topic of t) for (const q of topic.turns) this.turns.set(q.id, { sessionId, topicId: topic.id });
      if (loaded.interrupted) this.save(sessionId);
    }
    return t;
  }

  private file(sessionId: string): string | undefined {
    return this.opts.dir && SESSION_ID.test(sessionId) ? join(this.opts.dir, `${sessionId}.json`) : undefined;
  }

  private load(sessionId: string): { topics: AsideTopic[]; interrupted: boolean } {
    const file = this.file(sessionId);
    const none = { topics: [], interrupted: false };
    if (!file) return none;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warnOnce(`asides-read:${file}`, tr('Não consegui ler {0}: {1}', [file, errMsg(err)]));
      return none;
    }
    let topics: AsideTopic[] | undefined;
    try {
      const raw = rec(JSON.parse(text));
      if (raw && Array.isArray(raw.topics)) topics = raw.topics.flatMap((t) => parseTopic(t) ?? []);
    } catch {
      topics = undefined;
    }
    if (!topics) {
      log.warnOnce(`asides-corrupt:${file}`, tr('{0} está ilegível; guardado como .corrupt e as conversas recomeçam do zero.', [file]));
      try {
        renameSync(file, `${file}.corrupt`);
      } catch {
        // sem permissão: será sobrescrito na próxima gravação
      }
      return none;
    }
    topics = topics.slice(-ASIDE_TOPICS_MAX);
    // Uma pergunta que estava em andamento perdeu o plugin que a respondia: o servidor reiniciou.
    let interrupted = false;
    for (const t of topics) {
      for (const q of t.turns) {
        if (isFinalAside(q.status)) continue;
        q.status = 'failed';
        q.error = tr('interrompida: o Habblaud reiniciou');
        interrupted = true;
      }
    }
    return { topics, interrupted };
  }

  /** Grava a sessão: .tmp + rename. Falha só vira aviso: o estado em memória continua valendo. */
  private save(sessionId: string): void {
    const file = this.file(sessionId);
    const topics = this.sessions.get(sessionId);
    if (!file || !topics || !this.opts.dir) return;
    try {
      mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, topics }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      log.warnOnce(`asides-write:${file}`, tr('Não consegui gravar {0}: {1}', [file, errMsg(err)]));
    }
  }
}

function parseTurn(raw: unknown): AsideTurn | undefined {
  const r = rec(raw);
  const id = idStr(r?.id);
  const createdAt = time(r?.createdAt);
  const updatedAt = time(r?.updatedAt);
  if (!r || !id || createdAt === undefined || updatedAt === undefined) return undefined;
  if (typeof r.question !== 'string' || !r.question.trim() || typeof r.answer !== 'string') return undefined;
  if (typeof r.status !== 'string' || !(STATUSES as readonly string[]).includes(r.status)) return undefined;
  const turn: AsideTurn = {
    id,
    question: r.question.slice(0, ASIDE_QUESTION_MAX),
    answer: clipAnswer(r.answer, ASIDE_ANSWER_MAX),
    status: r.status as AsideStatus,
    createdAt,
    updatedAt,
  };
  if (typeof r.error === 'string' && r.error) turn.error = r.error.slice(0, ERROR_MAX);
  return turn;
}

function parseTopic(raw: unknown): AsideTopic | undefined {
  const r = rec(raw);
  const id = idStr(r?.id);
  const createdAt = time(r?.createdAt);
  const updatedAt = time(r?.updatedAt);
  if (!r || !id || createdAt === undefined || updatedAt === undefined || !Array.isArray(r.turns)) return undefined;
  const turns = r.turns.flatMap((t) => parseTurn(t) ?? []).slice(0, ASIDE_TURNS_MAX);
  return turns.length ? { id, createdAt, updatedAt, turns } : undefined;
}
