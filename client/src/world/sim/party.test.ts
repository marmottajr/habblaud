// Festa no escritório (mundo): relógio da festa, lugares na sala anfitriã e o vai e volta dos personagens. Sem DOM.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeParty, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { inRect } from '../layout/geometry';
import { BLOCKED, FREE } from '../path/grid';
import { PartyState, partyTiles } from './party';
import { Sim } from './sim';

const T0 = 1_700_000_000_000;

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const appearance: Appearance = {
  skin: '#f0c8a0',
  hair: '#3a2a20',
  hairStyle: 'short',
  eyes: '#222',
  top: '#3f7fd8',
  topAccent: '#fff',
  topStyle: 'tshirt',
  bottom: '#333',
  shoes: '#111',
  accessory: 'none',
  accessoryColor: '#000',
  lanyard: null,
  look: 'm',
};

const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;

const room = (id: string, slot: number): RoomInfo => ({ id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 });

function agent(id: string, roomId: string, status: AgentInfo['status'], parentId?: string): AgentInfo {
  return {
    id,
    kind: parentId ? 'sub' : 'main',
    ...(parentId ? { parentId } : {}),
    roomId,
    name: id,
    look: 'f',
    role: parentId ? 'Subagente' : 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567 + id.charCodeAt(0),
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], serverTime: number, rev: number, party?: OfficeParty): OfficeSnapshot {
  return {
    rev,
    serverTime,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    ...(party ? { party } : {}),
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

describe('PartyState', () => {
  it('converte para o relógio do navegador; a mesma festa não recomeça; sem festa no snapshot, acaba', () => {
    const p = new PartyState();
    const server = T0 + 3_600_000;
    p.sync({ roomId: '/a', at: server - 2_000, until: server + 60_000 }, server, T0);
    expect(p.fx).toMatchObject({ roomId: '/a', kind: 'party', start: T0 - 2_000, end: T0 + 60_000 });
    expect(p.on(T0)).toBe(true);
    const fx = p.fx;
    p.sync({ roomId: '/a', at: server - 2_000, until: server + 30_000 }, server + 1_000, T0 + 1_000);
    expect(p.fx).toBe(fx);
    expect(p.fx!.end).toBe(T0 + 30_000);
    p.sync(undefined, server + 2_000, T0 + 2_000);
    expect(p.on(T0 + 2_000)).toBe(false);
    // festa já vencida no servidor nem começa
    const q = new PartyState();
    q.sync({ roomId: '/a', at: T0 - 90_000, until: T0 - 1 }, T0, T0);
    expect(q.fx).toBeNull();
  });

  it('partyTiles: só tiles livres, sem os de aproximação, sala antes do corredor e em xadrez antes das vizinhas', () => {
    // sala 6x6 (piso de y=2 a 4, x=1 a 4) com a porta em (2,5) para um corredor na linha 6
    const w = 8;
    const h = 7;
    const cells = new Uint8Array(w * h).fill(BLOCKED);
    const set = (x: number, y: number) => (cells[y * w + x] = FREE);
    for (let y = 2; y <= 4; y++) for (let x = 1; x <= 4; x++) set(x, y);
    set(2, 5);
    for (let x = 0; x < w; x++) set(x, 6);
    cells[3 * w + 3] = 2; // um assento (evitado): nunca é lugar de festa
    const grid = { w, h, get: (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? cells[y * w + x] : BLOCKED) };
    const spot = new Set([2 * w + 4]);
    const tiles = partyTiles(grid, { x: 0, y: 0, w: 6, h: 6 }, { x: 2, y: 3 }, spot);
    const key = (t: { x: number; y: number }) => `${t.x},${t.y}`;
    expect(tiles.map(key)).not.toContain('3,3');
    expect(tiles.map(key)).not.toContain('4,2');
    expect(key(tiles[0])).toBe('2,3');
    const firstOutside = tiles.findIndex((t) => t.y >= 5);
    expect(tiles.slice(0, firstOutside).every((t) => t.y <= 4)).toBe(true);
    // dentro da sala, as casas do xadrez do começo (mesma cor de (2,3)) vêm todas antes das vizinhas
    const same = tiles.slice(0, firstOutside).map((t) => ((t.x + t.y) & 1) === 1);
    expect(same.indexOf(false)).toBeGreaterThan(0);
    expect(same.slice(same.indexOf(false)).every((s) => !s)).toBe(true);
  });
});

describe('festa no escritório: todos vão e voltam', () => {
  function run(sim: Sim, clock: { now: number }, seconds: number): void {
    for (let i = 0; i < Math.round(seconds * 30); i++) {
      clock.now += 1000 / 30;
      sim.update(1 / 30, clock.now);
    }
  }

  it('principais e subagentes vão para a sala anfitriã e comemoram; quem precisa de você fica; depois cada um volta', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }), null);
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    const agents = [
      agent('ana', '/a', 'working'),
      agent('bia', '/b', 'idle'),
      agent('bel', '/b', 'working', 'bia'),
      agent('caio', '/c', 'waiting'),
      agent('cris', '/c', 'working'),
    ];
    sim.applySnapshot(snap(rooms, agents, clock.now, 1), clock.now);
    run(sim, clock, 1);
    const homes = new Map([...sim.chars.values()].map((c) => [c.id, c.homeSpot]));
    const party: OfficeParty = { roomId: '/a', at: clock.now, until: clock.now + 60_000 };
    sim.applySnapshot(snap(rooms, agents, clock.now, 2, party), clock.now);
    const host = sim.rooms.get('/a')!.layout.rect;
    const poses = new Map<string, Set<string>>();
    for (let i = 0; i < 40; i++) {
      run(sim, clock, 1);
      for (const ch of sim.chars.values()) {
        if (!poses.has(ch.id)) poses.set(ch.id, new Set());
        poses.get(ch.id)!.add(ch.pose);
      }
      // ninguém começa uma roda durante a festa
      expect(sim.social.gatherings.size).toBe(0);
    }
    for (const id of ['ana', 'bia', 'bel', 'cris']) {
      const ch = sim.chars.get(id)!;
      expect(inRect(host, ch.tx, ch.ty), id).toBe(true);
      expect(ch.atSpot, id).toBeNull();
      expect(poses.get(id)!.has('cheer'), id).toBe(true);
    }
    // cada convidado no seu lugar (ninguém em cima de ninguém)
    const tiles = ['ana', 'bia', 'bel', 'cris'].map((id) => `${sim.chars.get(id)!.tx},${sim.chars.get(id)!.ty}`);
    expect(new Set(tiles).size).toBe(4);
    const caio = sim.chars.get('caio')!;
    expect(caio.atSpot).toBe(homes.get('caio'));
    expect(caio.pose).toBe('raise_hand');
    // o snapshot não mudou a sala de ninguém
    for (const ch of sim.chars.values()) expect(ch.roomId).toBe(agents.find((a) => a.id === ch.id)!.roomId);

    // a festa acabou (o servidor tirou do snapshot): cada um volta para o próprio lugar
    sim.applySnapshot(snap(rooms, agents, clock.now, 3), clock.now);
    run(sim, clock, 30);
    expect(sim.party.on(clock.now)).toBe(false);
    for (const id of ['ana', 'bel', 'cris']) {
      const ch = sim.chars.get(id)!;
      expect(ch.atSpot, id).toBe(ch.homeSpot);
      expect(ch.pose, id).toBe('type');
    }
    const bia = sim.chars.get('bia')!;
    expect(inRect(sim.rooms.get('/b')!.layout.rect, bia.tx, bia.ty)).toBe(true);
  });

  it('voltando de uma aba oculta no meio da festa, quem vai já aparece no lugar dele na sala anfitriã', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }), null);
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1)];
    const agents = [agent('ana', '/a', 'working'), agent('bia', '/b', 'idle'), agent('beto', '/b', 'waiting')];
    sim.applySnapshot(snap(rooms, agents, clock.now, 1), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap(rooms, agents, clock.now, 2, { roomId: '/a', at: clock.now, until: clock.now + 60_000 }), clock.now);
    run(sim, clock, 0.2);
    clock.now += 10_000;
    sim.fastForward(clock.now);
    const host = sim.rooms.get('/a')!.layout.rect;
    for (const id of ['ana', 'bia']) {
      const ch = sim.chars.get(id)!;
      expect(inRect(host, ch.tx, ch.ty), id).toBe(true);
      expect(ch.atSpot, id).toBeNull();
    }
    const beto = sim.chars.get('beto')!;
    expect(beto.atSpot).toBe(beto.homeSpot);
  });
});
