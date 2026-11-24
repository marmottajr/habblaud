import { describe, expect, it } from 'vitest';
import { isScratchWorkspace } from '../model/rooms';
import { foreignPid, parseRegistryEntry } from './registry';

describe('sala de pasta temporária do app desktop', () => {
  it('reconhece só a pasta scratch do app', () => {
    expect(isScratchWorkspace('C:\\Users\\x\\AppData\\Local\\Claude-Data\\c\\scratch-workspaces\\a\\b\\scratch-2026-11-24-5ea583')).toBe(true);
    expect(isScratchWorkspace('/home/x/scratch-2026-11-24-5ea583')).toBe(false);
    expect(isScratchWorkspace('C:\\Users\\x\\Documents\\GitHub\\landings_nosse')).toBe(false);
  });
});
import { planToTasks, wrapUpTasks } from './transcript';

describe('sessões do app desktop vistas do WSL', () => {
  it('PID de outro sistema não é confirmado', () => {
    const e = parseRegistryEntry(JSON.stringify({ pid: 14408, sessionId: 's', cwd: 'C:\\x', pidDomain: 'win32:pc001' }))!;
    expect(e.pidDomain).toBe('win32:pc001');
    expect(foreignPid(e, 'linux')).toBe(true);
    expect(foreignPid(e, 'win32')).toBe(false);
    expect(foreignPid({ pid: 1, sessionId: 's', cwd: '/' }, 'linux')).toBe(false);
  });
});

describe('update_plan do app desktop', () => {
  const items = { items: [
    { content: 'a', status: 'in_progress' },
    { content: 'b', status: 'pending' },
    { content: 'c', status: 'pending' },
  ] };

  it('items substitui a lista com ids por posição', () => {
    expect(planToTasks([], items).map((t) => [t.id, t.title, t.status])).toEqual([
      ['1', 'a', 'in_progress'], ['2', 'b', 'pending'], ['3', 'c', 'pending'],
    ]);
  });

  it('advance, done/start e wrap_up', () => {
    let t = planToTasks([], items);
    t = planToTasks(t, { advance: true });
    expect(t.map((x) => x.status)).toEqual(['completed', 'in_progress', 'pending']);
    t = planToTasks(t, { done: [2], start: 3 });
    expect(t.map((x) => x.status)).toEqual(['completed', 'completed', 'in_progress']);
    expect(wrapUpTasks(t).every((x) => x.status === 'completed')).toBe(true);
  });
});
