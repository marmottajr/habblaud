import { describe, expect, it } from 'vitest';
import type { AsideStatus, AsideTopic, AsideTurn } from '../../../shared/asides';
import { ASIDE_POLL_MS, asidePollMs, asideRunning, asideStatusText, currentTopic, topicLabel } from './aside-model';

function turn(status: AsideStatus, over: Partial<AsideTurn> = {}): AsideTurn {
  return { id: `q-${status}`, question: 'pergunta', answer: '', status, createdAt: 1, updatedAt: 1, ...over };
}
function topic(id: string, turns: AsideTurn[] = [turn('complete')], createdAt = 1_700_000_000_000): AsideTopic {
  return { id, createdAt, updatedAt: createdAt, turns };
}

describe('asideRunning / asidePollMs', () => {
  it('só consulta com a janela aberta e uma pergunta em andamento', () => {
    const idle = [topic('a')];
    const queued = [topic('a', [turn('complete'), turn('queued')])];
    const running = [topic('a', [turn('running')])];
    expect(asideRunning(idle)).toBe(false);
    expect(asideRunning(queued)).toBe(true);
    expect(asidePollMs(running, true)).toBe(ASIDE_POLL_MS);
    expect(asidePollMs(queued, true)).toBe(ASIDE_POLL_MS);
    expect(asidePollMs(running, false)).toBeNull();
    expect(asidePollMs(idle, true)).toBeNull();
    expect(asidePollMs([], true)).toBeNull();
    expect(ASIDE_POLL_MS).toBe(700);
  });

  it('pergunta falha, cancelada ou completa não conta como em andamento', () => {
    expect(asideRunning([topic('a', [turn('failed'), turn('cancelled'), turn('complete')])])).toBe(false);
  });
});

describe('asideStatusText', () => {
  it('uma frase por situação; running com texto e complete ficam sem linha', () => {
    expect(asideStatusText(turn('queued'))).toBe('esperando a sessão buscar…');
    expect(asideStatusText(turn('running'))).toBe('pensando…');
    expect(asideStatusText(turn('running', { answer: 'oi' }))).toBe('');
    expect(asideStatusText(turn('cancelled'))).toBe('parada');
    expect(asideStatusText(turn('failed', { error: 'sem rede' }))).toBe('falhou: sem rede');
    expect(asideStatusText(turn('complete', { answer: 'oi' }))).toBe('');
  });
});

describe('currentTopic', () => {
  const topics = [topic('novo'), topic('velho')];
  it('devolve a conversa escolhida', () => {
    expect(currentTopic(topics, 'velho')?.id).toBe('velho');
  });
  it('a escolhida que sumiu (ou nenhuma) cai na mais recente', () => {
    expect(currentTopic(topics, 'apagada')?.id).toBe('novo');
    expect(currentTopic(topics, null)?.id).toBe('novo');
    expect(currentTopic(topics, undefined)?.id).toBe('novo');
  });
  it('lista vazia: undefined', () => {
    expect(currentTopic([], 'x')).toBeUndefined();
  });
});

describe('topicLabel', () => {
  it('a primeira pergunta cortada em 60 caracteres, com reticências, e a hora', () => {
    const long = topic('a', [turn('complete', { question: 'x'.repeat(80) })]);
    expect(topicLabel(long)).toMatch(new RegExp(`^x{60}… · \\d{1,2}[:h.]\\d{2}`));
    const short = topic('b', [turn('complete', { question: '  o que\nfaz?  ' })]);
    expect(topicLabel(short)).toMatch(/^o que faz\? · /);
    expect(topicLabel(topic('c', [turn('complete', { question: 'x'.repeat(60) })]))).not.toContain('…');
  });
});
