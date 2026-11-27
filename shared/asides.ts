// Bate-papo paralelo: perguntas laterais a um agente do omp, sem entrar na conversa dele (mesma maquinaria do /btw).
// Código puro: sem APIs de Node nem de DOM. O servidor, a página e a extensão do omp importam daqui.

import { OMP_SESSION_ID } from './omp-events';

export const ASIDE_QUESTION_MAX = 20_000; // igual a MESSAGE_MAX
export const ASIDE_ANSWER_MAX = 64 * 1024; // caracteres; o que passar é cortado com '\n…'
export const ASIDE_TOPICS_MAX = 20; // conversas por sessão; a mais antiga sai ao criar a 21ª
export const ASIDE_TURNS_MAX = 50; // perguntas por conversa; a 51ª dá 409
export const ASIDE_PROGRESS_MS = 500; // a extensão manda o texto acumulado no máximo a cada 0,5 s...
export const ASIDE_HEARTBEAT_MS = 1_000; // ...e ao menos a cada 1 s (mesmo sem texto novo)
export const ASIDE_LOST_MS = 30_000; // em andamento sem notícia da extensão por 30 s: falha

const TURN_ID_MAX = 200;
const ERROR_MAX = 500;

export type AsideStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface AsideTurn {
  id: string;
  question: string;
  answer: string;
  status: AsideStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AsideTopic {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: AsideTurn[];
}

/** Item da caixa de entrada (InboxMessage.aside): o que a extensão precisa para rodar a pergunta. */
export interface AsideRequest {
  topicId: string;
  turnId: string;
  /** Posição da pergunta no tópico (0 = primeira): entra na conversationKey. */
  index: number;
  question: string;
  /** Perguntas anteriores do tópico, na ordem (answer vazio = sem resposta). */
  history: Array<{ question: string; answer: string; createdAt: number; updatedAt: number }>;
}

/** Corpo de POST /api/omp/aside (extensão → servidor). `text` = a resposta acumulada até agora (não um delta). */
export interface AsideProgress {
  sessionId: string;
  turnId: string;
  text: string;
  state: 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string;
}

const STATES: readonly AsideProgress['state'][] = ['running', 'complete', 'failed', 'cancelled'];

/** Corta `text` em `max` caracteres, marcando o corte com '\n…'. */
export function clipAnswer(text: string, max = ASIDE_ANSWER_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 2)}\n…`;
}

/** Valida o corpo de POST /api/omp/aside; fora do formato = undefined. */
export function parseAsideProgress(raw: unknown): AsideProgress | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const { sessionId, turnId, text, state, error } = r;
  if (typeof sessionId !== 'string' || !OMP_SESSION_ID.test(sessionId)) return undefined;
  if (typeof turnId !== 'string' || turnId.length < 1 || turnId.length > TURN_ID_MAX) return undefined;
  if (typeof text !== 'string') return undefined;
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return undefined;
  if (error !== undefined && typeof error !== 'string') return undefined;
  const out: AsideProgress = { sessionId, turnId, text: clipAnswer(text), state: state as AsideProgress['state'] };
  if (error) out.error = error.slice(0, ERROR_MAX);
  return out;
}

export function isFinalAside(s: AsideStatus): boolean {
  return s === 'complete' || s === 'failed' || s === 'cancelled';
}
