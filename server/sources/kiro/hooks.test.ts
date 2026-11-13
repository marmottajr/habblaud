import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountsService } from '../../accounts/service';
import { parseKiroEvent } from '../../kiro/http';
import { Office } from '../../model/office';
import { NameStore } from '../../model/names';
import { HOOK_IDLE_MS, HOOK_WORKING_MS, hookToolFailed, KiroHookSessions } from './hooks';
import type { KiroHookEvent, KiroHookPayload } from './live';
import { KiroSource, sameKiroHome } from './source';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function office(now: () => number): Office {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-hooks-'));
  dirs.push(dir);
  const names = new NameStore(join(dir, 'names.json'));
  names.load();
  return new Office({ names, version: 't', startedAt: now(), accounts: () => [], sources: () => [], accountName: () => 'Kiro', now });
}

const ev = (hook_event_name: KiroHookPayload['hook_event_name'], extra: Partial<KiroHookPayload> = {}, pids: number[] = []): KiroHookEvent => ({
  pids,
  kiroHome: 'C:\\Users\\ana\\.kiro',
  event: { hook_event_name, session_id: 'sess_abc', cwd: 'C:\\proj\\app', ...extra },
});

describe('parseKiroEvent', () => {
  it('aceita 2.x (camelCase) e 3.x; recusa sem evento conhecido ou sem session_id', () => {
    const p = parseKiroEvent({ kiroHome: '/h/.kiro', pids: [10, 'x', 1, 20], event: { hook_event_name: 'preToolUse', session_id: 'abc-1', tool_name: 'write', tool_input: { path: '/a' } } });
    expect(p).toEqual({ kiroHome: '/h/.kiro', pids: [10, 20], event: { hook_event_name: 'PreToolUse', session_id: 'abc-1', tool_name: 'write', tool_input: { path: '/a' } } });
    expect(() => parseKiroEvent({ event: { hook_event_name: 'Outro', session_id: 'a' } })).toThrow();
    expect(() => parseKiroEvent({ event: { hook_event_name: 'Stop' } })).toThrow();
    expect(() => parseKiroEvent({ event: { hook_event_name: 'Stop', session_id: '../x y' } })).toThrow();
  });
});

describe('sameKiroHome', () => {
  it('Windows visto do WSL, Linux e Windows nativo', () => {
    expect(sameKiroHome('/mnt/c/Users/ana/.kiro', 'C:\\Users\\ana\\.kiro', { wsl: true, platform: 'linux' })).toBe(true);
    expect(sameKiroHome('/mnt/c/Users/ana/.kiro', 'C:\\Users\\ana\\.kiro', { wsl: false, platform: 'linux' })).toBe(false);
    expect(sameKiroHome('/home/ana/.kiro/', '/home/ana/.kiro', { wsl: false, platform: 'linux' })).toBe(true);
    expect(sameKiroHome('C:\\Users\\Ana\\.kiro', 'c:/users/ana/.kiro', { wsl: false, platform: 'win32' })).toBe(true);
  });
});

it('hookToolFailed', () => {
  expect(hookToolFailed({ error: 'boom' })).toBe(true);
  expect(hookToolFailed({ isError: true })).toBe(true);
  expect(hookToolFailed({ exit_status: 'exit status: 1' })).toBe(true);
  expect(hookToolFailed({ exit_status: 'exit status: 0' })).toBe(false);
  expect(hookToolFailed('<file>...</file>')).toBe(false);
  expect(hookToolFailed({ items: [] })).toBe(false);
});

describe('KiroHookSessions (sessão só do hook, ex.: Kiro CLI 3.x)', () => {
  it('pedido -> ferramenta -> fim, com título, contagem e "Concluiu"', () => {
    let now = 1_000_000;
    const o = office(() => now);
    const h = new KiroHookSessions({ office: o, now: () => now });
    expect(h.apply('.kiro-windows', ev('AgentSpawn'))).toBe(true);
    expect(o.get('sess_abc')).toMatchObject({ status: 'idle', account: '.kiro-windows', provider: 'kiro' });
    h.apply('.kiro-windows', ev('UserPromptSubmit', { prompt: '[AGENT SYSTEM PROMPT]\nx\n[END AGENT SYSTEM PROMPT]\n[REPLY FORMAT RULES]\n(regra)\nsuba o deploy' }));
    expect(o.get('sess_abc')).toMatchObject({ status: 'working', title: 'suba o deploy' });
    now += 1_000;
    h.apply('.kiro-windows', ev('PreToolUse', { tool_name: 'read_file', tool_input: { path: 'C:\\proj\\app\\deploy.yaml' } }));
    expect(o.get('sess_abc')?.activity).toMatchObject({ kind: 'read', text: 'Lendo deploy.yaml', tool: 'read_file' });
    h.apply('.kiro-windows', ev('PostToolUse', { tool_name: 'read_file', tool_response: '<file>...</file>' }));
    now += 4_000;
    h.apply('.kiro-windows', ev('Stop', { assistant_response: 'Feito.' }));
    const a = o.get('sess_abc')!;
    expect(a.status).toBe('idle');
    expect(a.stats.toolCalls).toBe(1);
    expect(a.recent.map((r) => r.kind)).toEqual(['prompt', 'read', 'respond', 'done']);
  });

  it('ferramenta que falhou vira erro; sem cwd não cria personagem', () => {
    const o = office(() => 1);
    const h = new KiroHookSessions({ office: o, now: () => 1 });
    expect(h.apply('.kiro', { pids: [], event: { hook_event_name: 'Stop', session_id: 'x' } })).toBe(false);
    h.apply('.kiro', ev('PostToolUse', { tool_name: 'execute_bash', tool_response: { exit_status: 'exit status: 2' } }));
    expect(o.get('sess_abc')?.activity?.kind).toBe('error');
  });

  it('com PIDs: sai quando o Kiro morre; sem PIDs: depois de muito tempo sem eventos', () => {
    let now = 0;
    const o = office(() => now);
    const live = new Set([500]);
    const h = new KiroHookSessions({ office: o, now: () => now, alive: (p) => live.has(p) });
    h.apply('.kiro', ev('UserPromptSubmit', { prompt: 'a' }, [500]));
    h.apply('.kiro', { ...ev('UserPromptSubmit', { prompt: 'b', session_id: 'sess_semPid' }) });
    now += HOOK_IDLE_MS + 1;
    h.sweep();
    expect(h.ids().sort()).toEqual(['sess_abc', 'sess_semPid']); // trabalhando: espera HOOK_WORKING_MS
    live.clear();
    h.sweep();
    expect(h.ids()).toEqual(['sess_semPid']);
    now += HOOK_WORKING_MS;
    h.sweep();
    expect(h.size()).toBe(0);
  });

  it('PIDs de outro sistema (Docker) não valem', () => {
    let now = 0;
    const o = office(() => now);
    const h = new KiroHookSessions({ office: o, now: () => now, alive: () => false, samePidSpace: false });
    h.apply('.kiro', ev('Stop', {}, [500]));
    h.sweep();
    expect(h.size()).toBe(1);
    now += HOOK_IDLE_MS + 1;
    h.sweep();
    expect(h.size()).toBe(0);
  });
});

describe('KiroSource.applyHookEvent', () => {
  function source(now: () => number) {
    const root = mkdtempSync(join(tmpdir(), 'kiro-src-'));
    dirs.push(root);
    const linux = join(root, 'home', '.kiro');
    const win = join(root, 'mnt', 'c', 'Users', 'ana', '.kiro');
    for (const d of [linux, win]) mkdirSync(join(d, 'sessions', 'cli'), { recursive: true });
    const o = office(now);
    const accounts = {
      setProviderAccounts: (_p: string, list: Array<{ dir: string; detected: { id: string } }>) => list.map((x) => ({ id: x.detected.id, provider: 'kiro', dir: x.dir, detected: x.detected })),
      entriesOf: () => [],
    } as unknown as AccountsService;
    const src = new KiroSource({
      accounts,
      office: o,
      dirs: [
        { dir: linux, sessionsDir: join(linux, 'sessions', 'cli') },
        { dir: win, sessionsDir: join(win, 'sessions', 'cli'), windows: true },
      ],
      checkPid: true,
      pollMs: 3_600_000,
      now,
      wsl: false,
    });
    src.start();
    return { src, o, linux, win, stop: () => src.stop() };
  }

  it('sessão que o watcher acompanha vai para ele; a outra vira personagem só do hook, na conta da pasta', () => {
    const now = () => 5_000_000;
    const { src, o, linux, stop } = source(now);
    try {
      const sid = '0e812336-1111-2222-3333-444455556666';
      const cli = join(linux, 'sessions', 'cli');
      writeFileSync(join(cli, `${sid}.lock`), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      writeFileSync(join(cli, `${sid}.json`), JSON.stringify({ cwd: '/proj/a', session_state: {} }));
      // a trava acabou de aparecer: o evento força a leitura e cai no watcher
      expect(src.applyHookEvent({ pids: [], kiroHome: linux, event: { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/proj/a', prompt: 'oi' } })).toBe(true);
      expect(o.get(sid)).toMatchObject({ status: 'working', account: '.kiro' });
      expect(src.sources()[0].sessions).toBe(1);

      const ok = src.applyHookEvent({ pids: [], kiroHome: linux, event: { hook_event_name: 'UserPromptSubmit', session_id: 'sess_xyz', cwd: '/proj/b', prompt: 'e aí' } });
      expect(ok).toBe(true);
      expect(o.get('sess_xyz')).toMatchObject({ status: 'working', account: '.kiro' });
    } finally {
      stop();
    }
  });

  it('o mesmo evento repetido (hook do agente + arquivo de hooks no 3.x) entra uma vez só', () => {
    const { src, o, stop } = source(() => 7_000_000);
    try {
      const e: KiroHookEvent = { pids: [], event: { hook_event_name: 'PreToolUse', session_id: 'sess_dup', cwd: '/p', tool_name: 'read_file', tool_input: { path: '/p/a' } } };
      src.applyHookEvent(e);
      src.applyHookEvent(e);
      expect(o.get('sess_dup')?.stats.toolCalls).toBe(1);
    } finally {
      stop();
    }
  });
});
