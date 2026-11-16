// Festa no escritório: o corpo do POST /api/party e a escolha da sala anfitriã.
import { describe, expect, it } from 'vitest';
import { PARTY_DEFAULT_MS, parsePartyRequest, pickPartyRoom } from './party';

const rooms = [
  { id: '/p/loja', name: 'loja', slot: 0 },
  { id: '/p/site', name: 'Site', slot: 1 },
  { id: '/p/api', name: 'api', slot: 2 },
];

describe('parsePartyRequest', () => {
  it('corpo vazio: festa padrão (~2 min) na sala com mais agentes', () => {
    expect(parsePartyRequest({})).toEqual({ ms: PARTY_DEFAULT_MS });
    expect(parsePartyRequest(undefined)).toEqual({ ms: PARTY_DEFAULT_MS });
    expect(PARTY_DEFAULT_MS).toBe(120_000);
  });

  it('sala e duração em segundos', () => {
    expect(parsePartyRequest({ room: ' site ', seconds: 30 })).toEqual({ room: 'site', ms: 30_000 });
    expect(parsePartyRequest({ room: '', seconds: null })).toEqual({ ms: PARTY_DEFAULT_MS });
  });

  it('recusa duração fora de 10 a 600 s, não inteira, e tipos errados', () => {
    for (const seconds of [9, 601, 12.5, '30', -1]) expect(parsePartyRequest({ seconds })).toHaveProperty('error');
    expect(parsePartyRequest({ room: 42 })).toHaveProperty('error');
    expect(parsePartyRequest([])).toHaveProperty('error');
    expect(parsePartyRequest('festa')).toHaveProperty('error');
  });
});

describe('pickPartyRoom', () => {
  it('sem pedido: a sala com mais agentes presentes (quem saiu ou terminou não conta)', () => {
    const agents = [
      { roomId: '/p/site', status: 'working' as const },
      { roomId: '/p/api', status: 'idle' as const },
      { roomId: '/p/api', status: 'waiting' as const },
      { roomId: '/p/site', status: 'offline' as const },
      { roomId: '/p/site', status: 'done' as const },
    ];
    expect(pickPartyRoom(rooms, agents)).toEqual({ roomId: '/p/api' });
  });

  it('empate fica com a sala mais antiga no prédio (menor slot)', () => {
    const agents = [
      { roomId: '/p/api', status: 'idle' as const },
      { roomId: '/p/site', status: 'idle' as const },
    ];
    expect(pickPartyRoom(rooms, agents)).toEqual({ roomId: '/p/site' });
    expect(pickPartyRoom(rooms, [])).toEqual({ roomId: '/p/loja' });
  });

  it('com pedido: pelo id ou pelo nome, sem diferenciar caixa; desconhecida é erro', () => {
    expect(pickPartyRoom(rooms, [], '/p/api')).toEqual({ roomId: '/p/api' });
    expect(pickPartyRoom(rooms, [], 'SITE')).toEqual({ roomId: '/p/site' });
    expect(pickPartyRoom(rooms, [], 'cozinha')).toEqual({ error: 'unknown' });
  });

  it('sem nenhuma sala, não há festa', () => {
    expect(pickPartyRoom([], [])).toEqual({ error: 'empty' });
  });
});
