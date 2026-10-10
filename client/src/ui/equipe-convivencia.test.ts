// Equipe de agentes fixos junto com o resto da tela: caixa de mensagem, editor de personagem e renomear sala.
// A caixa "Mandar mensagem" do autor (plugin habblaud-mensagens) fica para as sessões comuns; com agente fixo a
// conversa é pelo nosso recado ("Falar com", na gaveta). O lápis do editor de personagem aparece também para o agente
// fixo parado (o servidor grava um personagem por agente: server/equipe/juncao.test.ts).
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { canEditCharacter } from './character-model';
import { composerMode, PLUGIN_HINT, STAFF_HINT } from './composer-model';

const ENV = { enabled: true, local: true, replaying: false };

function agente(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: '.claude:1',
    kind: 'main',
    roomId: '/p/social',
    name: 'Ana',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...over,
  };
}

describe('caixa de mensagem do autor e o nosso recado', () => {
  it('sessão comum: a caixa do autor funciona como ele fez (pronta com o plugin, dica sem ele)', () => {
    expect(composerMode(agente({ canMessage: true }), ENV)).toEqual({ kind: 'ready' });
    expect(composerMode(agente(), ENV)).toEqual({ kind: 'hint', text: PLUGIN_HINT });
  });

  it('agente fixo trabalhando: a caixa do autor não aparece, mesmo com o plugin conectado (vale o "Falar com")', () => {
    const fixo = agente({ staff: 'cmo', canMessage: true });
    expect(composerMode(fixo, ENV)).toEqual({ kind: 'off', text: STAFF_HINT });
    expect(STAFF_HINT).toMatch(/Falar com/);
  });

  it('agente fixo parado: nem caixa nem a dica de instalar o plugin', () => {
    const parado = agente({ id: 'equipe:/p/social:cmo', staff: 'cmo', parked: true, status: 'idle', sessionId: '' });
    expect(composerMode(parado, ENV)).toEqual({ kind: 'off', text: STAFF_HINT });
  });
});

describe('lápis do editor de personagem', () => {
  const GATE = { live: true, terminal: true, local: true, replaying: false, mock: false };

  it('aparece para a sessão comum, para o agente fixo trabalhando e para o agente fixo parado', () => {
    expect(canEditCharacter(agente(), GATE)).toBe(true);
    expect(canEditCharacter(agente({ staff: 'cmo' }), GATE)).toBe(true);
    expect(canEditCharacter(agente({ id: 'equipe:/p/social:cmo', staff: 'cmo', parked: true, status: 'idle' }), GATE)).toBe(true);
  });

  it('continua escondido no timelapse e fora do próprio computador', () => {
    const parado = agente({ id: 'equipe:/p/social:cmo', staff: 'cmo', parked: true, status: 'idle' });
    expect(canEditCharacter(parado, { ...GATE, replaying: true })).toBe(false);
    expect(canEditCharacter(parado, { ...GATE, local: false })).toBe(false);
  });
});
