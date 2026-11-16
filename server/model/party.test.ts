// Festa no escritório no modelo: começa, sai no snapshot (sem mexer nos agentes), acaba sozinha ou antes da hora.
import { describe, expect, it } from 'vitest';
import { NameStore } from './names';
import { Office } from './office';

function makeOffice() {
  let clock = 1_000_000;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: clock,
    accounts: (s) => [{ id: 'acc', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '/x', sessions: s.get('acc') ?? 0, usageStatus: 'disabled' }],
    sources: () => [],
    accountName: () => 'Conta C',
    now: () => clock,
  });
  const main = (id: string, cwd: string, status: 'working' | 'idle' | 'waiting' = 'working') =>
    office.addMain({ id, account: 'acc', sessionId: `s-${id}`, cwd, role: 'Agente principal', startedAt: clock, status });
  return { office, main, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe('Office: festa no escritório', () => {
  it('sem sala pedida, vai para a sala com mais agentes; o snapshot leva a festa e os agentes não mudam', () => {
    const { office, main, now } = makeOffice();
    main('acc:1', '/p/loja');
    main('acc:2', '/p/site');
    main('acc:3', '/p/site', 'idle');
    const before = office.commit().snapshot;
    const r = office.startParty({ ms: 120_000 });
    expect(r).toEqual({ party: { roomId: '/p/site', at: now(), until: now() + 120_000 }, roomName: 'site' });
    const { snapshot, notices } = office.commit();
    expect(snapshot.party).toEqual({ roomId: '/p/site', at: now(), until: now() + 120_000 });
    expect(notices.map((n) => n.text)).toEqual(['🎉 Festa no escritório em site!']);
    // só visual: cada agente continua na sala dele, com o mesmo status
    expect(snapshot.agents.map((a) => [a.id, a.roomId, a.status])).toEqual(before.agents.map((a) => [a.id, a.roomId, a.status]));
    expect(snapshot.rooms).toEqual(before.rooms);
  });

  it('sala pedida pelo nome; desconhecida ou escritório vazio é erro (e nada muda)', () => {
    const { office, main } = makeOffice();
    expect(office.startParty({ ms: 60_000 })).toEqual({ error: 'empty' });
    main('acc:1', '/p/loja');
    main('acc:2', '/p/site');
    main('acc:3', '/p/site');
    expect(office.startParty({ room: 'LOJA', ms: 60_000 })).toMatchObject({ party: { roomId: '/p/loja' } });
    expect(office.startParty({ room: 'cozinha', ms: 60_000 })).toEqual({ error: 'unknown' });
    expect(office.commit().snapshot.party?.roomId).toBe('/p/loja');
  });

  it('acaba sozinha no fim, ou antes com endParty', () => {
    const { office, main, advance } = makeOffice();
    main('acc:1', '/p/loja');
    office.startParty({ ms: 30_000 });
    advance(29_000);
    office.tick();
    expect(office.commit().snapshot.party).toBeDefined();
    advance(1_000);
    office.tick();
    expect(office.commit().snapshot.party).toBeUndefined();
    expect(office.endParty()).toBe(false);

    office.startParty({ ms: 30_000 });
    expect(office.commit().snapshot.party).toBeDefined();
    expect(office.endParty()).toBe(true);
    expect(office.commit().snapshot.party).toBeUndefined();
  });

  it('outra festa recomeça (outro `at`); a sala anfitriã fechou, a festa acaba', () => {
    const { office, main, advance } = makeOffice();
    main('acc:1', '/p/loja');
    main('acc:2', '/p/site');
    const first = office.startParty({ room: 'site', ms: 60_000 });
    advance(5_000);
    const second = office.startParty({ room: 'site', ms: 60_000 });
    expect('party' in second && 'party' in first && second.party.at > first.party.at).toBe(true);
    office.closeMain('acc:2');
    // período de graça do agente e a sala sumindo do escritório
    for (let i = 0; i < 400 && office.commit().snapshot.rooms.some((r) => r.id === '/p/site'); i++) {
      advance(1_000);
      office.tick();
    }
    office.tick();
    expect(office.commit().snapshot.party).toBeUndefined();
  });
});
