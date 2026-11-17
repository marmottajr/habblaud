import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHabblaudHookSpec, HOOK_KEY, parseArgs, planInstall, planUninstall, run as runInstaller } from '../../scripts/antigravity-install';

interface AntigravityHookModule {
  antigravityHomeOf(env: NodeJS.ProcessEnv, input: unknown): string;
  run(env: NodeJS.ProcessEnv, stdinText?: string): Promise<Record<string, unknown>>;
}

const HOOK_PATH = resolve(__dirname, '../../mod/habblaud-antigravity/hook.mjs');
const loadHook = () => import(pathToFileURL(HOOK_PATH).href) as Promise<AntigravityHookModule>;

const dirsToClean: string[] = [];
afterEach(() => {
  while (dirsToClean.length) {
    rmSync(dirsToClean.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-agy-inst-'));
  dirsToClean.push(d);
  return d;
}

describe('antigravity-install e mod/habblaud-antigravity/hook.mjs', () => {
  it('planInstall e planUninstall gerenciam a chave "habblaud" em hooks.json preservando outros hooks', () => {
    const cmd = 'node "/app/mod/habblaud-antigravity/hook.mjs"';
    const initial = {
      'lint-checker': {
        PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }],
      },
    };
    const installed = planInstall(initial, cmd);
    expect(installed.action).toBe('install');
    if (installed.action !== 'install') return;
    expect(installed.file['lint-checker']).toEqual(initial['lint-checker']);
    expect(installed.file[HOOK_KEY]).toEqual(buildHabblaudHookSpec(cmd));

    expect(planInstall(installed.file, cmd)).toEqual({ action: 'none', message: 'já instalado' });

    const uninstalled = planUninstall(installed.file);
    expect(uninstalled.action).toBe('uninstall');
    if (uninstalled.action !== 'uninstall') return;
    expect(uninstalled.file).toEqual(initial);
  });

  it('run(install/status/uninstall) grava ~/.gemini/config/hooks.json e ~/.habblaud/antigravity-hook.json', async () => {
    const home = makeTempDir();
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'brain'), { recursive: true });
    const lines: string[] = [];
    const ctx = {
      env: { HOME: home },
      home,
      now: new Date('2026-11-17T03:00:00Z'),
      hookPath: '/app/mod/habblaud-antigravity/hook.mjs',
      out: (l: string) => lines.push(l),
      nodeProbe: () => 'v24.0.0',
    };

    const instOpts = parseArgs(['install', '--port', '4848'], ctx.env);
    expect(instOpts).not.toBe('help');
    if (instOpts === 'help') return;
    expect(await runInstaller(instOpts, ctx)).toBe(0);

    const hooksFile = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8')) as Record<string, unknown>;
    expect(hooksFile[HOOK_KEY]).toBeDefined();
    const cfgFile = JSON.parse(readFileSync(join(home, '.habblaud', 'antigravity-hook.json'), 'utf8')) as { port: number };
    expect(cfgFile.port).toBe(4848);
    const agySettings = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as { statusLine?: { command?: string } };
    expect(agySettings.statusLine?.command).toContain('statusline-tap.mjs');

    const statusOpts = parseArgs(['status'], ctx.env);
    if (statusOpts !== 'help') expect(await runInstaller(statusOpts, ctx)).toBe(0);

    const uninstOpts = parseArgs(['uninstall'], ctx.env);
    if (uninstOpts !== 'help') expect(await runInstaller(uninstOpts, ctx)).toBe(0);
    const afterFile = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8')) as Record<string, unknown>;
    expect(afterFile[HOOK_KEY]).toBeUndefined();
    const afterSettings = JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(afterSettings.statusLine).toBeUndefined();
  });

  it('hook.mjs deduz a pasta do Antigravity pelo transcriptPath e devolve {} sem travar quando o servidor está desligado', async () => {
    const { antigravityHomeOf, run: runHook } = await loadHook();
    const home = makeTempDir();
    writeFileSync(join(home, 'dummy'), '');
    const agyHome = antigravityHomeOf(
      { HOME: home },
      { transcriptPath: `${home}/.gemini/antigravity-cli/brain/083423ec-018b-4b39-bc54-bc0d6da230b3/.system_generated/logs/transcript.jsonl` },
    );
    expect(agyHome).toBe(join(home, '.gemini', 'antigravity-cli'));

    const out = await runHook(
      { HOME: home, HABBLAUD_PORT: '59999' },
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: '083423ec-018b-4b39-bc54-bc0d6da230b3',
        cwd: '/home/diluca/habblaud',
        toolCall: { id: 'tc1', name: 'run_command', args: { CommandLine: 'npm test' } },
      }),
    );
    expect(out).toEqual({});
  });
});
