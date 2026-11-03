import { describe, expect, it } from 'vitest';
import type { AgentInfo, PendingReply } from '../../../shared/types';
import { pendingReply, replyActivity, replyText } from './reply';

const reply: PendingReply = {
  id: 'tu1',
  ask: 'Commito essa mudança?',
  recap: 'Testes passando, nada commitado.',
  options: [{ label: 'Commita', message: 'Pode commitar.' }, { label: 'Agora não' }],
  at: 1_000,
};

function agent(extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'acc:1',
    kind: 'main',
    roomId: 'loja',
    name: 'Marina',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: '.claude',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    reply,
    ...extra,
  };
}

describe('pergunta de fim de turno', () => {
  it('vale para o principal no escritório; não para subagente nem sessão encerrada', () => {
    expect(pendingReply(agent())).toBe(reply);
    expect(pendingReply(agent({ status: 'working' }))).toBe(reply);
    expect(pendingReply(agent({ status: 'offline' }))).toBeUndefined();
    expect(pendingReply(agent({ kind: 'sub', status: 'done' }))).toBeUndefined();
    expect(pendingReply(agent({ reply: undefined }))).toBeUndefined();
    expect(pendingReply(undefined)).toBeUndefined();
  });

  it('o botão manda o texto da ferramenta ou, sem ele, o próprio rótulo', () => {
    expect(replyText({ label: 'Commita', message: 'Pode commitar.' })).toBe('Pode commitar.');
    expect(replyText({ label: 'Agora não' })).toBe('Agora não');
  });

  it('a linha da barra lateral mostra a pergunta só com o turno terminado', () => {
    expect(replyActivity(agent())).toMatchObject({ kind: 'ask', icon: '❓', text: 'Commito essa mudança?', detail: 'Testes passando, nada commitado.' });
    // Voltou a trabalhar: a linha mostra o que ele está fazendo agora.
    expect(replyActivity(agent({ status: 'working' }))).toBeUndefined();
    expect(replyActivity(agent({ reply: undefined }))).toBeUndefined();
  });
});
