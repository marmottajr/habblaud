import { describe, expect, it } from 'vitest';
import type { AgentInfo, RecentSession } from '../../../shared/types';
import { agentSession, FAVORITES_KEY, FavoritesStore, MAX_FAVORITES, parseFavorites, sessionKey, splitFavorites, toggleFavorite, type StorageLike } from './favorites';

function session(p: Partial<RecentSession> & Pick<RecentSession, 'sessionId' | 'lastAt'>): RecentSession {
  return { account: '.claude', projectDir: '-p', size: 1_000, open: false, ...p };
}

describe('favoritas', () => {
  it('parseFavorites ignora lixo e duplicados', () => {
    const a = session({ sessionId: 'a', lastAt: 1 });
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites('x')).toEqual([]);
    expect(parseFavorites([null, 'x', { account: '.claude', lastAt: 1 }, a, a]).map(sessionKey)).toEqual(['.claude:a']);
  });

  it('splitFavorites: versão do servidor vence, retrato antigo fica encerrado, favoritas saem de rest', () => {
    const savedA = session({ sessionId: 'a', lastAt: 1, title: 'velho' });
    const savedOld = session({ sessionId: 'old', lastAt: 5, title: 'antiga' });
    const serverA = session({ sessionId: 'a', lastAt: 9, title: 'novo', open: true, agentId: 'ag' });
    const other = session({ sessionId: 'b', lastAt: 3 });
    const { favorites, rest, updated } = splitFavorites([savedA, savedOld], [other, serverA]);
    expect(favorites.map((s) => [s.sessionId, s.title, s.open, s.agentId])).toEqual([
      ['a', 'novo', true, 'ag'],
      ['old', 'antiga', false, undefined],
    ]);
    expect(rest.map((s) => s.sessionId)).toEqual(['b']);
    expect(updated.map((s) => [s.sessionId, s.title, s.open, s.agentId, s.lastAt])).toEqual([
      ['a', 'novo', false, undefined, 9],
      ['old', 'antiga', false, undefined, 5],
    ]);
  });

  it('toggleFavorite adiciona, remove e respeita MAX_FAVORITES', () => {
    const s = session({ sessionId: 'a', lastAt: 1, open: true, agentId: 'ag' });
    const added = toggleFavorite([], s);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sessionId: 'a', open: false });
    expect(added[0]?.agentId).toBeUndefined();
    expect(toggleFavorite(added, s)).toEqual([]);

    const many = Array.from({ length: MAX_FAVORITES }, (_, i) => session({ sessionId: `s${i}`, lastAt: 100 + i }));
    const capped = toggleFavorite(many, session({ sessionId: 'novo', lastAt: 1000 }));
    expect(capped).toHaveLength(MAX_FAVORITES);
    expect(capped.some((x) => x.sessionId === 'novo')).toBe(true);
    expect(capped.some((x) => x.sessionId === 's0')).toBe(false);
  });
});

describe('agentSession (estrela da gaveta)', () => {
  const agent = (p: Partial<AgentInfo> = {}) =>
    ({ id: '.claude:1', kind: 'main', account: '.claude', sessionId: 's1', title: 'Meu título', startedAt: 100, lastEventAt: 500, ...p }) as AgentInfo;
  const room = { path: '/home/u/meu projeto' };

  it('monta o retrato como o histórico do servidor', () => {
    expect(agentSession(agent(), room, false)).toEqual({
      account: '.claude',
      sessionId: 's1',
      projectDir: '-home-u-meu-projeto',
      project: '/home/u/meu projeto',
      title: 'Meu título',
      firstAt: 100,
      lastAt: 500,
      size: 0,
      open: false,
    });
    expect(sessionKey(agentSession(agent(), room, false)!)).toBe('.claude:s1');
  });

  it('provider codex vai no retrato; claude fica sem; sem sala nem título, só o essencial', () => {
    expect(agentSession(agent({ provider: 'codex', account: '.codex' }), room, false)?.provider).toBe('codex');
    expect(agentSession(agent({ provider: 'claude' }), room, false)?.provider).toBeUndefined();
    const bare = agentSession(agent({ title: undefined, lastEventAt: 0 }), undefined, false)!;
    expect(bare).toMatchObject({ projectDir: '', lastAt: 100 });
    expect(bare.project).toBeUndefined();
    expect(bare.title).toBeUndefined();
  });

  it('sem estrela para subagente e para o demo', () => {
    expect(agentSession(agent({ kind: 'sub' }), room, false)).toBeNull();
    expect(agentSession(agent(), room, true)).toBeNull();
  });
});

describe('FavoritesStore', () => {
  function memory(initial?: string): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>(initial === undefined ? [] : [[FAVORITES_KEY, initial]]);
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it('carrega o salvo, liga/desliga, grava e avisa os assinantes', () => {
    const mem = memory(JSON.stringify([session({ sessionId: 'a', lastAt: 1 })]));
    const store = new FavoritesStore(() => mem);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    expect(store.has('.claude:a')).toBe(true);

    store.toggle(session({ sessionId: 'b', lastAt: 2 }));
    expect(calls).toBe(1);
    expect(store.has('.claude:b')).toBe(true);
    expect(parseFavorites(JSON.parse(mem.data.get(FAVORITES_KEY)!)).map(sessionKey)).toEqual(['.claude:b', '.claude:a']);

    store.toggle(session({ sessionId: 'a', lastAt: 1 }));
    expect(calls).toBe(2);
    expect(store.has('.claude:a')).toBe(false);

    off();
    store.toggle(session({ sessionId: 'c', lastAt: 3 }));
    expect(calls).toBe(2);
  });

  it('replace grava sem avisar; sem armazenamento ou com JSON ruim, funciona só em memória', () => {
    const mem = memory();
    const store = new FavoritesStore(() => mem);
    let calls = 0;
    store.subscribe(() => calls++);
    store.replace([session({ sessionId: 'x', lastAt: 1 })]);
    expect(calls).toBe(0);
    expect(mem.data.get(FAVORITES_KEY)).toContain('"x"');

    const broken = new FavoritesStore(() => memory('{não é json'));
    expect(broken.all()).toEqual([]);
    const none = new FavoritesStore(() => undefined);
    none.toggle(session({ sessionId: 'y', lastAt: 1 }));
    expect(none.has('.claude:y')).toBe(true);
  });
});
