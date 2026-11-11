// Hook de aprovação do Kiro (mod/habblaud-kiro/approval-hook.mjs): decisão (deny bloqueia, resto libera), regra de
// gating (só shell/escrita), corpo do pedido e a leitura da config. E as funções do instalador para o hook de
// aprovação (entradas 2.x/3.x, reconhecimento, add/remove).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const APPROVAL = resolve(__dirname, '../../mod/habblaud-kiro/approval-hook.mjs');
const INSTALL = resolve(__dirname, '../../mod/habblaud-kiro/install.mjs');

type Rec = Record<string, unknown>;
interface ApprovalModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; approve: boolean; waitMs: number };
  needsApproval(tool: unknown): boolean;
  requestBody(input: Rec, timeoutMs: number): Rec;
  trimInput(v: unknown, max?: number): unknown;
  decisionOutput(result: unknown): { deny: string } | undefined;
  run(env: NodeJS.ProcessEnv, stdinText?: string): Promise<{ deny: string } | undefined>;
  APPROVAL_TOOLS: Set<string>;
  DEFAULT_WAIT_S: number;
}
interface InstallModule {
  isApproval(e: unknown): boolean;
  isOurs(e: unknown): boolean;
  approvalEntry(command: string): Rec;
  addV2(agent: Rec, command: string, approvalCommand?: string): { agent: Rec; changed: boolean };
  removeV2(agent: Rec): { agent: Rec; changed: boolean };
  hasApprovalV2(agent: Rec): boolean;
  hasAnyHabblaud(agent: Rec): boolean;
  hookCommand(node: string, hook: string, platform: string, opts?: { strict?: boolean }): string;
  run(opts: Rec, ctx: Rec): Promise<number>;
  v3File(command: string, approvalCommand?: string): { version: string; hooks: Rec[] };
  APPROVAL_TIMEOUT_MS: number;
}
const h = (await import(pathToFileURL(APPROVAL).href)) as ApprovalModule;
const inst = (await import(pathToFileURL(INSTALL).href)) as InstallModule;

const dirs: string[] = [];
const servers: Server[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kiro-approval-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((ok) => s.close(ok));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Servidor que registra o pedido (201) e responde a espera com a decisão dada. */
async function serve(decision: Rec): Promise<number> {
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/permissions') {
        res.statusCode = 201;
        return void res.end(JSON.stringify({ id: 'p-1', expiresAt: Date.now() + 60_000 }));
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/permissions/p-1/wait')) return void res.end(JSON.stringify(decision));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return (s.address() as AddressInfo).port;
}

/** Roda o hook de aprovação como processo e devolve o código de saída e o stderr. */
function runHook(stdin: string, home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [APPROVAL], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => ok({ code, stderr }));
    p.stdin.end(stdin);
  });
}

/** HOME temporário com ~/.habblaud/kiro-hook.json. */
function homeWithConfig(cfg: Rec): string {
  const home = tmp();
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'kiro-hook.json'), JSON.stringify(cfg));
  return home;
}

describe('approval-hook: decisão', () => {
  it('só a recusa bloqueia (deny -> {deny}); aprovar/terminal/released/pending -> undefined', () => {
    expect(h.decisionOutput({ status: 'decided', behavior: 'deny', message: 'use pnpm' })).toEqual({ deny: 'Recusado pelo usuário no Habblaud: use pnpm' });
    expect(h.decisionOutput({ status: 'decided', behavior: 'deny' })).toEqual({ deny: 'Recusado pelo usuário no Habblaud.' });
    expect(h.decisionOutput({ status: 'decided', behavior: 'allow' })).toBeUndefined();
    expect(h.decisionOutput({ status: 'released', reason: 'terminal' })).toBeUndefined();
    expect(h.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(h.decisionOutput(undefined)).toBeUndefined();
  });
});

describe('approval-hook: gating', () => {
  it('só shell e escrita precisam de aprovação; leitura/busca passam direto', () => {
    for (const t of ['shell', 'execute_bash', 'fs_write', 'write']) expect(h.needsApproval(t)).toBe(true);
    for (const t of ['read', 'fs_read', 'grep', 'glob', 'web_search', 'summary', 42, undefined]) expect(h.needsApproval(t as unknown)).toBe(false);
  });
});

describe('approval-hook: corpo e config', () => {
  it('requestBody manda provider:"kiro", sessão, cwd e os argumentos cortados', () => {
    const body = h.requestBody({ session_id: 's1', cwd: '/p/loja', tool_name: 'shell', tool_input: { command: 'npm test' } }, 60_000);
    expect(body).toMatchObject({ provider: 'kiro', session_id: 's1', cwd: '/p/loja', tool_name: 'shell', tool_input: { command: 'npm test' }, timeout_ms: 60_000 });
  });

  it('readConfig: approve só com {approve:true}; wait com limites; porta do arquivo ou do ambiente', () => {
    expect(h.readConfig({ HOME: homeWithConfig({ port: 4848, approve: true, wait: 120 }) })).toEqual({ port: 4848, approve: true, waitMs: 120_000 });
    expect(h.readConfig({ HOME: homeWithConfig({ approve: false }) })).toEqual({ port: 4747, approve: false, waitMs: h.DEFAULT_WAIT_S * 1_000 });
    // wait fora dos limites volta ao padrão.
    expect(h.readConfig({ HOME: homeWithConfig({ approve: true, wait: 0 }) }).waitMs).toBe(h.DEFAULT_WAIT_S * 1_000);
    // sem arquivo: HABBLAUD_PORT, aprovação desligada.
    expect(h.readConfig({ HOME: tmp(), HABBLAUD_PORT: '5000' })).toEqual({ port: 5000, approve: false, waitMs: h.DEFAULT_WAIT_S * 1_000 });
  });

  it('run sai sem decidir quando a aprovação está desligada (sem rede)', async () => {
    expect(await h.run({ HOME: homeWithConfig({ approve: false }) }, JSON.stringify({ tool_name: 'shell', hook_event_name: 'preToolUse' }))).toBeUndefined();
  });

  it('run sai sem decidir para ferramenta que não pede aprovação (mesmo com approve:true)', async () => {
    expect(await h.run({ HOME: homeWithConfig({ approve: true, port: 1 }) }, JSON.stringify({ tool_name: 'read', hook_event_name: 'preToolUse' }))).toBeUndefined();
    // Evento que não é PreToolUse: ignorado.
    expect(await h.run({ HOME: homeWithConfig({ approve: true, port: 1 }) }, JSON.stringify({ tool_name: 'shell', hook_event_name: 'postToolUse' }))).toBeUndefined();
  });

  it('run sai sem decidir quando o Habblaud está fora do ar (porta fechada)', async () => {
    // porta 1 não escuta: o registro falha e o terminal decide.
    expect(await h.run({ HOME: homeWithConfig({ approve: true, port: 1 }) }, JSON.stringify({ tool_name: 'shell', tool_input: { command: 'ls' }, hook_event_name: 'preToolUse' }))).toBeUndefined();
  });
});

describe('instalador: hook de aprovação', () => {
  const OBS = 'node /h/.habblaud/kiro-hook.mjs 2>/dev/null || true';
  const APP = 'node /h/.habblaud/kiro-approval-hook.mjs 2>/dev/null || true';

  it('isApproval reconhece só a entrada de aprovação (não a de observar)', () => {
    expect(inst.isApproval({ command: APP })).toBe(true);
    expect(inst.isApproval({ command: OBS })).toBe(false);
    expect(inst.isOurs({ command: APP })).toBe(false);
    expect(inst.isOurs({ command: OBS })).toBe(true);
  });

  it('approvalEntry no preToolUse com timeout grande', () => {
    expect(inst.approvalEntry(APP)).toEqual({ matcher: '*', command: APP, timeout_ms: inst.APPROVAL_TIMEOUT_MS });
  });

  it('addV2 com approvalCommand põe a entrada de aprovação só no preToolUse; sem ele, tira', () => {
    const { agent } = inst.addV2({ name: 'a' }, OBS, APP);
    const pre = (agent.hooks as Rec).preToolUse as Rec[];
    expect(pre.some((e) => inst.isOurs(e))).toBe(true);
    expect(pre.some((e) => inst.isApproval(e))).toBe(true);
    expect(((agent.hooks as Rec).postToolUse as Rec[]).some((e) => inst.isApproval(e))).toBe(false);
    expect(inst.hasApprovalV2(agent)).toBe(true);
    // Sem o comando de aprovação: a entrada some; a de observar fica.
    const { agent: a2 } = inst.addV2(agent, OBS);
    expect(inst.hasApprovalV2(a2)).toBe(false);
    expect(((a2.hooks as Rec).preToolUse as Rec[]).some((e) => inst.isOurs(e))).toBe(true);
  });

  it('removeV2 tira observar e aprovar', () => {
    const { agent } = inst.addV2({ name: 'a' }, OBS, APP);
    const { agent: clean, changed } = inst.removeV2(agent);
    expect(changed).toBe(true);
    expect(clean.hooks).toBeUndefined();
  });

  it('removeV2 entende o agente migrado para o 3.x (hooks em lista) e mantém os hooks dos outros', () => {
    const mine = { name: 'guard', trigger: 'preToolUse', action: { type: 'command', command: 'guard.sh' } };
    const migrated = {
      name: 'a',
      hooks: [
        { name: 'agentSpawn-0', trigger: 'agentSpawn', action: { type: 'command', command: OBS }, timeout: 3 },
        { name: 'preToolUse-1', trigger: 'preToolUse', matcher: '*', action: { type: 'command', command: APP }, timeout: 310 },
        mine,
      ],
    };
    const { agent, changed } = inst.removeV2(migrated);
    expect(changed).toBe(true);
    expect(agent.hooks).toEqual([mine]);
    expect(inst.hasAnyHabblaud(migrated)).toBe(true);
    expect(inst.hasAnyHabblaud(agent)).toBe(false);
  });

  it('comando de aprovação instalado: a recusa (exit 2 + motivo) chega ao Kiro; o de observar segue engolindo erros', () => {
    if (process.platform === 'win32') return;
    const d = tmp();
    const fake = join(d, 'kiro-approval-hook.mjs');
    writeFileSync(fake, 'process.stderr.write("Recusado pelo usuário no Habblaud."); process.exitCode = 2;\n');
    const sh = (cmd: string) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
    const strict = sh(inst.hookCommand(process.execPath, fake, 'linux', { strict: true }));
    expect(strict.status).toBe(2);
    expect(strict.stderr).toContain('Recusado pelo usuário no Habblaud.');
    // O de observar nunca pode bloquear: `|| true` vira 0 (e foi esse comando que, usado na aprovação, apagava a recusa).
    expect(sh(inst.hookCommand(process.execPath, fake, 'linux')).status).toBe(0);
    expect(inst.hookCommand('node', 'C:\\h\\kiro-approval-hook.mjs', 'win32', { strict: true })).toBe('node C:\\h\\kiro-approval-hook.mjs');
  });

  it('install --aprovar no 3.x: grava hooks/habblaud.json e tira as entradas antigas dos agentes (sem duplicar)', async () => {
    const home = tmp();
    const agents = join(home, '.kiro', 'agents');
    mkdirSync(agents, { recursive: true });
    const old2 = inst.addV2({ name: 'velho' }, '/n/node /h/.habblaud/kiro-hook.mjs 2>/dev/null || true', '/n/node /h/.habblaud/kiro-approval-hook.mjs 2>/dev/null || true').agent;
    writeFileSync(join(agents, 'velho.json'), JSON.stringify(old2));
    writeFileSync(join(agents, 'migrado.json'), JSON.stringify({ name: 'migrado', hooks: [{ name: 'x', trigger: 'stop', action: { type: 'command', command: '/n/node /h/.habblaud/kiro-hook.mjs || true' } }] }));
    const src = tmp();
    writeFileSync(join(src, 'hook.mjs'), '');
    writeFileSync(join(src, 'approval.mjs'), '');
    const lines: string[] = [];
    const code = await inst.run(
      { command: 'install', format: 'v3', approve: true },
      { home, env: {}, out: (l: string) => lines.push(l), nodeBin: '/n/node', platform: 'linux', hookSource: join(src, 'hook.mjs'), approvalSource: join(src, 'approval.mjs') },
    );
    expect(code).toBe(0);
    const file = JSON.parse(readFileSync(join(home, '.kiro', 'hooks', 'habblaud.json'), 'utf8')) as { hooks: Rec[] };
    const approval = file.hooks.find((x) => x.name === 'habblaud-approval') as Rec;
    expect((approval.action as Rec).command).not.toContain('|| true');
    for (const n of ['velho', 'migrado']) expect(inst.hasAnyHabblaud(JSON.parse(readFileSync(join(agents, `${n}.json`), 'utf8')) as Rec)).toBe(false);
  });

  it('v3File com approvalCommand acrescenta o hook habblaud-approval (PreToolUse, timeout grande)', () => {
    const file = inst.v3File(OBS, APP);
    const approval = file.hooks.find((hk) => hk.name === 'habblaud-approval');
    // `*` sozinho é regex inválida no 3.x (o hook seria descartado); `timeout` em segundos (o 3.x ignora timeout_ms).
    expect(approval).toMatchObject({ trigger: 'PreToolUse', timeout: Math.ceil(inst.APPROVAL_TIMEOUT_MS / 1_000), action: { type: 'command', command: APP } });
    expect('timeout_ms' in (approval as Rec)).toBe(false);
    const re = new RegExp(String((approval as Rec).matcher));
    for (const t of ['execute_bash', 'execute_pwsh', 'shell', 'fs_write', 'str_replace', 'write']) expect(re.test(t)).toBe(true);
    for (const t of ['fs_read', 'grep', 'glob', 'execute_bash_x']) expect(re.test(t)).toBe(false);
    // Sem o comando: não aparece.
    expect(inst.v3File(OBS).hooks.find((hk) => hk.name === 'habblaud-approval')).toBeUndefined();
  });
});

describe('approval-hook: processo de verdade (exit code)', () => {
  const stdin = JSON.stringify({ hook_event_name: 'preToolUse', session_id: 's1', cwd: '/p/loja', tool_name: 'shell', tool_input: { command: 'rm -rf x' } });

  it('recusa: exit 2 e o motivo no stderr (bloqueia a ferramenta no Kiro)', async () => {
    const port = await serve({ status: 'decided', behavior: 'deny', message: 'use outro comando' });
    const home = homeWithConfig({ approve: true, port });
    const { code, stderr } = await runHook(stdin, home);
    expect(code).toBe(2);
    expect(stderr).toContain('Recusado pelo usuário no Habblaud: use outro comando');
  });

  it('aprovação: exit 0 e nada no stderr (libera o prompt do terminal)', async () => {
    const port = await serve({ status: 'decided', behavior: 'allow' });
    const home = homeWithConfig({ approve: true, port });
    const { code, stderr } = await runHook(stdin, home);
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('aprovação desligada: exit 0, nem registra', async () => {
    const home = homeWithConfig({ approve: false, port: 1 });
    const { code } = await runHook(stdin, home);
    expect(code).toBe(0);
  });
});
