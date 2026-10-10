// Integração da simulação sem DOM: snapshots -> personagens andando, sentando, apagando a luz e indo embora.
import { describe, expect, it } from 'vitest';
import type { AppearanceParts } from '../../../../shared/appearance';
import type { AgentInfo, OfficeSnapshot, RoomInfo, ShellJob } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import type { Character } from './character';
import { MEETING_SLOT, MEETING_SUFFIX, OWNER_SLOT, SHELL_DONE_TOOL, Sim } from './sim';

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

const art = {
  appearanceFromSeed: () => appearance,
  roomTheme: () => theme,
} as unknown as ArtModule;

const T0 = 1_700_000_000_000;

function room(id: string, slot: number): RoomInfo {
  return { id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 };
}

function agent(id: string, roomId: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], rev = 1): OfficeSnapshot {
  return {
    rev,
    serverTime: T0,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

/** Avança a simulação em passos de 1/30 s. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

function newSim(): Sim {
  return new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
}

describe('simulação do escritório', () => {
  it('carga inicial: quem trabalha já está sentado digitando, sala acesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/a', 'waiting', { waitingFor: 'aprovar' })]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    const bia = sim.chars.get('bia')!;
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('type');
    expect(bia.pose).toBe('raise_hand');
    expect(bia.mode).toBe('wait');
    const r = sim.rooms.get('/a')!;
    expect(r.phase).toBe('ready');
    expect(r.lightOn).toBe(true);
  });

  it('chegada: sala nova é construída apagada, o primeiro acende a luz e senta', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.phase).toBe('building');
    expect(b.lightOn).toBe(false);
    const caio = sim.chars.get('caio')!;
    expect(caio.step?.t ?? caio.queue[0]?.t).toBe('elevOut');
    run(sim, clock, 60, () => !!caio.homeSpot && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.phase).toBe('ready');
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
    run(sim, clock, 0.1);
    expect(caio.pose).toBe('type');
  });

  it('chegada: mudar de status a caminho do interruptor não deixa a sala no escuro', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 3);
    expect(b.lightOn).toBe(false);
    expect(b.switchClaim).toBe('caio');
    // ainda andando até o interruptor: o status muda duas vezes (o plano é refeito)
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'waiting', { waitingFor: 'aprovar' })], 3), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 4), clock.now);
    run(sim, clock, 60, () => b.lightOn && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
  });

  it('saída: quem acabou de acender a luz e já precisa ir embora apaga de novo ao sair', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 60, () => caio.step?.t === 'switch');
    expect(caio.step?.t).toBe('switch');
    // a sessão termina bem no meio do clique do interruptor
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 3), clock.now);
    run(sim, clock, 20, () => caio.leaving && !b.lightOn);
    expect(b.lightOn).toBe(false);
    // ainda a caminho do elevador quando a luz apaga
    expect(sim.chars.has('caio')).toBe(true);
    run(sim, clock, 90, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
  });

  it('saída: o último apaga a luz, vai ao elevador, some e a sala é desmontada', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working'), agent('davi', '/b', 'idle')]), clock.now);
    run(sim, clock, 0.5);
    // sessões da sala /b encerram: caio fica offline, davi some do snapshot
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.listed).toBe(false);
    expect(sim.chars.get('caio')!.mode).toBe('leave');
    // davi só sai depois do debounce de 3 s
    run(sim, clock, 1);
    expect(sim.chars.get('davi')!.leaving).toBe(false);
    run(sim, clock, 3);
    expect(sim.chars.get('davi')!.leaving).toBe(true);
    // exatamente um deles se encarrega do interruptor
    expect(b.switchClaim).not.toBeNull();
    run(sim, clock, 90, () => !b.lightOn);
    expect(b.lightOn).toBe(false);
    run(sim, clock, 90, () => !sim.chars.has('caio') && !sim.chars.has('davi'));
    expect(sim.chars.has('caio')).toBe(false);
    expect(sim.chars.has('davi')).toBe(false);
    run(sim, clock, 10, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    // a outra sala continua acesa
    expect(sim.rooms.get('/a')!.lightOn).toBe(true);
  });

  it('subagente entrega o resultado ao pai e vai embora', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const main = agent('ana', '/a', 'working');
    sim.applySnapshot(snap(rooms, [main]), clock.now);
    run(sim, clock, 0.2);
    const sub = agent('ana:s1', '/a', 'working', { kind: 'sub', parentId: 'ana', name: 'Beto', title: 'Mapear arquivos' });
    sim.applySnapshot(snap(rooms, [main, sub], 2), clock.now);
    const beto = sim.chars.get('ana:s1')!;
    run(sim, clock, 60, () => beto.atSpot !== null && beto.atSpot === beto.homeSpot && !beto.step && !beto.queue.length);
    expect(beto.homeSpot).not.toBeNull();
    sim.applySnapshot(snap(rooms, [main, { ...sub, status: 'done' }], 3), clock.now);
    expect(beto.mode).toBe('deliver');
    let delivered = false;
    run(sim, clock, 40, () => {
      if (beto.bubbleText?.startsWith('Entregando')) delivered = true;
      return delivered;
    });
    expect(delivered).toBe(true);
    const ana = sim.chars.get('ana')!;
    expect(['check', 'heart']).toContain(ana.icon);
    run(sim, clock, 60, () => !sim.chars.has('ana:s1'));
    expect(sim.chars.has('ana:s1')).toBe(false);
  });

  it('ocioso passeia e volta para a mesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    let left = false;
    run(sim, clock, 60, () => {
      if (ana.atSpot !== ana.homeSpot) left = true;
      return left && ana.atSpot === ana.homeSpot;
    });
    expect(left).toBe(true);
    // volta ao trabalho imediatamente quando o status muda
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')], 2), clock.now);
    run(sim, clock, 60, () => !!ana.homeSpot && ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('type');
  });

  it('quem cochila na mesa (ocioso há muito tempo) acorda ao levantar: o "zzz" não vai junto', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 - 3_600_000 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 60, () => ana.atSpot === ana.homeSpot && ana.icon === 'zzz');
    expect(ana.pose).toBe('sleep');
    expect(ana.icon).toBe('zzz');
    // Uma roda (ou qualquer plano) tira do lugar sem mudar o modo: segue "ocioso há muito tempo".
    ana.queue.push({ t: 'exit' }, { t: 'act', pose: 'stand', ms: 4000 });
    run(sim, clock, 1.5);
    expect(ana.pose).toBe('stand');
    expect(ana.icon).toBeNull();
    // A verificação de 1 em 1 s não devolve o "zzz" a quem está de pé.
    run(sim, clock, 1.5);
    expect(ana.icon).toBeNull();
  });

  it('avanço rápido (aba oculta) teletransporta para os destinos', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    clock.now += 20_000;
    sim.fastForward(clock.now);
    const caio = sim.chars.get('caio')!;
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(caio.alpha).toBe(1);
    expect(sim.rooms.get('/b')!.phase).toBe('ready');
    expect(sim.rooms.get('/b')!.lightOn).toBe(true);
  });

  it('snapshots com falhas não quebram o mundo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/inexistente', 'working'), agent('bia', '/a', 'working', { parentId: 'ninguem', kind: 'sub' })]), clock.now);
    run(sim, clock, 5);
    expect(sim.chars.size).toBe(2);
    // sala some e volta durante a desmontagem: reconstrói
    sim.applySnapshot(snap([], [], 2), clock.now);
    run(sim, clock, 20);
    sim.applySnapshot(snap([room('/a', 0)], [agent('caio', '/a', 'working')], 3), clock.now);
    run(sim, clock, 5);
    const a = sim.rooms.get('/a');
    expect(a).toBeDefined();
    expect(['building', 'ready']).toContain(a!.phase);
  });

  it('carga inicial: ninguém começa parado em banco de corredor/banheiro e nenhuma sala fica vazia', () => {
    for (const since of [T0, T0 - 5 * 60_000]) {
      const sim = newSim();
      const clock = { now: T0 };
      const agents: AgentInfo[] = [];
      for (let i = 0; i < 12; i++) agents.push(agent(`ocioso-${String.fromCharCode(97 + i)}${'x'.repeat(i)}`, i % 2 ? '/b' : '/a', 'idle', { statusSince: since }));
      sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], agents), clock.now);
      for (const ch of sim.chars.values()) {
        const at = ch.atSpot ? sim.spots.get(ch.atSpot) : undefined;
        expect(at, `${ch.id} sem lugar`).toBeDefined();
        expect(at!.kind).not.toBe('bench');
        // quem acabou de ficar ocioso começa na própria mesa
        if (since === T0) expect(ch.atSpot).toBe(ch.homeSpot);
      }
      for (const id of ['/a', '/b']) expect([...sim.chars.values()].some((c) => c.roomId === id && c.atSpot === c.homeSpot)).toBe(true);
      // e ninguém sai passear nos primeiros segundos
      run(sim, clock, 3);
      if (since === T0) for (const ch of sim.chars.values()) expect(ch.atSpot, ch.id).toBe(ch.homeSpot);
    }
  });

  it('sala lotada: quem sobra trabalha em pé DENTRO da sala (não fica rodando na recepção)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents: AgentInfo[] = [];
    for (let i = 0; i < 26; i++) agents.push(agent(`ag-${i}-${'y'.repeat(i)}`, '/a', 'working'));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    run(sim, clock, 25);
    const r = sim.rooms.get('/a')!.layout.rect;
    const inside = (x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const homeless = [...sim.chars.values()].filter((c) => !c.homeSpot);
    expect(homeless.length).toBeGreaterThan(0);
    const tiles = new Set<string>();
    for (const c of homeless) {
      expect(c.standTile, c.id).not.toBeNull();
      expect(inside(c.standTile!.x, c.standTile!.y)).toBe(true);
      expect(inside(c.tx, c.ty), `${c.id} fora da sala em ${c.tx},${c.ty}`).toBe(true);
      const key = `${c.standTile!.x},${c.standTile!.y}`;
      expect(tiles.has(key), `dois no mesmo tile ${key}`).toBe(false);
      tiles.add(key);
    }
    // parados (não andando em círculos) e trabalhando com o notebook
    const before = homeless.map((c) => `${c.tx},${c.ty}`);
    run(sim, clock, 15);
    expect(homeless.map((c) => `${c.tx},${c.ty}`)).toEqual(before);
    expect(homeless.every((c) => c.pose === 'read' && c.held === 'laptop')).toBe(true);
    // vagou um lugar: alguém de pé senta
    const seated = [...sim.chars.values()].find((c) => c.homeSpot && c.atSpot === c.homeSpot)!;
    sim.applySnapshot(snap([room('/a', 0)], agents.filter((a) => a.id !== seated.id), 2), clock.now);
    run(sim, clock, 40, () => homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot));
    expect(homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot)).toBe(true);
  });

  it('delegar: conversa virado para a porta com 💬 (a mão levantada é só para "precisa de você")', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const main = agent('ana', '/a', 'working', { activity: { id: 'a1', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap([room('/a', 0)], [main]), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap([room('/a', 0)], [{ ...main, activity: { id: 'a2', kind: 'delegate', icon: '👥', text: 'Delegando', at: T0 } }], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBe('chat');
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('talk')).toBe(true);
    expect(poses.has('raise_hand')).toBe(false);
  });

  it('cada personagem tem ritmo e faixa próprios (quem sai junto não anda sobreposto)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map((id) => agent(id, '/a', 'working', { seed: id.charCodeAt(0) * 7919 + id.length }));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    const chars = [...sim.chars.values()];
    for (const c of chars) {
      expect(c.speedK).toBeGreaterThanOrEqual(0.92);
      expect(c.speedK).toBeLessThanOrEqual(1.08);
      expect(Math.abs(c.lane)).toBeLessThanOrEqual(4);
    }
    expect(new Set(chars.map((c) => c.speedK.toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(chars.map((c) => c.lane)).size).toBeGreaterThan(1);
  });

  it('personagem editado: seed ou peças novas no snapshot trocam a aparência de quem já está no escritório', () => {
    let calls = 0;
    const spyArt = {
      appearanceFromSeed: (seed: number, opts: { parts?: AppearanceParts } = {}) => {
        calls++;
        return { ...appearance, skin: `#${seed.toString(16).padStart(6, '0')}`, ...opts.parts };
      },
      roomTheme: () => theme,
    } as unknown as ArtModule;
    const sim = new Sim(spyArt, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 1 })]), clock.now);
    run(sim, clock, 0.2);
    expect(sim.chars.get('ana')!.appearance.skin).toBe('#000001');

    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 2, parts: { hairStyle: 'bob' } })], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.appearance.skin).toBe('#000002');
    expect(ana.appearance.hairStyle).toBe('bob');

    const before = calls;
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { seed: 2, parts: { hairStyle: 'bob' } })], 3), clock.now);
    expect(calls).toBe(before);
  });

  it('personagem editado: só as peças ou só o look mudando (mesma seed) também trocam a aparência', () => {
    let calls = 0;
    const spyArt = {
      appearanceFromSeed: (seed: number, opts: { look?: 'm' | 'f'; parts?: AppearanceParts } = {}) => {
        calls++;
        return { ...appearance, skin: `#${seed.toString(16).padStart(6, '0')}`, look: opts.look ?? appearance.look, ...opts.parts };
      },
      roomTheme: () => theme,
    } as unknown as ArtModule;
    const sim = new Sim(spyArt, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    let rev = 1;
    const apply = (extra: Partial<AgentInfo>): Character => {
      sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 1, look: 'f', ...extra })], rev++), clock.now);
      return sim.chars.get('ana')!;
    };

    expect(apply({}).appearance.hairStyle).toBe('short');

    // mesma seed, peças novas
    expect(apply({ parts: { hairStyle: 'buzz' } }).appearance.hairStyle).toBe('buzz');

    // mesma seed, peças diferentes
    expect(apply({ parts: { hairStyle: 'bob' } }).appearance.hairStyle).toBe('bob');

    // mesma seed, peças removidas: volta ao da fixture
    expect(apply({ parts: undefined }).appearance.hairStyle).toBe('short');

    // mesma seed e mesmas peças, só o look diferente: gera de novo
    apply({ parts: { hairStyle: 'bob' } });
    const before = calls;
    expect(apply({ look: 'm', parts: { hairStyle: 'bob' } }).appearance.look).toBe('m');
    expect(calls).toBe(before + 1);
  });
});

describe('salas sem buracos', () => {
  const inside = (r: { layout: { rect: { x: number; y: number; w: number; h: number } } }, c: { tx: number; ty: number }) =>
    c.tx >= r.layout.rect.x && c.tx < r.layout.rect.x + r.layout.rect.w && c.ty >= r.layout.rect.y && c.ty < r.layout.rect.y + r.layout.rect.h;

  it('carga inicial: as salas ocupam as vagas 0, 1, 2... na ordem do servidor, mesmo com buracos nos slots dele', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/c', 8), room('/a', 0), room('/b', 3)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(['/a', '/b', '/c'].map((id) => sim.rooms.get(id)!.slot)).toEqual([0, 1, 2]);
    expect(sim.building.cols).toBe(4);
  });

  it('terminal fechou: a sala mais distante se muda para a vaga, o pessoal vai andando e o prédio encolhe', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    const agents = [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working'), agent('davi', '/c', 'idle')];
    sim.applySnapshot(snap(rooms, agents), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    const caio = sim.chars.get('caio')!;
    const homeBefore = caio.homeSpot;
    expect(c.slot).toBe(2);
    expect(sim.building.cols).toBe(4);

    // a sessão da sala /b fecha: bia vai embora e a sala é desmontada
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agents[0], agent('bia', '/b', 'offline'), agents[2], agents[3]], 2), clock.now);
    run(sim, clock, 200, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    expect(c.slot).toBe(2);

    // a vaga espera um pouco e então a sala /c se muda para ela (reconstruída, apagada)
    run(sim, clock, 3, () => c.slot === 1);
    expect(c.slot).toBe(1);
    expect(c.phase).toBe('building');
    const ghost = [...sim.rooms.values()].find((r) => r.ghost);
    expect(ghost?.slot).toBe(2);
    expect(ghost?.listed).toBe(false);
    // cada um continua com a sua mesa (agora na sala nova) e vai andando até ela, sem teletransporte
    expect(caio.homeSpot).toBe(homeBefore);
    let maxStep = 0;
    let px = caio.x;
    let py = caio.y;
    run(sim, clock, 60, () => {
      maxStep = Math.max(maxStep, Math.hypot(caio.x - px, caio.y - py));
      px = caio.x;
      py = caio.y;
      return !sim.rooms.has(ghost!.id) && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length;
    });
    expect(maxStep).toBeLessThan(12);
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(inside(c, caio)).toBe(true);
    expect(c.phase).toBe('ready');
    expect(c.lightOn).toBe(true);
    // o endereço antigo esvaziou, apagou e foi desmontado; o prédio voltou a ter uma coluna de salas
    expect(sim.rooms.has(ghost!.id)).toBe(false);
    run(sim, clock, 10, () => sim.building.cols === 3);
    expect(sim.building.cols).toBe(3);
    // davi (ocioso, talvez passeando) também tem o lugar dele na sala nova
    expect(c.layout.spots.some((p) => p.id === sim.chars.get('davi')!.homeSpot)).toBe(true);
  });

  it('quem está indo embora não se muda: a vaga fica até a sala dela sumir', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'offline'), agent('caio', '/c', 'offline')], 2), clock.now);
    let moved = false;
    run(sim, clock, 240, () => {
      if (c.slot !== 2 || [...sim.rooms.values()].some((r) => r.ghost)) moved = true;
      return !sim.rooms.has('/b') && !sim.rooms.has('/c');
    });
    expect(moved).toBe(false);
    expect(sim.rooms.has('/c')).toBe(false);
    run(sim, clock, 5, () => sim.building.cols === 3);
    expect(sim.building.cols).toBe(3);
  });

  it('abre e fecha ao acaso (inclusive no meio de uma mudança): ninguém se teletransporta e no fim não sobra buraco', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const sim = newSim();
    const clock = { now: T0 };
    const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'];
    const open = new Map<string, number>();
    ids.slice(0, 5).forEach((id, i) => open.set(id, i));
    let nextSlot = 5;
    let rev = 1;
    const agentsOf = (id: string, status: AgentInfo['status']) => [agent(`${id}-1`, id, status), agent(`${id}-2`, id, status === 'offline' ? 'offline' : 'idle')];
    const closed = new Set<string>();
    const push = () => {
      const rs = [...open].map(([id, slot]) => room(id, slot));
      const as = [...open.keys()].flatMap((id) => agentsOf(id, 'working')).concat([...closed].flatMap((id) => agentsOf(id, 'offline')));
      sim.applySnapshot(snap(rs, as, ++rev), clock.now);
    };
    push();
    let maxStep = 0;
    // por personagem (quem volta com o mesmo id é outro personagem, que sai do elevador)
    const last = new WeakMap<object, { x: number; y: number }>();
    const track = () => {
      for (const ch of sim.chars.values()) {
        const p = last.get(ch);
        if (p && ch.visible && !ch.inside && clock.now >= ch.hiddenUntil) maxStep = Math.max(maxStep, Math.hypot(ch.x - p.x, ch.y - p.y));
        last.set(ch, { x: ch.x, y: ch.y });
      }
      return false;
    };
    for (let round = 0; round < 14; round++) {
      const roll = rnd();
      if (roll < 0.55 && open.size > 1) {
        const id = [...open.keys()][Math.floor(rnd() * open.size)];
        open.delete(id);
        closed.add(id);
      } else {
        const id = ids.find((x) => !open.has(x));
        if (id) {
          open.set(id, nextSlot++);
          closed.delete(id);
        }
      }
      push();
      run(sim, clock, 4 + rnd() * 40, track);
    }
    run(sim, clock, 400, () => {
      track();
      const rs = [...sim.rooms.values()];
      const compact = rs.every((r) => r.slot < rs.length);
      return compact && rs.every((r) => r.listed && r.phase === 'ready' && !r.ghost) && [...sim.chars.values()].every((c) => !c.leaving);
    });
    const slots = [...sim.rooms.values()].map((r) => r.slot).sort((a, b) => a - b);
    expect([...sim.rooms.keys()].sort()).toEqual([...open.keys()].sort());
    expect(slots).toEqual(slots.map((_, i) => i));
    expect([...sim.rooms.values()].some((r) => r.ghost)).toBe(false);
    run(sim, clock, 20, () => sim.building.cols === 2 + Math.ceil(open.size / 2));
    expect(sim.building.cols).toBe(2 + Math.ceil(open.size / 2));
    expect(maxStep).toBeLessThan(12);
  });

  it('sala que abre depois ocupa a primeira vaga livre', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(sim.rooms.get('/c')!.slot).toBe(1);
    run(sim, clock, 0.5);
    // o servidor manda a sala nova num slot alto; no prédio ela vai para a vaga 2
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2), room('/d', 7)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working'), agent('duda', '/d', 'working')], 2), clock.now);
    expect(sim.rooms.get('/d')!.slot).toBe(2);
    expect(sim.rooms.get('/d')!.phase).toBe('building');
  });
});

describe('espera de shell', () => {
  const MIN = 60_000;
  const shell = (ageMs: number, extra: Partial<ShellJob> = {}): ShellJob => ({
    id: `b-${ageMs}`,
    label: 'Rodar a suíte completa',
    startedAt: T0 - ageMs,
    background: true,
    kind: 'shell',
    ...extra,
  });
  const done = (id: string, error = false): AgentInfo['activity'] => ({ id, kind: 'run', icon: error ? '❌' : '✅', text: 'Shell concluído', tool: SHELL_DONE_TOOL, error, at: T0 });

  it('status shell: fica na mesa com o balde de pipoca e não sai para passear', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'shell', { shells: [shell(20_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.shellLabel).toBe('Rodar a suíte completa');
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot);
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('wait');
    expect(ana.held).toBe('popcorn');
    expect(ana.shellStage).toBe('popcorn');
  });

  it('a escalada segue a idade do shell mais antigo: giros, teia/bocejo e cochilo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(4 * MIN), shell(30_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.shellCount).toBe(2);
    run(sim, clock, 0.2);
    expect(ana.shellStage).toBe('restless');
    expect(ana.held).toBe('none');
    const home = sim.spots.get(ana.homeSpot)!;
    const dirs = new Set<string>();
    run(sim, clock, 30, () => {
      dirs.add(ana.dir);
      return false;
    });
    // pelo menos um giro completo na cadeira
    expect(dirs.size).toBe(4);
    expect(ana.dir).toBe(home.dir);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(12 * MIN + (clock.now - T0))] })], 2), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('cobweb');
    let yawned = false;
    run(sim, clock, 40, () => {
      if (ana.chatEmoji === '🥱' && ana.pose === 'sleep') yawned = true;
      return yawned;
    });
    expect(yawned).toBe(true);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(26 * MIN + (clock.now - T0))] })], 3), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('nap');
    expect(ana.pose).toBe('sleep');
  });

  it('passeando quando o shell começa: volta para a mesa (sai da cabine normalmente)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'idle')]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot && !!ana.step && ana.step.t !== 'exit');
    expect(ana.atSpot === ana.homeSpot).toBe(false);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(1000)] })], 2), clock.now);
    expect(ana.mode).toBe('shell');
    let ran = false;
    run(sim, clock, 60, () => {
      if (ana.pose === 'run') ran = true;
      return ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length;
    });
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ran).toBe(false);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('wait');
  });

  it('comando longo em primeiro plano: digitando nos primeiros 10 s, depois a mesma espera', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const fg = shell(0, { id: 'toolu_1', background: false });
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { shells: [fg] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 5);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
    run(sim, clock, 7);
    expect(ana.mode).toBe('shell');
    expect(ana.pose).toBe('wait');
    expect(ana.atSpot).toBe(ana.homeSpot);
    // o comando terminou (tool_result): volta a digitar
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { shells: [] })], 2), clock.now);
    run(sim, clock, 0.2);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it('shell concluído: levanta, comemora com ⭐ e confete e volta a trabalhar', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { shells: [shell(2 * MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Rodando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    // a notificação chega e o agente já volta a trabalhar no mesmo snapshot
    sim.applySnapshot(snap(rooms, [{ ...base, status: 'working', shells: [], activity: done('a1') }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.some((e) => e.kind === 'confetti' && e.charId === 'ana')).toBe(true);
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('stretch')).toBe(true);
    run(sim, clock, 5, () => ana.atSpot === ana.homeSpot && ana.pose === 'type');
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it('fim de shell antigo não comemora na carga; um novo atrás de outra atividade comemora', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const old = done('old')!;
    const base = agent('ana', '/a', 'working', { recent: [old], activity: { id: 'a0', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBeNull();
    expect(sim.effects.length).toBe(0);
    const fresh = { ...done('new')!, at: T0 + 400 };
    const later = { id: 'a2', kind: 'read' as const, icon: '📖', text: 'Lendo a saída', at: T0 + 450 };
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.length).toBe(1);
    // o mesmo snapshot de novo não comemora outra vez
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 3), clock.now);
    expect(sim.effects.length).toBe(1);
  });

  it('shell falhou: nuvenzinha de chuva, cabeça baixa por ~4 s, sem confete', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { shells: [shell(2 * MIN), shell(MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Rodando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    sim.effects.length = 0;
    // um dos dois falhou; o outro continua rodando
    sim.applySnapshot(snap(rooms, [{ ...base, shells: [shell(MIN)], activity: done('a1', true) }], 2), clock.now);
    expect(ana.icon).toBe('storm');
    expect(sim.effects.length).toBe(0);
    run(sim, clock, 1);
    expect(ana.pose).toBe('sleep');
    expect(ana.atSpot).toBe(ana.homeSpot);
    run(sim, clock, 4);
    expect(ana.icon).toBeNull();
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.pose).toBe('wait');
  });
});

describe('a sala do dono mora ao lado do lounge, com a sala de reunião de cenário em frente', () => {
  const dono = (slot: number): RoomInfo => ({ ...room('/dono', slot), office: true, team: true, style: { layout: 'individual' } });
  const vaga = (sim: Sim, id: string) => sim.rooms.get(id)?.slot;
  const REUNIAO = `/dono${MEETING_SUFFIX}`;

  it('na carga, a sala do dono fica ao lado do lounge, a de reunião em frente, e as outras pulam as duas vagas', () => {
    const sim = newSim();
    // O dono chegou por último (slot 2 do servidor): mesmo assim a vaga 1 é dele.
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1), dono(2), room('/c', 3)], []), T0);
    expect([OWNER_SLOT, MEETING_SLOT]).toEqual([1, 0]);
    expect(vaga(sim, '/dono')).toBe(OWNER_SLOT);
    expect(vaga(sim, REUNIAO)).toBe(MEETING_SLOT);
    expect([vaga(sim, '/a'), vaga(sim, '/b'), vaga(sim, '/c')]).toEqual([2, 3, 4]);
    // A próxima sala comum vai para a primeira vaga livre que não é nenhuma das duas.
    expect(sim.freeSlot()).toBe(5);
    // A sala de reunião é só cenário: mesa de conferência, acesa, sem ninguém, e fora da lista do servidor.
    const reuniao = sim.rooms.get(REUNIAO)!;
    expect(reuniao.info).toMatchObject({ decor: true, name: 'Sala de reunião', style: { layout: 'conferencia' } });
    expect(reuniao.layout.furniture.some((f) => f.kind === 'conference_table')).toBe(true);
    expect(reuniao.lightOn).toBe(true);
    expect(sim.occupants(reuniao)).toBe(0);
  });

  it('só a sala do dono no prédio: as duas ficam no lugar, e ninguém as tira de lá', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([dono(0)], []), T0);
    expect(vaga(sim, '/dono')).toBe(OWNER_SLOT);
    expect(vaga(sim, REUNIAO)).toBe(MEETING_SLOT);
    expect(sim.freeSlot()).toBe(2);
    run(sim, clock, 60);
    expect(vaga(sim, '/dono')).toBe(OWNER_SLOT);
    expect(vaga(sim, REUNIAO)).toBe(MEETING_SLOT);
    expect(sim.rooms.get(REUNIAO)!.lightOn).toBe(true);
  });

  it('sem sala do dono, nada muda: as salas ocupam as vagas na ordem de chegada, e não há sala de reunião', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1), room('/c', 2)], []), T0);
    expect([vaga(sim, '/a'), vaga(sim, '/b'), vaga(sim, '/c')]).toEqual([0, 1, 2]);
    expect(sim.freeSlot()).toBe(3);
    expect(sim.rooms.size).toBe(3);
  });

  it('a sala do dono criada com o escritório aberto: quem estava nas duas vagas sai, e as duas salas se mudam para lá', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], []), T0);
    expect([vaga(sim, '/a'), vaga(sim, '/b')]).toEqual([0, 1]);
    // A sala do dono aparece depois (a pessoa instalou a equipe): as vagas estão ocupadas, as duas entram nas seguintes.
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1), dono(2)], [], 2), clock.now);
    expect(vaga(sim, '/dono')).not.toBe(OWNER_SLOT);
    run(sim, clock, 480, () => vaga(sim, '/dono') === OWNER_SLOT && vaga(sim, REUNIAO) === MEETING_SLOT);
    expect(vaga(sim, '/dono')).toBe(OWNER_SLOT);
    expect(vaga(sim, REUNIAO)).toBe(MEETING_SLOT);
    expect([OWNER_SLOT, MEETING_SLOT]).not.toContain(vaga(sim, '/a'));
    expect([OWNER_SLOT, MEETING_SLOT]).not.toContain(vaga(sim, '/b'));
    // Depois da mudança, a sala de reunião continua acesa.
    run(sim, clock, 10);
    expect(sim.rooms.get(REUNIAO)!.lightOn).toBe(true);
  });

  it('a sala do dono some (a equipe foi desinstalada): a sala de reunião sai junto', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), dono(1)], []), T0);
    expect(sim.rooms.has(REUNIAO)).toBe(true);
    sim.applySnapshot(snap([room('/a', 0)], [], 2), clock.now);
    run(sim, clock, 60, () => !sim.rooms.has(REUNIAO) && !sim.rooms.has('/dono'));
    expect(sim.rooms.has(REUNIAO)).toBe(false);
  });
});

describe('aparência da sala na simulação', () => {
  it('trocar o layout, o estilo ou a cor refaz a sala no lugar, e quem estava sentado senta de novo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const r = room('/a', 0);
    sim.applySnapshot(snap([r], [agent('ana', '/a', 'working')]), T0);
    run(sim, clock, 5);
    const sala = sim.rooms.get('/a')!;
    expect(sala.layout.spots.filter((s) => s.kind === 'desk')).toHaveLength(6);
    expect(sala.theme.floor).toBeUndefined();
    const versao = sala.version;
    sim.applySnapshot(snap([{ ...r, style: { layout: 'individual', look: 'moderno', color: '#12ab9c' } }], [agent('ana', '/a', 'working')], 2), clock.now);
    expect(sala.version).toBeGreaterThan(versao);
    expect(sala.layout.spots.filter((s) => s.kind === 'desk')).toHaveLength(1);
    expect(sala.theme).toMatchObject({ floor: 'concrete', accent: '#12ab9c', deskVariant: 'white' });
    expect(sala.slot).toBe(0);
    // A Ana volta a ter lugar na sala nova e senta.
    run(sim, clock, 40, () => !!sim.chars.get('ana')?.seated);
    const ana = sim.chars.get('ana')!;
    expect(ana.homeSpot && sala.layout.spots.some((s) => s.id === ana.homeSpot)).toBe(true);
    expect(ana.seated).toBe(true);
    // A mesma aparência de novo não refaz nada.
    const depois = sala.version;
    sim.applySnapshot(snap([{ ...r, style: { layout: 'individual', look: 'moderno', color: '#12ab9c' } }], [agent('ana', '/a', 'working')], 3), clock.now);
    expect(sala.version).toBe(depois);
  });

  it('o estilo geral do escritório vale nas salas sem estilo próprio e nas áreas comuns, e muda ao vivo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const com = (estilo: string | undefined, rev: number) => {
      const s = snap([room('/a', 0), { ...room('/b', 1), style: { look: 'vidro' } }], [], rev);
      return { ...s, meta: { ...s.meta, officeStyle: estilo } } as OfficeSnapshot;
    };
    sim.applySnapshot(com(undefined, 1), T0);
    const a = sim.rooms.get('/a')!;
    const b = sim.rooms.get('/b')!;
    expect(a.theme.floor).toBeUndefined();
    expect(b.theme.wall.pattern).toBe('glass');
    const recepcao = sim.building.core[0];
    const [va, vb] = [a.version, b.version];
    sim.applySnapshot(com('corporativo', 2), clock.now);
    // A sala sem estilo próprio vira corporativa (formal: sem banquetas); a que escolheu "Vidro" fica como está.
    expect(a.theme).toMatchObject({ floor: 'carpet', formal: true });
    expect(a.version).toBeGreaterThan(va);
    expect(a.layout.furniture.some((f) => f.kind === 'stool' || f.kind === 'beanbag')).toBe(false);
    expect(b.theme.wall.pattern).toBe('glass');
    expect(b.version).toBe(vb);
    // As áreas comuns foram refeitas no estilo.
    expect(sim.building.core[0]).not.toBe(recepcao);
    expect(sim.building.core[0].id).toBe(recepcao.id);
    // De volta ao clássico: tudo como era.
    sim.applySnapshot(com('classico', 3), clock.now);
    expect(a.theme.floor).toBeUndefined();
    expect(sim.building.core[0]).toBe(recepcao);
    // Valor estranho vindo do servidor é tratado como clássico.
    sim.applySnapshot(com('rococó', 4), clock.now);
    expect(a.theme.floor).toBeUndefined();
  });
});

describe('reunião: demanda entre salas leva os envolvidos para a sala de reunião', () => {
  const dono = (slot: number): RoomInfo => ({ ...room('/dono', slot), office: true, team: true, style: { layout: 'individual' } });
  const REUNIAO = `/dono${MEETING_SUFFIX}`;
  const salas = [room('/mkt', 0), room('/dir', 1), dono(2)];
  const dentro = (sim: Sim, id: string, sala: string) => {
    const ch = sim.chars.get(id)!;
    const r = sim.rooms.get(sala)!.layout.rect;
    return ch.tx >= r.x && ch.tx < r.x + r.w && ch.ty >= r.y && ch.ty < r.y + r.h;
  };

  it('quem entra na reunião vai sentar na sala de reunião; quando a demanda termina, volta para a sala dele', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const gente = (reuniao: boolean) => [
      agent('ana', '/mkt', 'working', { staff: 'copywriter', meeting: reuniao || undefined }),
      agent('bia', '/dir', 'idle', { staff: 'cmo', parked: true, meeting: reuniao || undefined }),
      agent('caio', '/mkt', 'working', { staff: 'designer' }),
    ];
    sim.applySnapshot(snap(salas, gente(false)), T0);
    run(sim, clock, 5);
    expect(sim.chars.get('ana')!.roomId).toBe('/mkt');
    expect(sim.inMeeting(sim.chars.get('ana')!)).toBe(false);
    // A demanda passou a envolver as duas salas.
    sim.applySnapshot(snap(salas, gente(true), 2), clock.now);
    expect(sim.chars.get('ana')!.roomId).toBe(REUNIAO);
    expect(sim.chars.get('bia')!.roomId).toBe(REUNIAO);
    expect(sim.chars.get('caio')!.roomId).toBe('/mkt');
    run(sim, clock, 90, () => !!sim.chars.get('ana')!.seated && !!sim.chars.get('bia')!.seated && dentro(sim, 'ana', REUNIAO) && dentro(sim, 'bia', REUNIAO));
    for (const id of ['ana', 'bia']) {
      const ch = sim.chars.get(id)!;
      expect(dentro(sim, id, REUNIAO), id).toBe(true);
      expect(ch.seated, id).toBe(true);
      expect(sim.rooms.get(REUNIAO)!.layout.spots.some((s) => s.id === ch.homeSpot), id).toBe(true);
      expect(sim.inMeeting(ch), id).toBe(true);
    }
    expect(dentro(sim, 'caio', '/mkt')).toBe(true);
    // Acabou: cada um volta para a sua sala, e a sala de reunião continua acesa.
    sim.applySnapshot(snap(salas, gente(false), 3), clock.now);
    expect(sim.chars.get('ana')!.roomId).toBe('/mkt');
    expect(sim.chars.get('bia')!.roomId).toBe('/dir');
    run(sim, clock, 90, () => dentro(sim, 'ana', '/mkt') && dentro(sim, 'bia', '/dir') && !!sim.chars.get('ana')!.seated);
    expect(dentro(sim, 'ana', '/mkt')).toBe(true);
    expect(dentro(sim, 'bia', '/dir')).toBe(true);
    run(sim, clock, 20);
    expect(sim.rooms.get(REUNIAO)!.lightOn).toBe(true);
  });

  it('em reunião, o ocioso só sai para a água ou o banheiro, não entra em roda, e volta para a sala de reunião', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }));
    const clock = { now: T0 };
    const gente = [agent('bia', '/dir', 'idle', { staff: 'cmo', parked: true, meeting: true }), agent('davi', '/dir', 'idle', { staff: 'cto', parked: true, meeting: true })];
    sim.applySnapshot(snap(salas, gente), T0);
    // Todos começam sentados na sala de reunião.
    for (const ch of sim.chars.values()) expect(dentro(sim, ch.id, REUNIAO), ch.id).toBe(true);
    const usados = new Set<string>();
    let proibido = '';
    let saidas = 0;
    const fora = new Map<string, boolean>();
    // Vinte minutos de escritório agitado: fora da sala de reunião, só param no bebedouro e no banheiro; nunca em roda.
    for (let i = 0; i < 1200 * 30 && !proibido; i++) {
      clock.now += 1000 / 30;
      sim.update(1 / 30, clock.now);
      for (const ch of sim.chars.values()) {
        if (ch.gathering) proibido = `${ch.id} entrou numa roda`;
        const saiu = !dentro(sim, ch.id, REUNIAO);
        if (saiu && !fora.get(ch.id)) saidas++;
        fora.set(ch.id, saiu);
        const lugar = ch.atSpot ? sim.building.spots.find((sp) => sp.id === ch.atSpot) : undefined;
        if (!lugar || lugar.areaId === REUNIAO) continue;
        usados.add(lugar.kind);
        if (!['water', 'stall', 'sink'].includes(lugar.kind)) proibido = `${ch.id} parou em ${lugar.kind} (${lugar.areaId})`;
      }
    }
    expect(proibido).toBe('');
    // Saíram de verdade (água ou banheiro) e voltaram: a sala deles continua sendo a de reunião.
    expect(saidas).toBeGreaterThan(0);
    expect([...usados].every((k) => k === 'water' || k === 'stall' || k === 'sink')).toBe(true);
    for (const ch of sim.chars.values()) expect(ch.roomId).toBe(REUNIAO);
    run(sim, clock, 120, () => [...sim.chars.values()].every((ch) => dentro(sim, ch.id, REUNIAO) && ch.seated));
    for (const ch of sim.chars.values()) expect(dentro(sim, ch.id, REUNIAO), ch.id).toBe(true);
  });

  it('em reunião, o ocioso passa quase o tempo todo sentado na sala de reunião (as saídas são raras)', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'lively' }));
    const clock = { now: T0 };
    const gente = [agent('bia', '/dir', 'idle', { staff: 'cmo', parked: true, meeting: true }), agent('davi', '/dir', 'idle', { staff: 'cto', parked: true, meeting: true })];
    sim.applySnapshot(snap(salas, gente), T0);
    let sentados = 0;
    let total = 0;
    for (let i = 0; i < 1200 * 30; i++) {
      clock.now += 1000 / 30;
      sim.update(1 / 30, clock.now);
      for (const ch of sim.chars.values()) {
        total++;
        if (ch.seated && dentro(sim, ch.id, REUNIAO)) sentados++;
      }
    }
    expect(sentados / total).toBeGreaterThan(0.75);
  });

  it('sem sala de reunião no escritório (não há sala do dono), quem está em reunião fica na sala dele', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('/mkt', 0), room('/dir', 1)], [agent('ana', '/mkt', 'working', { staff: 'copywriter', meeting: true })]), T0);
    expect(sim.chars.get('ana')!.roomId).toBe('/mkt');
    expect(sim.inMeeting(sim.chars.get('ana')!)).toBe(false);
  });
});

describe('mesas livres da sala (o "+" de criar agente)', () => {
  it('lista as mesas sem dono na ordem em que seriam ocupadas; quem chega tira a dele da lista', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const diretoria: RoomInfo = { ...room('/dir', 0), team: true, style: { layout: 'diretoria' }, maxAgents: 4 };
    const equipe: RoomInfo = { ...room('/mkt', 1), team: true, style: { layout: 'equipe' }, maxAgents: 12 };
    sim.applySnapshot(snap([diretoria, equipe], [agent('cmo', '/dir', 'idle', { staff: 'cmo', parked: true })]), T0);
    run(sim, clock, 3);
    // Diretoria: quatro gabinetes, um ocupado. Equipe: doze mesas, todas livres.
    const livres = sim.freeDesks('/dir');
    expect(livres).toHaveLength(3);
    expect(livres.every((s) => s.kind === 'desk')).toBe(true);
    expect(livres.map((s) => s.rank)).toEqual([...livres.map((s) => s.rank)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(livres.some((s) => s.id === sim.chars.get('cmo')!.homeSpot)).toBe(false);
    expect(sim.freeDesks('/mkt')).toHaveLength(12);
    expect(sim.freeDesks('/nao-existe')).toEqual([]);
    // Chegou mais um diretor: sobram dois gabinetes.
    sim.applySnapshot(snap([diretoria, equipe], [agent('cmo', '/dir', 'idle', { staff: 'cmo', parked: true }), agent('cto', '/dir', 'idle', { staff: 'cto', parked: true })], 2), clock.now);
    run(sim, clock, 3);
    expect(sim.freeDesks('/dir')).toHaveLength(2);
  });
});

describe('mesas marcadas (a pessoa organiza quem senta onde)', () => {
  const dir = (seats?: Record<string, number>): RoomInfo => ({ ...room('/dir', 0), team: true, style: { layout: 'diretoria', ...(seats ? { seats } : {}) }, maxAgents: 4 });
  const gente = () => [agent('cmo', '/dir', 'idle', { staff: 'cmo', parked: true }), agent('cto', '/dir', 'idle', { staff: 'cto', parked: true })];
  /** Em que mesa (número) cada agente fixo está, pelo mapa das mesas. */
  const mapa = (sim: Sim) => Object.fromEntries(sim.deskMap('/dir').filter((m) => m.staff).map((m) => [m.staff!, m.n]));
  const sentadoNaDele = (sim: Sim, id: string) => {
    const ch = sim.chars.get(id)!;
    return !!ch.seated && ch.atSpot === ch.homeSpot;
  };

  it('as mesas são numeradas como se lê, e o mapa diz onde cada uma fica e de quem é', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    sim.applySnapshot(snap([dir()], gente()), T0);
    const mesas = sim.deskMap('/dir');
    expect(mesas.map((m) => m.n)).toEqual([1, 2, 3, 4]);
    // 1 e 2 em cima (esquerda e direita), 3 e 4 embaixo; tudo dentro da sala.
    expect(mesas[0].y).toBe(mesas[1].y);
    expect(mesas[2].y).toBe(mesas[3].y);
    expect(mesas[0].y).toBeLessThan(mesas[2].y);
    expect(mesas[0].x).toBeLessThan(mesas[1].x);
    for (const m of mesas) expect(m.x > 0 && m.x < 1 && m.y > 0 && m.y < 1, `mesa ${m.n}`).toBe(true);
    // Sem nada marcado, o mapa mostra onde cada um sentou.
    expect(Object.keys(mapa(sim)).sort()).toEqual(['cmo', 'cto']);
    expect(sim.deskMap('/nao-existe')).toEqual([]);
  });

  it('marcou a mesa: o agente vai para ela; trocar dois de lugar funciona; quem estava na mesa de outro sai', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    sim.applySnapshot(snap([dir()], gente()), T0);
    run(sim, clock, 3);
    const antes = mapa(sim);
    // Os dois trocam de mesa.
    const troca = { cmo: antes.cto, cto: antes.cmo };
    sim.applySnapshot(snap([dir(troca)], gente(), 2), clock.now);
    run(sim, clock, 60, () => sentadoNaDele(sim, 'cmo') && sentadoNaDele(sim, 'cto'));
    expect(mapa(sim)).toEqual(troca);
    const lugares = sim.deskMap('/dir');
    for (const id of ['cmo', 'cto']) {
      expect(sentadoNaDele(sim, id), id).toBe(true);
      // ...e a mesa em que ele está é a do número marcado
      const ch = sim.chars.get(id)!;
      const n = lugares.find((m) => m.staff === id)!.n;
      expect(sim.rooms.get('/dir')!.layout.spots.filter((s) => s.kind === 'desk').sort((a, b) => a.ty - b.ty || a.tx - b.tx)[n - 1].id, id).toBe(ch.homeSpot);
    }
    // Só o CTO marcado, na mesa em que o CMO está: o CMO levanta e acha outra, que não é a 4.
    sim.applySnapshot(snap([dir({ cto: troca.cmo })], gente(), 3), clock.now);
    run(sim, clock, 60, () => sentadoNaDele(sim, 'cmo') && sentadoNaDele(sim, 'cto'));
    expect(mapa(sim).cto).toBe(troca.cmo);
    expect(mapa(sim).cmo).not.toBe(troca.cmo);
    expect(sentadoNaDele(sim, 'cmo')).toBe(true);
    // A mesa marcada não aparece como livre, e o "+" vai para as outras duas.
    expect(sim.freeDesks('/dir')).toHaveLength(2);
  });

  it('mesa marcada fica guardada para o dono dela: quem chega depois não senta ali; mesa que o layout não tem é ignorada', () => {
    const sim = new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    // A mesa 1 (a primeira que qualquer um pegaria... ou não) é do CTO, que ainda não chegou; a 9 não existe.
    sim.applySnapshot(snap([dir({ cto: 1, cfo: 9 })], [agent('cmo', '/dir', 'idle', { staff: 'cmo', parked: true }), agent('cfo', '/dir', 'idle', { staff: 'cfo', parked: true })]), T0);
    run(sim, clock, 3);
    const m = sim.deskMap('/dir');
    expect(m[0].staff).toBe('cto');
    expect(m.filter((x) => x.staff === 'cmo' || x.staff === 'cfo').map((x) => x.n).sort()).not.toContain(1);
    expect(m.filter((x) => x.staff).length).toBe(3);
    expect(sim.freeDesks('/dir')).toHaveLength(1);
  });
});

