import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { detectAntigravityAccounts, discoverAntigravityDirs } from './accounts';
import { parseAnnotationPbtxt } from './files';
import { AntigravityHistory } from './history';
import { AntigravitySource } from './source';
import { createAntigravityTerminalParser } from './terminal';
import { cleanPromptText, createAntigravityState, describeAntigravityTool, parseAntigravityLine, unwrapArgs } from './transcript';

const CONV_MAIN = '083423ec-018b-4b39-bc54-bc0d6da230b3';
const CONV_SUB = '8c3038dd-d256-43eb-bb8d-06eb652fabf0';

const dirsToClean: string[] = [];
afterEach(() => {
  while (dirsToClean.length) {
    const d = dirsToClean.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-agy-'));
  dirsToClean.push(d);
  return d;
}

describe('Antigravity CLI — contas, transcript, terminal, histórico e fonte', () => {
  it('descobre ~/.gemini/antigravity-cli e atribui a letra G sem colidir com outras contas', () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(join(agyDir, 'brain'), { recursive: true });
    mkdirSync(join(agyDir, 'conversations'), { recursive: true });

    const found = discoverAntigravityDirs({ HOME: home }, home);
    expect(found).toEqual([agyDir]);

    const accs = detectAntigravityAccounts(found, { home, env: { HOME: home }, taken: { shorts: ['C', 'X'], colors: ['#f08a3c'] } });
    expect(accs).toEqual([
      {
        id: 'antigravity-cli',
        provider: 'antigravity',
        configDir: agyDir,
        short: 'G',
        name: 'Antigravity',
        color: '#4aa8e8',
      },
    ]);
  });

  it('unwrapArgs e cleanPromptText desembrulham argumentos JSON-stringified e limpam tags do USER_INPUT', () => {
    const args = unwrapArgs({
      CommandLine: '"npm test"',
      WaitMsBeforeAsync: '5000',
      IsDaemon: 'false',
      Truncated: '"linha 1\\nlinha 2\n<truncated 120 bytes>',
    });
    expect(args).toEqual({
      CommandLine: 'npm test',
      WaitMsBeforeAsync: 5000,
      IsDaemon: false,
      Truncated: 'linha 1\nlinha 2',
    });

    const prompt = cleanPromptText(
      '<USER_REQUEST>\nimplemente compatibilidade com antigravity cli\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026\n</ADDITIONAL_METADATA>',
    );
    expect(prompt).toBe('implemente compatibilidade com antigravity cli');
    expect(parseAnnotationPbtxt('title:"Add Antigravity CLI Compatibility"')).toBe('Add Antigravity CLI Compatibility');
  });

  it('describeAntigravityTool traduz ferramentas do Antigravity para atividades do Habblaud', () => {
    expect(describeAntigravityTool('run_command', { CommandLine: '"vitest run"', toolSummary: '"Run unit tests"' }).tool).toBe('Bash');
    expect(describeAntigravityTool('read_file', { Path: '"/app/server/index.ts"' }).tool).toBe('Read');
    expect(describeAntigravityTool('write_file', { Path: '"/app/novo.ts"' }).tool).toBe('Write');
    expect(describeAntigravityTool('edit_file', { Path: '"/app/server/index.ts"' }).tool).toBe('Edit');
    expect(describeAntigravityTool('grep_search', { Query: '"Provider"', SearchPath: '"/app"' }).tool).toBe('Grep');
    expect(describeAntigravityTool('find_by_name', { Pattern: '"*.ts"', SearchDirectory: '"/app"' }).tool).toBe('Glob');
    expect(describeAntigravityTool('search_web', { query: '"antigravity cli docs"' }).tool).toBe('WebSearch');
    expect(describeAntigravityTool('invoke_subagent', { TypeName: '"research"', Role: '"Codebase Researcher"' }).tool).toBe('Agent');
    expect(describeAntigravityTool('call_mcp_tool', { ServerName: '"github"', ToolName: '"create_pull_request"', Arguments: '{"title":"feat"}' }).tool).toBe(
      'mcp__github__create_pull_request',
    );
  });

  it('parseAntigravityLine e createAntigravityTerminalParser interpretam passos sem duplicar tokens em releituras', () => {
    const state = createAntigravityState();
    const parser = createAntigravityTerminalParser();
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-17T03:01:33Z',
        content: '<USER_REQUEST>\nCorrija o teste\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-17T03:01:35Z',
        model: 'gemini-4-argon-medium',
        input_tokens: 1000,
        cache_read_tokens: 500,
        output_tokens: 120,
        thinking: 'Vou rodar os testes.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', WaitMsBeforeAsync: '5000' } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-17T03:01:40Z',
        content: 'Created At: 2026-11-17T00:01:35-03:00\nCompleted At: 2026-11-17T00:01:40-03:00\nCommand exited with code 0.\n\nCommand output:\nPASS all tests',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-17T03:01:42Z',
        model: 'gemini-4-argon-medium',
        input_tokens: 1200,
        cache_read_tokens: 500,
        output_tokens: 80,
        content: 'Pronto, todos os testes passaram!',
      }),
    ];

    const entries = lines.flatMap((l) => {
      parseAntigravityLine(state, l, { idPrefix: 'agy:1', now: 1_794_884_500_000 });
      return parser.push(l);
    });
    // Releitura da linha 1 não soma tokens nem toolCalls de novo
    parseAntigravityLine(state, lines[1], { idPrefix: 'agy:1', now: 1_794_884_500_000 });

    expect(state.title).toBe('Corrija o teste');
    expect(state.model).toBe('gemini-4-argon-medium');
    expect(state.turnOpen).toBe(false);
    expect(state.stats).toEqual({
      toolCalls: 1,
      tokensIn: 3200,
      tokensOut: 200,
      subagents: 0,
    });
    expect(entries.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'assistant']);
  });

  it('AntigravitySource e AntigravityHistory acompanham sessão aberta (WAL + history/annotations + hooks) e subagentes', async () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    const convDir = join(agyDir, 'conversations');
    const annDir = join(agyDir, 'annotations');
    const logDir = join(agyDir, 'brain', CONV_MAIN, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(annDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(convDir, `${CONV_MAIN}.db-wal`), '');
    writeFileSync(join(annDir, `${CONV_MAIN}.pbtxt`), 'title:"Compatibilidade Antigravity"');
    writeFileSync(
      join(agyDir, 'history.jsonl'),
      `${JSON.stringify({ display: 'oi', timestamp: 1_794_884_493_000, workspace: '/home/diluca/habblaud', conversationId: CONV_MAIN })}\n`,
    );
    writeFileSync(
      join(logDir, 'transcript.jsonl'),
      `${JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-17T03:01:33Z',
        content: '<USER_REQUEST>\nOlá Antigravity\n</USER_REQUEST>',
      })}\n`,
    );

    const accounts = new AccountsService({ dirs: [], home, env: { HOME: home }, onChange: () => {} });
    const office = new Office({
      names: new NameStore(join(home, 'names.json')),
      version: '1.0.3',
      startedAt: 1_794_884_490_000,
      accounts: (s) => accounts.list(s),
      sources: () => src.sources(),
      accountName: (id) => accounts.find(id)?.detected.name,
      terminal: true,
      permissions: () => new Map(),
      ptys: () => ({ status: { enabled: false }, list: [] }),
    });
    const src = new AntigravitySource({ accounts, office, dirs: [agyDir], home, watch: false });
    src.boot();

    let snap = office.commit().snapshot;
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0]).toMatchObject({
      id: `antigravity-cli:${CONV_MAIN}`,
      provider: 'antigravity',
      account: 'antigravity-cli',
      roomId: '/home/diluca/habblaud',
      title: 'Compatibilidade Antigravity',
      status: 'working',
    });

    // Evento de hook de um subagente e depois Stop
    expect(
      src.applyHookEvent('antigravity-cli', {
        hookEventName: 'PreToolUse',
        conversationId: CONV_SUB,
        parentConversationId: CONV_MAIN,
        agentName: 'Codebase Researcher',
        cwd: '/home/diluca/habblaud',
        toolCall: { id: 'tc1', name: 'read_file', args: { Path: '/home/diluca/habblaud/README.md' } },
      }),
    ).toBe(true);

    snap = office.commit().snapshot;
    expect(snap.agents).toHaveLength(2);
    const sub = snap.agents.find((a) => a.kind === 'sub')!;
    expect(sub).toMatchObject({
      id: `antigravity-cli:${CONV_SUB}`,
      parentId: `antigravity-cli:${CONV_MAIN}`,
      role: 'Codebase Researcher',
      status: 'working',
    });

    const hist = new AntigravityHistory({
      accounts: () => accounts.entriesOf('antigravity'),
      openAgentOf: (acc, sid) => snap.agents.find((a) => a.account === acc && a.sessionId === sid)?.id,
    });
    const recent = await hist.list();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      account: 'antigravity-cli',
      provider: 'antigravity',
      sessionId: CONV_MAIN,
      project: '/home/diluca/habblaud',
      title: 'Compatibilidade Antigravity',
      open: true,
    });
  });
});
