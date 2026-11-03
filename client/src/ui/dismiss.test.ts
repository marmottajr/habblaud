import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { activeDismissals, canDismiss, expandDismissed } from './dismiss';

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId: 'loja',
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 1_000,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...extra,
  };
}

describe('dispensar personagem', () => {
  it('a dispensa vale enquanto a sessão não registra nada novo', () => {
    const a = agent('acc:1', { lastEventAt: 1_000 });
    expect(activeDismissals([{ id: 'acc:1', at: 2_000 }], [a]).map((d) => d.id)).toEqual(['acc:1']);
    // Voltou a trabalhar depois do clique: o personagem volta ao escritório sozinho.
    expect(activeDismissals([{ id: 'acc:1', at: 2_000 }], [agent('acc:1', { lastEventAt: 2_001 })])).toEqual([]);
  });

  it('some a dispensa de quem encerrou a sessão ou nem está mais no escritório', () => {
    expect(activeDismissals([{ id: 'acc:1', at: 2_000 }], [agent('acc:1', { status: 'offline' })])).toEqual([]);
    expect(activeDismissals([{ id: 'acc:1', at: 2_000 }], [])).toEqual([]);
    expect(activeDismissals([], [agent('acc:1')])).toEqual([]);
  });

  it('o principal dispensado leva os subagentes dele (inclusive os de segundo nível)', () => {
    const agents = [
      agent('acc:1'),
      agent('acc:2'),
      agent('sub-1', { kind: 'sub', parentId: 'acc:1' }),
      agent('sub-1-1', { kind: 'sub', parentId: 'sub-1' }),
      agent('sub-2', { kind: 'sub', parentId: 'acc:2' }),
    ];
    expect([...expandDismissed([{ id: 'acc:1', at: 5_000 }], agents)].sort()).toEqual(['acc:1', 'sub-1', 'sub-1-1']);
    expect(expandDismissed([], agents).size).toBe(0);
  });

  it('só dá para dispensar um principal presente e ainda não dispensado', () => {
    expect(canDismiss(agent('acc:1'), new Set())).toBe(true);
    expect(canDismiss(agent('acc:1'), new Set(['acc:1']))).toBe(false);
    expect(canDismiss(agent('acc:1', { status: 'offline' }), new Set())).toBe(false);
    expect(canDismiss(agent('sub-1', { kind: 'sub', parentId: 'acc:1' }), new Set())).toBe(false);
    expect(canDismiss(undefined, new Set())).toBe(false);
  });
});
