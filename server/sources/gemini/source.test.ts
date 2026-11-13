import { describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { describeGeminiTool, GeminiSource, IDLE_TTL_MS, WORKING_QUIET_MS } from './source';
import { parseJsonc, withOurs, withoutOurs } from '../../../scripts/gemini-install';

const SID = '6f1c2a3b-1111-4222-8333-944455556666';

function setup() {
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/tmp/h', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new GeminiSource({ accounts, office, configDir: '/tmp/h/.gemini', now });
  const ev = (name: string, extra: Record<string, unknown> = {}) =>
    source.applyHookEvent(undefined, { hook_event_name: name, session_id: SID, cwd: '/tmp/projeto', ...extra });
  const agent = () => office.get(`.gemini:${SID}`);
  return { accounts, office, source, ev, agent, advance: (ms: number) => (clock += ms) };
}

describe('describeGeminiTool', () => {
  it('traduz as ferramentas do Gemini CLI', () => {
    expect(describeGeminiTool('read_file', { file_path: '/a/b/app.ts' }).desc.kind).toBe('read');
    expect(describeGeminiTool('replace', { file_path: '/a/b/app.ts' }).desc.kind).toBe('edit');
    expect(describeGeminiTool('write_file', { file_path: '/a/novo.ts' }).desc.kind).toBe('write');
    expect(describeGeminiTool('run_shell_command', { command: 'npm test' }).tool).toBe('Bash');
    expect(describeGeminiTool('google_web_search', { query: 'x' }).desc.kind).toBe('web');
    expect(describeGeminiTool('mcp_github_list_issues', {}).tool).toBe('mcp_github_list_issues');
  });
});

describe('GeminiSource', () => {
  it('registra a conta do Gemini', () => {
    const { accounts } = setup();
    const e = accounts.entriesOf('gemini');
    expect(e).toHaveLength(1);
    expect(e[0].detected.short).toBe('G');
    expect(e[0].provider).toBe('gemini');
  });

  it('entra no escritório, trabalha, pede aprovação, termina e sai', () => {
    const { ev, agent } = setup();
    expect(ev('SessionStart', { source: 'startup' })).toBe(true);
    expect(agent()?.provider).toBe('gemini');
    expect(agent()?.status).toBe('idle');
    ev('BeforeAgent', { prompt: 'corrija o teste' });
    expect(agent()?.status).toBe('working');
    ev('BeforeTool', { tool_name: 'read_file', tool_input: { file_path: '/tmp/projeto/a.ts' } });
    expect(agent()?.activity?.kind).toBe('read');
    ev('Notification', { notification_type: 'ToolPermission', details: { tool_name: 'run_shell_command' } });
    expect(agent()?.status).toBe('waiting');
    ev('AfterTool', { tool_name: 'run_shell_command', tool_response: {} });
    expect(agent()?.status).toBe('working');
    ev('AfterAgent', {});
    expect(agent()?.status).toBe('idle');
    ev('SessionEnd', { reason: 'exit' });
    expect(agent()?.status ?? 'offline').toBe('offline');
  });

  it('ignora eventos desconhecidos e sessões sem id', () => {
    const { source } = setup();
    expect(source.applyHookEvent(undefined, { hook_event_name: 'BeforeModel', session_id: SID })).toBe(false);
    expect(source.applyHookEvent(undefined, { hook_event_name: 'BeforeTool', session_id: '../x' })).toBe(false);
  });

  it('turno morto volta a ocioso e sessão esquecida sai', () => {
    const { ev, agent, source, advance } = setup();
    ev('BeforeAgent', { prompt: 'oi' });
    advance(WORKING_QUIET_MS + 1);
    source.sweep();
    expect(agent()?.status).toBe('idle');
    advance(IDLE_TTL_MS + 1);
    source.sweep();
    expect(agent()?.status ?? 'offline').toBe('offline');
  });
});

describe('gemini-install', () => {
  it('acrescenta e tira só os hooks do Habblaud', () => {
    const mine = { matcher: 'write_.*', hooks: [{ name: 'meu', type: 'command', command: 'echo' }] };
    const added = withOurs({ BeforeTool: [mine] }, '"node" "/x/mod/habblaud-gemini/hook.mjs"');
    expect((added.BeforeTool as unknown[]).length).toBe(2);
    expect(Object.keys(added)).toContain('SessionEnd');
    const again = withOurs(added, '"node" "/x/mod/habblaud-gemini/hook.mjs"');
    expect((again.BeforeTool as unknown[]).length).toBe(2);
    expect(withoutOurs(again)).toEqual({ BeforeTool: [mine] });
  });

  it('lê settings.json com comentários', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,],\n}')).toEqual({ a: 'http://x', b: [1] });
  });
});
