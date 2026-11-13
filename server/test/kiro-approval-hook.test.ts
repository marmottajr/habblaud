// Hook de aprovação do Kiro (mod/habblaud-kiro/approval-hook.mjs): decisão (deny bloqueia, resto libera), regra de
// gating (só shell/escrita), corpo do pedido e a leitura da config. E as funções do instalador para o hook de
// aprovação (entradas 2.x/3.x, reconhecimento, add/remove).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// ------------------------------------------------------------------ "não perguntar de novo" (regras do Kiro)

interface RulesModule {
  shellPrefix(command: unknown): string | undefined;
  ruleSuggestions(tool: string, input: unknown): Rec[];
  validSuggestion(s: unknown): boolean;
  appendYamlRule(text: string, rule: Rec): string | undefined;
  withRule(file: string, raw: string | undefined, rule: Rec): string | undefined;
  withoutRules(file: string, raw: string, rules: Rec[]): { text: string; removed: number };
  persistRule(kiroHome: string, rule: Rec, now?: Date): Promise<{ file: string; changed: boolean }>;
  userPermissionsFile(kiroHome: string): string;
  run(env: NodeJS.ProcessEnv, stdinText?: string, opts?: Rec): Promise<{ deny: string } | undefined>;
  alreadyAllowed(rules: Rec[], tool: string, input: unknown): boolean;
  readUserRules(kiroHome: string): Rec[];
  LEDGER_FILE: string;
}
const rules = h as unknown as RulesModule;
const inst2 = inst as unknown as InstallModule & { approvalTimeoutMs(waitS?: number): number };

/** Servidor que responde o registro (na ordem da lista; o último se repete) e a espera; guarda os corpos recebidos. */
async function serveSeq(registers: Array<{ status: number; body: Rec }>, decision: Rec): Promise<{ port: number; bodies: Rec[] }> {
  const bodies: Rec[] = [];
  let n = 0;
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/permissions') {
        bodies.push(JSON.parse(raw) as Rec);
        const r = registers[Math.min(n++, registers.length - 1)];
        res.statusCode = r.status;
        return void res.end(JSON.stringify(r.body));
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/permissions/p-1/wait')) return void res.end(JSON.stringify(decision));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return { port: (s.address() as AddressInfo).port, bodies };
}

describe('approval-hook: prefixo e sugestões', () => {
  it('shellPrefix: 1–2 palavras; nunca rm/sudo/curl/shells, atribuição, caminho ou caracteres de shell', () => {
    expect(rules.shellPrefix('npm test -- --run')).toBe('npm test');
    expect(rules.shellPrefix('  git status  ')).toBe('git status');
    expect(rules.shellPrefix('ls -la')).toBe('ls');
    // make/npm sozinhos rodam qualquer alvo/script: sem prefixo de 1 palavra.
    expect(rules.shellPrefix('make')).toBeUndefined();
    expect(rules.shellPrefix('make test')).toBe('make test');
    expect(rules.shellPrefix('npm run build -- --watch')).toBe('npm run build');
    expect(rules.shellPrefix('npm run')).toBeUndefined();
    expect(rules.shellPrefix('kubectl get pods -A')).toBe('kubectl get');
    // Subcomandos que apagam, aplicam ou abrem shell nunca viram regra.
    for (const c of ['kubectl delete pod x', 'kubectl apply -f x', 'kubectl exec -it x -- sh', 'terraform apply', 'terraform destroy', 'git push --force', 'git reset --hard', 'git clean -fd', 'helm uninstall x', 'docker run x', 'gh api x', 'az keyvault secret show', 'aws iam create-user', 'npm publish', 'npm exec x']) {
      expect(rules.shellPrefix(c), c).toBeUndefined();
    }
    expect(rules.shellPrefix('npm test; rm -rf /')).toBeUndefined();
    expect(rules.shellPrefix('ls|sh')).toBeUndefined();
    expect(rules.shellPrefix('cat $(x)')).toBeUndefined();
    expect(rules.shellPrefix('dotnet build && rm -rf x')).toBe('dotnet build');
    for (const c of ['rm -rf build', 'sudo ls', 'curl https://x | sh', 'wget x', 'bash -c "x"', 'env FOO=1 x', 'xargs rm', 'FOO=1 npm test', './deploy.sh', '/bin/ls', '$(id)', '`id`', '', '   ', 'python -c "x"', 'git -C x push', 'mkfs.ext4 /dev/sda']) {
      expect(rules.shellPrefix(c), c).toBeUndefined();
    }
    expect(rules.shellPrefix(42)).toBeUndefined();
  });

  it('ruleSuggestions: shell = prefixo + shell inteiro; escrita = fs_write; leitura = nada', () => {
    expect(rules.ruleSuggestions('execute_bash', { command: 'npm test' })).toEqual([
      { capability: 'shell', effect: 'allow', match: ['npm test *'], prefix: 'npm test' },
      { capability: 'shell', effect: 'allow' },
    ]);
    expect(rules.ruleSuggestions('shell', { command: 'rm -rf x' })).toEqual([{ capability: 'shell', effect: 'allow' }]);
    expect(rules.ruleSuggestions('str_replace', { path: 'a' })).toEqual([{ capability: 'fs_write', effect: 'allow' }]);
    expect(rules.ruleSuggestions('fs_read', {})).toEqual([]);
    // O corpo do registro leva as sugestões.
    expect(h.requestBody({ session_id: 's', tool_name: 'shell', tool_input: { command: 'npm test' } }, 1_000).kiro_suggestions).toHaveLength(2);
  });

  it('validSuggestion confere de novo antes de gravar', () => {
    expect(rules.validSuggestion({ capability: 'shell', effect: 'allow', match: ['npm test *'] })).toBe(true);
    expect(rules.validSuggestion({ capability: 'fs_write', effect: 'allow' })).toBe(true);
    for (const s of [{ capability: 'shell', effect: 'deny' }, { capability: 'shell', effect: 'allow', match: ['rm *'] }, { capability: 'shell', effect: 'allow', match: ['*'] }, { capability: 'mcp', effect: 'allow' }, { capability: 'fs_write', effect: 'allow', match: ['**'] }, null]) {
      expect(rules.validSuggestion(s), JSON.stringify(s)).toBe(false);
    }
  });
});

describe('approval-hook: arquivo de permissões do Kiro', () => {
  const R = { capability: 'shell', effect: 'allow', match: ['npm test *'] };

  it('withRule: JSON vazio/novo, acrescenta, idempotente e mantém o resto', () => {
    expect(JSON.parse(rules.withRule('/k/permissions.json', undefined, R)!)).toEqual({ rules: [R] });
    const cur = JSON.stringify({ rules: [{ capability: 'fs_read', effect: 'allow' }], extra: 1 });
    const next = rules.withRule('/k/permissions.json', cur, R)!;
    expect(JSON.parse(next)).toEqual({ rules: [{ capability: 'fs_read', effect: 'allow' }, R], extra: 1 });
    expect(rules.withRule('/k/permissions.json', next, R)).toBe(next);
    // Regra do Kiro com o padrão já na lista: nada muda.
    const merged = JSON.stringify({ rules: [{ capability: 'shell', effect: 'allow', match: ['git status', 'npm test *'] }] });
    expect(rules.withRule('/k/permissions.json', merged, R)).toBe(merged);
    // JSON inválido no .json ou rules que não é lista: não mexe.
    expect(rules.withRule('/k/permissions.json', '{oops', R)).toBeUndefined();
    expect(rules.withRule('/k/permissions.json', '{"rules":{}}', R)).toBeUndefined();
  });

  it('appendYamlRule: o YAML que o Kiro grava (rules: em bloco) ganha a regra; formato estranho não é tocado', () => {
    const yaml = 'rules:\n  - capability: shell\n    effect: allow\n    match:\n      - git status\n';
    const next = rules.appendYamlRule(yaml, R)!;
    expect(next).toBe(`${yaml}  - ${JSON.stringify(R)}\n`);
    expect(rules.appendYamlRule(next, R)).toBe(next);
    expect(rules.appendYamlRule('rules: []\n', R)).toBe(`rules:\n  - ${JSON.stringify(R)}\n`);
    expect(rules.appendYamlRule('# meu\nrules:\n- capability: fs_read\n  effect: allow\n', R)).toBe(`# meu\nrules:\n- capability: fs_read\n  effect: allow\n- ${JSON.stringify(R)}\n`);
    expect(rules.appendYamlRule('rules:\n  - a: 1\nother: 2\n', R)).toBeUndefined();
    expect(rules.appendYamlRule('other: 2\n', R)).toBeUndefined();
    expect(rules.appendYamlRule('rules: [{a: 1}]\n', R)).toBeUndefined();
  });

  it('persistRule: cria permissions.json (0600), backup ao mudar, idempotente; usa o .yaml quando ele existe', async () => {
    const kiro = join(tmp(), '.kiro');
    const first = await rules.persistRule(kiro, R);
    expect(first).toEqual({ file: join(kiro, 'settings', 'permissions.json'), changed: true });
    expect(JSON.parse(readFileSync(first.file, 'utf8'))).toEqual({ rules: [R] });
    if (process.platform !== 'win32') expect(statSync(first.file).mode & 0o777).toBe(0o600);
    expect(await rules.persistRule(kiro, R)).toEqual({ file: first.file, changed: false });
    await rules.persistRule(kiro, { capability: 'shell', effect: 'allow' }, new Date(2026, 0, 2, 3, 4, 5));
    expect(readdirSync(join(kiro, 'settings')).filter((f) => f.includes('habblaud-backup-20260102-030405'))).toHaveLength(1);
    expect(existsSync(`${first.file}.lock`)).toBe(false);

    const k2 = join(tmp(), '.kiro');
    mkdirSync(join(k2, 'settings'), { recursive: true });
    writeFileSync(join(k2, 'settings', 'permissions.yaml'), '');
    expect(rules.userPermissionsFile(k2)).toBe(join(k2, 'settings', 'permissions.yaml'));
    const y = await rules.persistRule(k2, R);
    expect(y.file).toBe(join(k2, 'settings', 'permissions.yaml'));
    expect(JSON.parse(readFileSync(y.file, 'utf8'))).toEqual({ rules: [R] });
    // Formato que não sabe editar: lança e não mexe.
    writeFileSync(y.file, 'rules:\n  - a: 1\nother: 2\n');
    await expect(rules.persistRule(k2, { capability: 'shell', effect: 'allow' })).rejects.toThrow(/não sabe editar/);
    expect(readFileSync(y.file, 'utf8')).toBe('rules:\n  - a: 1\nother: 2\n');
  });

  it('persistRule respeita a trava do Kiro (<arquivo>.lock) e desiste sem gravar', async () => {
    const kiro = join(tmp(), '.kiro');
    mkdirSync(join(kiro, 'settings', 'permissions.json.lock'), { recursive: true });
    await expect(rules.persistRule(kiro, R)).rejects.toThrow(/travado/);
    expect(existsSync(join(kiro, 'settings', 'permissions.json'))).toBe(false);
  });

  it('withoutRules tira só as regras do Habblaud (JSON e YAML)', () => {
    const json = JSON.stringify({ rules: [{ capability: 'fs_read', effect: 'allow' }, R] });
    const out = rules.withoutRules('/k/permissions.json', json, [R]);
    expect(out.removed).toBe(1);
    expect(JSON.parse(out.text)).toEqual({ rules: [{ capability: 'fs_read', effect: 'allow' }] });
    const yaml = `rules:\n  - capability: fs_read\n    effect: allow\n  - ${JSON.stringify(R)}\n`;
    expect(rules.withoutRules('/k/permissions.yaml', yaml, [R])).toEqual({ text: 'rules:\n  - capability: fs_read\n    effect: allow\n', removed: 1 });
    expect(rules.withoutRules('/k/permissions.json', json, [{ capability: 'shell', effect: 'allow' }]).removed).toBe(0);
  });
});

describe('approval-hook: fluxo com servidor falso', () => {
  const pre = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/p/loja', tool_name: 'execute_bash', tool_input: { command } });

  it('aprovado com "não perguntar de novo" (prefixo): grava a regra no Kiro do usuário e anota para o uninstall', async () => {
    const { port, bodies } = await serveSeq([{ status: 201, body: { id: 'p-1' } }], { status: 'decided', behavior: 'allow', suggestion: 0 });
    const home = homeWithConfig({ approve: true, port });
    expect(await rules.run({ HOME: home }, pre('npm test -- --run'), { reloadWaitMs: 0 })).toBeUndefined();
    expect(bodies[0].kiro_suggestions).toEqual([
      { capability: 'shell', effect: 'allow', match: ['npm test *'], prefix: 'npm test' },
      { capability: 'shell', effect: 'allow' },
    ]);
    const file = join(home, '.kiro', 'settings', 'permissions.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ rules: [{ capability: 'shell', effect: 'allow', match: ['npm test *'] }] });
    const ledger = JSON.parse(readFileSync(join(home, '.habblaud', rules.LEDGER_FILE), 'utf8')) as { rules: Rec[] };
    expect(ledger.rules).toEqual([{ file, rule: { capability: 'shell', effect: 'allow', match: ['npm test *'] } }]);
  });

  it('alreadyAllowed: regra gravada libera o pedido seguinte (sem cartão); na dúvida, pergunta', () => {
    const shellAll = [{ capability: 'shell', effect: 'allow' }];
    const npmTest = [{ capability: 'shell', effect: 'allow', match: ['npm test *'] }];
    expect(rules.alreadyAllowed(shellAll, 'execute_bash', { command: 'kubectl get pods' })).toBe(true);
    expect(rules.alreadyAllowed([{ capability: 'fs_write', effect: 'allow' }], 'str_replace', { path: 'a' })).toBe(true);
    expect(rules.alreadyAllowed(npmTest, 'shell', { command: 'npm test' })).toBe(true);
    expect(rules.alreadyAllowed(npmTest, 'shell', { command: 'npm test -- --run' })).toBe(true);
    expect(rules.alreadyAllowed(npmTest, 'shell', { command: 'npm test && npm test x' })).toBe(true);
    // Outro comando junto, prefixo parecido, subshell, outra capability, deny ou exclude: o escritório pergunta.
    for (const c of ['npm test && rm -rf x', 'npm testx', 'npm test $(id)', 'npm test `id`', 'npm install', '']) expect(rules.alreadyAllowed(npmTest, 'shell', { command: c }), c).toBe(false);
    expect(rules.alreadyAllowed(npmTest, 'fs_write', { path: 'a' })).toBe(false);
    expect(rules.alreadyAllowed([...shellAll, { capability: 'shell', effect: 'deny', match: ['rm *'] }], 'shell', { command: 'ls' })).toBe(false);
    expect(rules.alreadyAllowed([{ capability: 'shell', effect: 'allow', exclude: ['rm *'] }], 'shell', { command: 'ls' })).toBe(false);
    expect(rules.alreadyAllowed([], 'shell', { command: 'ls' })).toBe(false);
    expect(rules.alreadyAllowed(shellAll, 'fs_read', {})).toBe(false);
  });

  it('com a regra já no arquivo do Kiro, o hook não manda cartão nenhum ao escritório', async () => {
    const { port, bodies } = await serveSeq([{ status: 201, body: { id: 'p-1' } }], { status: 'decided', behavior: 'deny' });
    const home = homeWithConfig({ approve: true, port });
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(home, '.kiro', 'settings', 'permissions.json'), JSON.stringify({ rules: [{ capability: 'shell', effect: 'allow', match: ['npm test *'] }] }));
    expect(await rules.run({ HOME: home }, pre('npm test'), { reloadWaitMs: 0 })).toBeUndefined();
    expect(bodies).toHaveLength(0);
    // Comando que a regra não cobre: o cartão volta (e a recusa vale).
    expect(await rules.run({ HOME: home }, pre('npm install'), { reloadWaitMs: 0 })).toMatchObject({ deny: expect.any(String) });
    expect(bodies).toHaveLength(1);
    // YAML que o Habblaud grava (linhas "- {json}") também vale.
    const yhome = homeWithConfig({ approve: true, port });
    mkdirSync(join(yhome, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(yhome, '.kiro', 'settings', 'permissions.yaml'), 'rules:\n  - {"capability":"shell","effect":"allow"}\n');
    expect(rules.readUserRules(join(yhome, '.kiro'))).toEqual([{ capability: 'shell', effect: 'allow' }]);
    expect(await rules.run({ HOME: yhome }, pre('ls'), { reloadWaitMs: 0 })).toBeUndefined();
    expect(bodies).toHaveLength(1);
  });

  it('KIRO_HOME vale para onde a regra vai; aprovar sem sugestão e recusar não gravam nada', async () => {
    const { port } = await serveSeq([{ status: 201, body: { id: 'p-1' } }], { status: 'decided', behavior: 'allow', suggestion: 1 });
    const home = homeWithConfig({ approve: true, port });
    const kiroHome = join(tmp(), 'kiro-alt');
    await rules.run({ HOME: home, KIRO_HOME: kiroHome }, pre('npm test'), { reloadWaitMs: 0 });
    expect(JSON.parse(readFileSync(join(kiroHome, 'settings', 'permissions.json'), 'utf8'))).toEqual({ rules: [{ capability: 'shell', effect: 'allow' }] });

    for (const decision of [{ status: 'decided', behavior: 'allow' }, { status: 'decided', behavior: 'deny', suggestion: 0 }, { status: 'decided', behavior: 'allow', suggestion: 7 }]) {
      const s = await serveSeq([{ status: 201, body: { id: 'p-1' } }], decision);
      const hm = homeWithConfig({ approve: true, port: s.port });
      await rules.run({ HOME: hm }, pre('npm test'), { reloadWaitMs: 0 });
      expect(existsSync(join(hm, '.kiro', 'settings')), JSON.stringify(decision)).toBe(false);
    }
  });

  it('sessão ainda desconhecida: tenta registrar de novo (o evento que cria o agente pode estar chegando)', async () => {
    const { port, bodies } = await serveSeq(
      [
        { status: 200, body: { skip: 'unknown-session' } },
        { status: 201, body: { id: 'p-1' } },
      ],
      { status: 'decided', behavior: 'deny', message: 'não' },
    );
    const home = homeWithConfig({ approve: true, port });
    expect(await rules.run({ HOME: home }, pre('npm test'), { retryMs: 10 })).toEqual({ deny: 'Recusado pelo usuário no Habblaud: não' });
    expect(bodies).toHaveLength(2);
  });

  it('sem página aberta: não insiste (um registro só)', async () => {
    const { port, bodies } = await serveSeq([{ status: 200, body: { skip: 'no-viewers' } }], { status: 'pending' });
    const home = homeWithConfig({ approve: true, port });
    expect(await rules.run({ HOME: home }, pre('npm test'), { retryMs: 10 })).toBeUndefined();
    expect(bodies).toHaveLength(1);
  });
});

describe('instalador: teto do hook e regras no uninstall', () => {
  it('o teto do Kiro acompanha a espera configurada (--espera maior que 300 s não é morta no meio)', () => {
    expect(inst2.approvalTimeoutMs()).toBe(inst.APPROVAL_TIMEOUT_MS);
    expect(inst2.approvalTimeoutMs(600)).toBe(610_000);
    const file = (inst as unknown as { v3File(c: string, a?: string, w?: number): { hooks: Rec[] } }).v3File('o', 'a', 900);
    expect(file.hooks.find((x) => x.name === 'habblaud-approval')?.timeout).toBe(910);
    expect((inst as unknown as { approvalEntry(c: string, w?: number): Rec }).approvalEntry('a', 900).timeout_ms).toBe(910_000);
  });

  it('uninstall tira as regras gravadas pelo escritório (com backup) e apaga a anotação', async () => {
    const home = tmp();
    const kiro = join(home, '.kiro');
    const R = { capability: 'shell', effect: 'allow', match: ['npm test *'] };
    const { file } = await rules.persistRule(kiro, R);
    const mine = { capability: 'fs_read', effect: 'allow' };
    writeFileSync(file, JSON.stringify({ rules: [mine, R] }));
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(join(home, '.habblaud', rules.LEDGER_FILE), JSON.stringify({ rules: [{ file, rule: R }] }));
    const lines: string[] = [];
    const code = await inst.run({ command: 'uninstall', format: 'v3' }, { home, env: {}, out: (l: string) => lines.push(l), nodeBin: '/n/node', platform: 'linux' });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ rules: [mine] });
    expect(existsSync(join(home, '.habblaud', rules.LEDGER_FILE))).toBe(false);
    expect(readdirSync(join(kiro, 'settings')).some((f) => f.includes('habblaud-backup-'))).toBe(true);
    expect(lines.join('\n')).toContain('1 regra(s) do Habblaud removida(s)');
  });
});
