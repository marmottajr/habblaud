// Hook do Kiro (mod/habblaud-kiro/hook.mjs) rodado como processo de verdade contra um servidor HTTP de teste, e o
// instalador (mod/habblaud-kiro/install.mjs) em pastas temporárias. HOME sempre temporário; stdin sintético.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = resolve(__dirname, '../../mod/habblaud-kiro/hook.mjs');
const INSTALL = resolve(__dirname, '../../mod/habblaud-kiro/install.mjs');

interface HookModule {
  eventName(raw: unknown): string | undefined;
  readConfig(env: NodeJS.ProcessEnv): { port: number };
  kiroPids(start: number, procRoot: string): number[];
  eventBody(input: Record<string, unknown>, ctx: { kiroHome: string; pids: number[]; platform: string }): { event: Record<string, unknown> } & Record<string, unknown>;
}
type Rec = Record<string, unknown>;
interface InstallModule {
  hookCommand(node: string, hook: string, platform: string): string;
  isOurs(e: unknown): boolean;
  isManagedAgent(file: string): boolean;
  addV2(agent: Rec, command: string): { agent: Rec; changed: boolean };
  removeV2(agent: Rec): { agent: Rec; changed: boolean };
  hasV2(agent: Rec): boolean;
  v3File(command: string): { version: string; hooks: Rec[] };
  kiroMajor(out: string): number | undefined;
  parseArgs(argv: string[]): Rec | 'help';
  run(opts: Rec, ctx: Rec): Promise<number>;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;
const inst = (await import(pathToFileURL(INSTALL).href)) as InstallModule;

const dirs: string[] = [];
const servers: Server[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kiro-hook-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((ok) => s.close(ok));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(status = 200): Promise<{ port: number; bodies: Rec[] }> {
  const bodies: Rec[] = [];
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/kiro/events' && req.headers['content-type'] === 'application/json') bodies.push(JSON.parse(raw) as Rec);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return { port: (s.address() as AddressInfo).port, bodies };
}

function runHook(stdin: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((ok) => {
    const p = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.on('close', (code) => ok({ code, stdout, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

describe('hook.mjs', () => {
  it('nomes do 2.x e do 3.x', () => {
    expect(hook.eventName('preToolUse')).toBe('PreToolUse');
    expect(hook.eventName('UserPromptSubmit')).toBe('UserPromptSubmit');
    expect(hook.eventName('stop')).toBe('Stop');
    expect(hook.eventName('Notification')).toBeUndefined();
  });

  it('porta: arquivo, HABBLAUD_PORT, padrão', () => {
    const home = tmp();
    expect(hook.readConfig({ HOME: home }).port).toBe(4747);
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4800' }).port).toBe(4800);
    mkdirSync(join(home, '.habblaud'));
    writeFileSync(join(home, '.habblaud', 'kiro-hook.json'), '{"port": 4900}');
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4800' }).port).toBe(4900);
  });

  it('PIDs do Kiro acima do hook pelo /proc', () => {
    const root = tmp();
    const proc = (pid: number, comm: string, ppid: number, exe = comm) => {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 0 0`);
      writeFileSync(join(root, String(pid), 'cmdline'), `${exe}\0`);
    };
    proc(859, 'kiro-cli-chat', 844);
    proc(844, 'bun', 813, '/x/bun');
    proc(813, 'MainThread', 794, '/home/u/.local/bin/kiro-cli-chat');
    proc(794, 'kiro-cli', 792);
    proc(792, 'script', 1);
    expect(hook.kiroPids(859, root)).toEqual([859, 813, 794]);
  });

  it('corpo: só os campos usados, textos cortados', () => {
    const big = 'x'.repeat(50_000);
    const b = hook.eventBody(
      { hook_event_name: 'postToolUse', session_id: 's', cwd: '/p', tool_name: 'write', tool_input: { content: big }, tool_response: { items: [{ Text: big }] }, extra: 'fora' },
      { kiroHome: '/h/.kiro', pids: [1], platform: 'linux' },
    );
    expect(b.event.hook_event_name).toBe('PostToolUse');
    expect(b.event.extra).toBeUndefined();
    expect(((b.event.tool_input as Rec).content as string).length).toBe(4_000);
    expect(JSON.stringify(b.event.tool_response).length).toBeLessThan(400);
  });

  it('processo: manda o evento, não escreve nada no stdout e sai com 0', async () => {
    const { port, bodies } = await serve();
    const home = tmp();
    const r = await runHook(JSON.stringify({ hook_event_name: 'userPromptSubmit', session_id: 'abc', cwd: '/p', prompt: 'oi' }), { HOME: home, HABBLAUD_PORT: String(port), PATH: process.env.PATH });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ kiroHome: join(home, '.kiro'), event: { hook_event_name: 'UserPromptSubmit', session_id: 'abc', prompt: 'oi' } });
  });

  it('Habblaud fora do ar, stdin inválido ou servidor com erro: sai com 0, rápido e calado', async () => {
    const home = tmp();
    const env = { HOME: home, HABBLAUD_PORT: '9', PATH: process.env.PATH };
    for (const stdin of [JSON.stringify({ hook_event_name: 'preToolUse', session_id: 'a', tool_name: 'shell' }), 'não é json', '{}']) {
      const r = await runHook(stdin, env);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms).toBeLessThan(2_500);
    }
    const { port } = await serve(500);
    expect((await runHook(JSON.stringify({ hook_event_name: 'stop', session_id: 'a' }), { ...env, HABBLAUD_PORT: String(port) })).code).toBe(0);
  });
});

describe('install.mjs: funções', () => {
  it('comando: nunca deixa o Kiro ver erro (PreToolUse que falha bloqueia a ferramenta)', () => {
    expect(inst.hookCommand('/n/node', '/h/.habblaud/kiro-hook.mjs', 'linux')).toBe('/n/node /h/.habblaud/kiro-hook.mjs 2>/dev/null || true');
    expect(inst.hookCommand('/my node/node', '/h/kiro-hook.mjs', 'linux')).toBe("'/my node/node' /h/kiro-hook.mjs 2>/dev/null || true");
    expect(inst.hookCommand('node', 'C:\\Users\\ana\\.habblaud\\kiro-hook.mjs', 'win32')).toBe('node C:\\Users\\ana\\.habblaud\\kiro-hook.mjs 2>nul & exit /b 0');
    expect(inst.hookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\h\\kiro-hook.mjs', 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe" C:\\h\\kiro-hook.mjs 2>nul & exit /b 0');
  });

  it('agente 2.x: acrescenta no fim, não duplica, troca no lugar e tira só o do Habblaud', () => {
    const mine = { command: 'echo antes' };
    const agent = { name: 'dev', hooks: { preToolUse: [mine] }, tools: ['*'] };
    const cmd = 'node /h/.habblaud/kiro-hook.mjs 2>/dev/null || true';
    const a = inst.addV2(agent, cmd);
    expect(a.changed).toBe(true);
    expect((a.agent.hooks as Rec).preToolUse).toEqual([mine, { matcher: '*', command: cmd, timeout_ms: 3000 }]);
    expect((a.agent.hooks as Rec).stop).toEqual([{ command: cmd, timeout_ms: 3000 }]);
    expect(inst.hasV2(a.agent)).toBe(true);
    expect(inst.addV2(a.agent, cmd).changed).toBe(false);
    const moved = inst.addV2(a.agent, 'node /outro/kiro-hook.mjs || true');
    expect(((moved.agent.hooks as Rec).preToolUse as Rec[]).map((e) => e.command)).toEqual(['echo antes', 'node /outro/kiro-hook.mjs || true']);
    const r = inst.removeV2(a.agent);
    expect(r.agent).toEqual(agent);
    expect(inst.removeV2({ name: 'x' }).changed).toBe(false);
  });

  it('agentes do Kiro Crew ficam de fora; versão; 3.x; opções', () => {
    expect(inst.isManagedAgent('/a/kirocrew-worker.json')).toBe(true);
    expect(inst.isManagedAgent('/a/crew-manager--crew-manager-conductor.json')).toBe(true);
    expect(inst.isManagedAgent('/a/devops-agent.json.bak')).toBe(true);
    expect(inst.isManagedAgent('/a/devops-agent.json')).toBe(false);
    expect(inst.kiroMajor('kiro-cli 2.16.2')).toBe(2);
    expect(inst.kiroMajor('kiro-cli 3.0.0')).toBe(3);
    const f = inst.v3File('node /h/kiro-hook.mjs');
    expect(f.version).toBe('v1');
    // 3.x: o início da sessão é SessionStart (AgentSpawn não é reconhecido) e o prazo é `timeout` em segundos.
    expect(f.hooks.map((h) => h.trigger)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(f.hooks.every((h) => inst.isOurs(h))).toBe(true);
    expect(f.hooks.every((h) => h.timeout === 3 && !('timeout_ms' in h) && !('matcher' in h))).toBe(true);
    expect(inst.parseArgs(['install', '--formato', 'v3', '--agente', 'a, b', '--port', '4800'])).toMatchObject({ command: 'install', format: 'v3', agents: ['a', 'b'], port: 4800 });
    expect(inst.parseArgs(['nada'])).toBe('help');
    expect(() => inst.parseArgs(['install', '--formato', 'v9'])).toThrow();
  });
});

describe('install.mjs: run em pastas temporárias', () => {
  const ctx = (home: string, extra: Rec = {}) => {
    const lines: string[] = [];
    return { lines, ctx: { home, env: { HOME: home }, out: (l: string) => lines.push(l), now: new Date(2026, 10, 5, 12, 0, 0), nodeBin: '/n/node', platform: 'linux', health: async () => ({ kiroEvents: true }), ...extra } };
  };

  it('2.x: instala nos agentes (menos os do Crew), com backup; de novo não muda; uninstall volta ao original', async () => {
    const home = tmp();
    const agents = join(home, '.kiro', 'agents');
    mkdirSync(agents, { recursive: true });
    const original = `${JSON.stringify({ name: 'dev', tools: ['*'] }, null, 2)}\n`;
    writeFileSync(join(agents, 'dev.json'), original);
    writeFileSync(join(agents, 'kirocrew-worker.json'), '{"name":"kirocrew-worker"}');
    const c1 = ctx(home);
    expect(await inst.run({ command: 'install', format: 'v2' }, c1.ctx)).toBe(0);
    const dev = JSON.parse(readFileSync(join(agents, 'dev.json'), 'utf8')) as Rec;
    expect(inst.hasV2(dev)).toBe(true);
    expect(((dev.hooks as Rec).userPromptSubmit as Rec[])[0].command).toBe(`/n/node ${join(home, '.habblaud', 'kiro-hook.mjs')} 2>/dev/null || true`);
    expect(readFileSync(join(agents, 'kirocrew-worker.json'), 'utf8')).toBe('{"name":"kirocrew-worker"}');
    expect(readdirSync(agents).filter((f) => f.includes('habblaud-backup'))).toHaveLength(1);
    expect(existsSync(join(home, '.habblaud', 'kiro-hook.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.habblaud', 'kiro-hook.json'), 'utf8'))).toEqual({ port: 4747, approve: false, wait: 300 });

    const c2 = ctx(home);
    await inst.run({ command: 'install', format: 'v2' }, c2.ctx);
    expect(c2.lines.some((l) => l.startsWith('= dev.json'))).toBe(true);

    const c3 = ctx(home);
    await inst.run({ command: 'status' }, { ...c3.ctx, detectFormat: () => undefined });
    expect(c3.lines.join('\n')).toMatch(/Agentes com o hook: dev/);
    expect(c3.lines.join('\n')).toMatch(/recebendo os eventos do Kiro/);

    expect(await inst.run({ command: 'uninstall', format: 'v2' }, ctx(home).ctx)).toBe(0);
    expect(readFileSync(join(agents, 'dev.json'), 'utf8')).toBe(original);
  });

  it('3.x: grava hooks/habblaud.json e o uninstall apaga; arquivo de outro dono não é tocado', async () => {
    const home = tmp();
    expect(await inst.run({ command: 'install', format: 'v3' }, ctx(home).ctx)).toBe(0);
    const file = join(home, '.kiro', 'hooks', 'habblaud.json');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { hooks: Rec[] }).hooks).toHaveLength(5);
    await inst.run({ command: 'uninstall', format: 'v3' }, ctx(home).ctx);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, '{"version":"v1","hooks":[{"name":"meu","trigger":"Stop","action":{"type":"command","command":"echo"}}]}');
    expect(await inst.run({ command: 'install', format: 'v3' }, ctx(home).ctx)).toBe(1);
    await inst.run({ command: 'uninstall', format: 'v3' }, ctx(home).ctx);
    expect(existsSync(file)).toBe(true);
  });

  it('--pasta instala no .kiro do projeto; --dry-run não grava nada; sem versão pede --formato', async () => {
    const home = tmp();
    const proj = tmp();
    await inst.run({ command: 'install', format: 'v3', dir: proj }, ctx(home).ctx);
    expect(existsSync(join(proj, '.kiro', 'hooks', 'habblaud.json'))).toBe(true);
    const dry = tmp();
    await inst.run({ command: 'install', format: 'v3', dryRun: true }, ctx(dry).ctx);
    expect(existsSync(join(dry, '.kiro'))).toBe(false);
    expect(existsSync(join(dry, '.habblaud'))).toBe(false);
    const c = ctx(tmp(), { detectFormat: () => undefined });
    expect(await inst.run({ command: 'install' }, c.ctx)).toBe(1);
    expect(c.lines.join('\n')).toMatch(/--formato/);
  });
});

describe('PostToolUse do hook de observar solta o cartão de aprovação (rota de verdade)', () => {
  it('o hook.mjs manda o PostToolUse e o cartão do mesmo comando some na hora; o long-poll do hook de aprovação sai', async () => {
    const { handleKiroEvent } = await import('../kiro/http');
    const { PermissionRegistry } = await import('../permissions/registry');
    const { Office } = await import('../model/office');
    const { NameStore } = await import('../model/names');
    const { setQuiet } = await import('../log');
    setQuiet(true);
    let registry: InstanceType<typeof PermissionRegistry> | undefined;
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined, permissions: () => registry?.snapshot() ?? new Map() });
    office.addMain({ id: 'kiro-s1', provider: 'kiro', account: '.kiro', sessionId: 'kiro-s1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
    registry = new PermissionRegistry({ office, viewers: () => 1 });
    const reg = registry.register({ provider: 'kiro', session_id: 'kiro-s1', cwd: '/p/loja', tool_name: 'execute_bash', tool_input: { command: 'npm test' }, timeout_ms: 300_000 });
    if ('skip' in reg) throw new Error(reg.skip);
    const wait = registry.wait(reg.id, 20_000)!;

    const s = createServer((req, res) => void handleKiroEvent(req, res, { permissions: registry }).catch(() => res.writeHead(500).end()));
    servers.push(s);
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    const port = (s.address() as AddressInfo).port;
    const home = tmp();
    const post = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'kiro-s1', cwd: '/p/loja', tool_name: 'execute_bash', tool_input: { command: 'npm test' }, tool_response: { success: true } });
    const r = await runHook(post, { ...process.env, HOME: home, USERPROFILE: home, HABBLAUD_PORT: String(port) });
    expect(r.code).toBe(0);
    expect(await wait.result).toEqual({ status: 'released', reason: 'answered' });
    expect(office.commit().snapshot.agents.find((a) => a.id === 'kiro-s1')?.permission).toBeUndefined();
  });
});
