// Bate-papo paralelo (ui/aside.ts), parte pura e testada em ui/aside-model.test.ts: quando consultar o servidor, o texto
// de situação de cada pergunta, qual conversa aparece e o rótulo dela no seletor.
import { isFinalAside, type AsideTopic, type AsideTurn } from '../../../shared/asides';
import { tr } from '../../../shared/i18n';
import { formatClock } from './format';

/** Intervalo da consulta com a janela aberta e uma pergunta em andamento. */
export const ASIDE_POLL_MS = 700;
const LABEL_MAX = 60;

/** Há pergunta esperando ou sendo respondida. */
export function asideRunning(topics: readonly AsideTopic[]): boolean {
  return topics.some((t) => t.turns.some((q) => !isFinalAside(q.status)));
}

/** Próxima consulta: só com a janela aberta e uma pergunta em andamento; senão null (sem consulta). */
export function asidePollMs(topics: readonly AsideTopic[], open: boolean): number | null {
  return open && asideRunning(topics) ? ASIDE_POLL_MS : null;
}

/** A linha de situação embaixo da resposta ('' = nada a dizer). */
export function asideStatusText(turn: Pick<AsideTurn, 'status' | 'answer' | 'error'>): string {
  switch (turn.status) {
    case 'queued':
      return tr('esperando a sessão buscar…');
    case 'running':
      return turn.answer ? '' : tr('pensando…');
    case 'cancelled':
      return tr('parada');
    case 'failed':
      return tr('falhou: {0}', [turn.error ?? '']);
    default:
      return '';
  }
}

/** A conversa escolhida, se ainda existir; senão a mais recente (a primeira da lista); sem conversas, undefined. */
export function currentTopic(topics: readonly AsideTopic[], chosenId: string | null | undefined): AsideTopic | undefined {
  return (chosenId ? topics.find((t) => t.id === chosenId) : undefined) ?? topics[0];
}

/** "o que você está fazendo agora?… · 14:30": a primeira pergunta (até 60 caracteres) e a hora em que a conversa começou. */
export function topicLabel(topic: Pick<AsideTopic, 'createdAt' | 'turns'>): string {
  const first = (topic.turns[0]?.question ?? '').replace(/\s+/g, ' ').trim();
  const text = first.length > LABEL_MAX ? `${first.slice(0, LABEL_MAX)}…` : first;
  return `${text} · ${formatClock(topic.createdAt, false)}`;
}
