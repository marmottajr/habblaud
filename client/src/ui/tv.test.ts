import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { roomMains } from './tv';

const agent = (id: string, over: Partial<AgentInfo>): AgentInfo => ({ id, kind: 'main', roomId: 'r1', status: 'idle', ...over }) as AgentInfo;

describe('TV: quem recebe o pedido', () => {
  it('só os agentes principais presentes na sala', () => {
    const list = roomMains(
      [
        agent('a', {}),
        agent('b', { kind: 'sub' }),
        agent('c', { roomId: 'r2' }),
        agent('d', { status: 'offline' }),
        agent('e', { status: 'done' }),
        agent('f', { status: 'working' }),
      ],
      'r1',
    );
    expect(list.map((a) => a.id)).toEqual(['a', 'f']);
  });
});
