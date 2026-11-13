import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseLivenessMode, createLiveness, isKiroBundledRuntime, isWindowsMount, parsePs, parseTasklist, pidAlive } from './liveness';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** /proc de mentira: pid -> [comm, ppid, starttime em ticks]; btime = 1_000_000 s. */
function fakeProc(procs: Record<number, [string, number, number]>, cmdline: Record<number, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'kiro-proc-'));
  dirs.push(root);
  writeFileSync(join(root, 'stat'), 'cpu  1 2 3\nbtime 1000000\n');
  for (const [pid, [comm, ppid, start]] of Object.entries(procs)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, 'comm'), `${comm}\n`);
    writeFileSync(join(root, pid, 'cmdline'), cmdline[Number(pid)] ?? `${comm}\0`);
    const rest = Array.from({ length: 30 }, (_, i) => (i === 19 ? String(start) : '0'));
    rest[0] = 'S';
    rest[1] = String(ppid);
    writeFileSync(join(root, pid, 'stat'), `${pid} (${comm}) ${rest.join(' ')}`);
  }
  return root;
}

describe('chooseLivenessMode', () => {
  const base = { env: {} as NodeJS.ProcessEnv, sessionsDir: '/home/u/.kiro/sessions/cli' };
  it('o melhor de cada plataforma', () => {
    expect(chooseLivenessMode({ ...base, platform: 'linux', wsl: false })).toBe('proc');
    expect(chooseLivenessMode({ ...base, platform: 'win32' })).toBe('tasklist');
    expect(chooseLivenessMode({ ...base, platform: 'darwin' })).toBe('ps');
    expect(chooseLivenessMode({ ...base, platform: 'freebsd' })).toBe('pid');
  });
  it('WSL lendo /mnt/c: tasklist.exe se houver, senão mtime', () => {
    const win = { ...base, sessionsDir: '/mnt/c/Users/u/.kiro/sessions/cli', platform: 'linux' as const, wsl: true };
    expect(chooseLivenessMode({ ...win, tasklistExists: true })).toBe('tasklist');
    expect(chooseLivenessMode({ ...win, tasklistExists: false })).toBe('mtime');
  });
  it('Docker e HABBLAUD_KIRO_LIVENESS', () => {
    expect(chooseLivenessMode({ ...base, platform: 'linux', inDocker: true })).toBe('mtime');
    expect(chooseLivenessMode({ ...base, platform: 'linux', env: { HABBLAUD_KIRO_LIVENESS: 'pid' } })).toBe('pid');
    expect(chooseLivenessMode({ ...base, platform: 'win32', env: { HABBLAUD_KIRO_LIVENESS: 'MTIME' } })).toBe('mtime');
  });
  it('isWindowsMount', () => {
    expect(isWindowsMount('/mnt/c/Users/x')).toBe(true);
    expect(isWindowsMount('/mnt/wsl/x')).toBe(false);
    expect(isWindowsMount('/home/x')).toBe(false);
  });
});

describe('listas de processos', () => {
  it('tasklist CSV: só os kiro', () => {
    const out = '"kiro-cli.exe","18400","Console","1","120.000 K"\r\n"svchost.exe","5192","Services","0","10 K"\r\n';
    expect([...parseTasklist(out)]).toEqual([18400]);
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.').size).toBe(0);
  });
  it('ps: pelo nome do executável', () => {
    expect([...parsePs('  101 /usr/local/bin/kiro-cli\n  102 /usr/sbin/sshd\n  103 kiro-cli-chat\n')]).toEqual([101, 103]);
  });
  it('tasklist: primeira lista síncrona, depois em segundo plano; três falhas = sem resposta (o watcher usa o mtime)', () => {
    let calls = 0;
    let pending: ((err: Error | null, out: string) => void) | undefined;
    const live = createLiveness('tasklist', {
      platform: 'win32',
      execSync: () => {
        calls++;
        return '"kiro-cli.exe","7","Console","1","1 K"';
      },
      exec: (_b, _a, done) => {
        pending = done;
      },
    });
    expect(live.isKiro(7)).toBeUndefined();
    live.refresh!(0);
    expect(calls).toBe(1);
    expect(live.isKiro(7)).toBe(true);
    expect(live.isKiro(8)).toBe(false);
    live.refresh!(1_000); // dentro do TTL: nada
    expect(pending).toBeUndefined();
    live.refresh!(10_000);
    pending!(null, '"kiro-cli.exe","8","Console","1","1 K"');
    expect(live.isKiro(7)).toBe(false);
    expect(live.isKiro(8)).toBe(true);
    for (const t of [20_000, 30_000, 40_000]) {
      pending = undefined;
      live.refresh!(t);
      pending!(new Error('interop desligado'), '');
    }
    expect(live.isKiro(8)).toBeUndefined();
  });
});

describe('proc (Linux)', () => {
  it('PID reaproveitado por outro programa não conta; o executável kiro conta mesmo com outro comm', () => {
    const root = fakeProc({ 10: ['kiro-cli', 1, 100], 11: ['svchost', 1, 100], 12: ['MainThread', 1, 100] }, { 12: '/home/u/.local/bin/kiro-cli\0chat\0' });
    const live = createLiveness('proc', { procRoot: root });
    expect(live.isKiro(10)).toBe(true);
    expect(live.isKiro(11)).toBe(false);
    expect(live.isKiro(12)).toBe(true);
    expect(live.isKiro(99)).toBe(false);
  });
  it('I/O do processo (rchar/wchar)', () => {
    const root = fakeProc({ 10: ['kiro-cli', 1, 100] });
    writeFileSync(join(root, '10', 'io'), 'rchar: 4817585\nwchar: 835\nsyscr: 1\n');
    const live = createLiveness('proc', { procRoot: root });
    expect(live.io!(10)).toEqual({ r: 4817585, w: 835 });
    expect(live.io!(11)).toBeUndefined();
  });

  it('descendentes com o horário em que começaram', () => {
    const root = fakeProc({ 10: ['kiro-cli', 1, 100], 20: ['bash', 10, 500], 21: ['sleep', 20, 700], 30: ['other', 1, 100] });
    const kids = createLiveness('proc', { procRoot: root }).descendants!(10)!;
    expect([...kids.keys()].sort()).toEqual([20, 21]);
    expect(kids.get(20)).toBe((1_000_000 + 5) * 1000);
    expect(kids.get(21)).toBe((1_000_000 + 7) * 1000);
  });
});

it('pidAlive', () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(0)).toBe(false);
  expect(pidAlive(99999999)).toBe(false);
});

describe('isKiroBundledRuntime (Kiro CLI 3.x)', () => {
  it('node/bun dentro da pasta do Kiro conta; um node qualquer não', () => {
    expect(isKiroBundledRuntime('/home/u/.local/share/kiro-cli/node')).toBe(true);
    expect(isKiroBundledRuntime('/home/u/.local/share/kiro-cli/bun')).toBe(true);
    expect(isKiroBundledRuntime('/opt/kiro/bin/node')).toBe(true);
    expect(isKiroBundledRuntime('/usr/bin/node')).toBe(false);
    expect(isKiroBundledRuntime('/home/u/.nvm/versions/node/v24/bin/node')).toBe(false);
    expect(isKiroBundledRuntime('/home/u/projetos/kiro-tools/bin/python')).toBe(false);
    expect(isKiroBundledRuntime('')).toBe(false);
  });

  it('proc: processo "node" do runtime do Kiro é Kiro', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiro-proc-'));
    mkdirSync(join(root, '77'));
    writeFileSync(join(root, '77', 'comm'), 'node\n');
    writeFileSync(join(root, '77', 'cmdline'), '/home/u/.local/share/kiro-cli/node\0--experimental-wasm-modules\0x.js\0');
    mkdirSync(join(root, '78'));
    writeFileSync(join(root, '78', 'comm'), 'node\n');
    writeFileSync(join(root, '78', 'cmdline'), '/usr/bin/node\0server.js\0');
    const l = createLiveness('proc', { procRoot: root });
    expect(l.isKiro(77)).toBe(true);
    expect(l.isKiro(78)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
