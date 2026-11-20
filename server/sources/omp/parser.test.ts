// Parser do transcript do omp com linhas REAIS do omp 18.12.2 (fixtures/, texto de conversa trocado por `…`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOmpState, describeOmpTool, parseOmpHead, parseOmpLine, projectDir, toolPaths, type OmpHead, type OmpLineResult, type OmpSignal, type OmpState } from './parser';

const FIX = join(import.meta.dirname, 'fixtures');
const text = (name: string) => readFileSync(join(FIX, name), 'utf8');

interface Run {
  state: OmpState;
  results: OmpLineResult[];
  signals: OmpSignal[];
  head: OmpHead;
}

/** Lê o arquivo como a fonte: começo (linhas 1-2) e depois o resto, linha a linha. */
function run(name: string): Run {
  const raw = text(name);
  const head = parseOmpHead(raw);
  const state = createOmpState(head);
  const rest = raw.slice(head.bytes).split('\n').filter(Boolean);
  const results = rest.map((l) => parseOmpLine(state, l, { idPrefix: 'omp:t', now: 1 }));
  return { state, results, signals: results.flatMap((r) => r.signals), head };
}

describe('cabeçalho', () => {
  it('slot de título (linha 1) + session (linha 2): id, cwd, sem parentSession no principal', () => {
    const { head } = run('main-clean-exit.jsonl');
    expect(head.header).toMatchObject({ id: '01a12d9e-b033-7000-a6b5-5c32fc303cf1', cwd: 'D:\\proj' });
    expect(head.header?.parentSession).toBeUndefined();
    expect(head.header?.startedAt).toBe(Date.parse('2026-10-12T00:58:56.948Z'));
    const firstTwo = text('main-clean-exit.jsonl').split('\n').slice(0, 2).join('\n') + '\n';
    expect(head.bytes).toBe(Buffer.byteLength(firstTwo));
  });

  it('subagente: parentSession aponta o arquivo do pai', () => {
    const { head } = run('sub-ArchScout.jsonl');
    expect(head.header?.parentSession).toMatch(/01a13a52-fa11-7000-b7af-bfa3171c863d\.jsonl$/);
    expect(head.header?.cwd).toBe('C:\\Users\\dev\\proj');
  });

  it('título do slot vale (e o slot vazio não vale); sem duas linhas completas = sem cabeçalho', () => {
    expect(run('main-task.jsonl').head.title).toBe('Título');
    expect(run('main-clean-exit.jsonl').head.title).toBeUndefined();
    expect(parseOmpHead('{"type":"title"')).toEqual({ bytes: 0 });
    expect(parseOmpHead('{"type":"title","title":""}\n{"type":"session"')).toEqual({ bytes: 0 });
    expect(parseOmpHead('{"type":"title","title":""}\n{"type":"session","id":"x"}\n').header).toBeUndefined();
  });
});

describe('saída limpa (session_exit)', () => {
  const r = run('main-clean-exit.jsonl');

  it('turno: user abre, stop fecha; session_exit fica sinalizado', () => {
    const types = r.signals.map((s) => s.type);
    expect(types).toContain('turnStart');
    expect(types).toContain('turnEnd');
    expect(types.at(-1)).toBe('exit');
    expect(r.state.exited).toBe(true);
    expect(r.state.turnOpen).toBe(false);
  });

  it('atividade de bash com o comando, "Concluiu"; título pela primeira instrução', () => {
    const acts = r.results.flatMap((x) => x.activities.map((a) => a.activity));
    const bash = acts.find((a) => a.tool === 'Bash');
    expect(bash?.kind).toBe('git');
    expect(bash?.detail).toContain('git status');
    expect(acts.some((a) => a.kind === 'done')).toBe(true);
    expect(acts.every((a) => a.id.startsWith('omp:t#'))).toBe(true);
    expect(r.state.title).toBe('…');
  });

  it('soma os tokens das respostas (entrada = input + cacheRead + cacheWrite) e conta ferramentas', () => {
    const usages = r.signals.filter((s): s is Extract<OmpSignal, { type: 'usage' }> => s.type === 'usage');
    expect(usages.length).toBeGreaterThanOrEqual(3);
    expect(r.state.stats.tokensIn).toBe(usages.reduce((n, u) => n + u.tokensIn, 0));
    expect(r.state.stats.tokensOut).toBe(usages.reduce((n, u) => n + u.tokensOut, 0));
    expect(usages[0]).toMatchObject({ tokensIn: 4 + 15419, tokensOut: 95 });
    expect(r.state.stats.toolCalls).toBe(2);
  });

  it('modelo da última resposta (vale mais que o model_change), com o provedor como no model_change', () => {
    expect(r.state.model).toBe('anthropic/claude-sonnet-5-5');
  });

  it('thinking_level_change (linha real do omp 18.12.6) vira thinking', () => {
    const state = createOmpState();
    const line = '{"type":"thinking_level_change","id":"6fcd91f3","parentId":null,"timestamp":"2026-10-24T14:14:42.698Z","configured":"low","thinkingLevel":"low"}';
    const res = parseOmpLine(state, line, { idPrefix: 'omp:t', now: 1 });
    expect(state.thinking).toBe('low');
    expect(res.changed).toBe(true);
  });

  it('o mesmo arquivo lido de novo gera os mesmos ids (o Office não duplica)', () => {
    const again = run('main-clean-exit.jsonl');
    const ids = (x: Run) => x.results.flatMap((y) => y.activities.map((a) => a.activity.id));
    expect(ids(again)).toEqual(ids(r));
    expect(new Set(ids(r)).size).toBe(ids(r).length);
  });
});

describe('ferramentas do omp', () => {
  const r = run('main-tools.jsonl');
  const acts = r.results.flatMap((x) => x.activities.map((a) => a.activity));
  const byTool = (tool: string) => acts.find((a) => a.tool === tool);

  it('cada ferramenta vira o vocabulário do escritório', () => {
    expect(byTool('Bash')).toMatchObject({ kind: 'git' });
    expect(byTool('Read')).toMatchObject({ kind: 'read', detail: 'src/app.ts' });
    expect(byTool('Grep')).toMatchObject({ kind: 'search', detail: 'TODO' });
    expect(byTool('Glob')).toMatchObject({ kind: 'search' });
    expect(byTool('Edit')).toMatchObject({ kind: 'edit', detail: 'src/app.ts' });
    expect(byTool('Write')).toMatchObject({ kind: 'write', detail: 'src/novo.ts' });
    expect(byTool('WebSearch')).toMatchObject({ kind: 'web' });
    expect(byTool('Agent')).toMatchObject({ kind: 'delegate' });
    expect(byTool('eval')).toMatchObject({ kind: 'run' });
    expect(byTool('ask')).toMatchObject({ kind: 'ask' });
    expect(byTool('wait')).toMatchObject({ kind: 'delegate' });
  });

  it('ask não leva perguntas respondíveis (o omp pergunta no terminal)', () => {
    expect(byTool('ask')).not.toHaveProperty('questions');
  });

  it('task conta os subagentes', () => {
    expect(r.state.stats.subagents).toBeGreaterThan(0);
  });

  it('title_change atualiza o título e sinaliza', () => {
    expect(r.state.title).toBe('Título da sessão');
    expect(r.signals.find((s) => s.type === 'title')).toEqual({ type: 'title', title: 'Título da sessão' });
  });

  it('descrições de ferramentas direto da tabela', () => {
    expect(describeOmpTool('read', { path: 'src/a.ts:10-20' }).desc.detail).toBe('src/a.ts');
    expect(describeOmpTool('edit', { input: '[a.ts#AB12]\nPUT 1.=1:\n+x\n[b.ts#CD34]\nPUT 2.=2:\n+y' }).desc.detail).toBe('a.ts, b.ts');
    expect(describeOmpTool('ast_edit', { path: 'src/x.ts' })).toMatchObject({ tool: 'Edit' });
    expect(describeOmpTool('fetch', { url: 'https://exemplo.com/x' }).desc.text).toContain('exemplo.com');
    expect(describeOmpTool('ferramenta_nova', {})).toMatchObject({ tool: 'ferramenta_nova', desc: { kind: 'other' } });
  });
});

describe('stopReason', () => {
  it('erro fecha o turno com atividade de erro (só no histórico) e sem "Concluiu"', () => {
    const r = run('main-error.jsonl');
    expect(r.signals.filter((s) => s.type === 'turnEnd').length).toBeGreaterThanOrEqual(1);
    expect(r.state.turnOpen).toBe(false);
    const last = r.results.at(-1)!;
    expect(last.activities.map((a) => a.activity.kind)).toEqual(['error']);
    expect(last.activities[0].current).toBe(false);
    expect(last.signals).toContainEqual({ type: 'turnEnd', aborted: false });
  });

  it('aborted fecha o turno como interrompido; length conta como fim', () => {
    const s = createOmpState();
    const line = (extra: object) => JSON.stringify({ type: 'message', id: 'aa11', timestamp: '2026-10-14T14:22:22.141Z', message: { role: 'assistant', content: [], ...extra } });
    const aborted = parseOmpLine(s, line({ stopReason: 'aborted' }), { idPrefix: 'p', now: 1 });
    expect(aborted.signals).toContainEqual({ type: 'turnEnd', aborted: true });
    expect(aborted.activities[0].activity.text).toMatch(/Interrompido/);
    const length = parseOmpLine(s, line({ stopReason: 'length' }), { idPrefix: 'p', now: 1 });
    expect(length.signals).toContainEqual({ type: 'turnEnd', aborted: false });
  });
});

describe('subagente', () => {
  it('lê o transcript do subagente: turno, ferramentas e session_exit', () => {
    const r = run('sub-ArchScout.jsonl');
    expect(r.signals.map((s) => s.type)).toContain('turnStart');
    expect(r.signals.at(-1)?.type).toBe('exit');
    expect(r.state.exited).toBe(true);
    expect(r.state.stats.toolCalls).toBeGreaterThan(0);
  });
});

describe('robustez', () => {
  it('linhas inválidas e tipos desconhecidos não geram nada; conversa depois de session_exit reabre', () => {
    const s = createOmpState();
    const ctx = { idPrefix: 'p', now: 5 };
    expect(parseOmpLine(s, '{quebrado', ctx)).toMatchObject({ activities: [], signals: [], at: 5 });
    expect(parseOmpLine(s, '[1]', ctx).signals).toEqual([]);
    for (const type of ['thinking_level_change', 'credential_pin', 'mode_change', 'tipo_futuro']) {
      expect(parseOmpLine(s, JSON.stringify({ type, id: 'x' }), ctx).signals).toEqual([]);
    }
    parseOmpLine(s, JSON.stringify({ type: 'custom', customType: 'session_exit', timestamp: '2026-10-14T14:00:00Z' }), ctx);
    expect(s.exited).toBe(true);
    parseOmpLine(s, JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'volta' }] } }), ctx);
    expect(s.exited).toBe(false);
  });

  it('prompt injetado pelo omp (attribution agent) abre turno mas não vira título nem atividade', () => {
    const s = createOmpState();
    const r = parseOmpLine(s, JSON.stringify({ type: 'message', id: 'b1', message: { role: 'user', attribution: 'agent', content: [{ type: 'text', text: 'lembrete' }] } }), { idPrefix: 'p', now: 1 });
    expect(r.signals).toEqual([{ type: 'turnStart' }]);
    expect(r.activities).toEqual([]);
    expect(s.title).toBeUndefined();
  });
});

describe('projectDir (sala segue o projeto)', () => {
  const root = '/home/u/dev';
  const f = (path: string) => ({ path, dir: false });
  const d = (path: string) => ({ path, dir: true });

  it('sem caminhos, fora do cwd ou arquivo solto na raiz: fica no cwd', () => {
    expect(projectDir(root, [])).toBe(root);
    expect(projectDir(root, [f('/etc/hosts'), f('README.md'), f('../x/y.ts'), f('/home/u/devx/a/b')])).toBe(root);
    expect(projectDir(root, [f('https://github.com/a/b'), f('skill://x/SKILL.md'), d('local://plan.md')])).toBe(root);
  });

  it('subdiretório mais citado vence; empate vai para o mais recente', () => {
    expect(projectDir(root, [f('a/x.ts'), f('/home/u/dev/a/y.ts'), d('b')])).toBe(`${root}/a`);
    expect(projectDir(root, [f('a/x.ts'), d('/home/u/dev/b')])).toBe(`${root}/b`);
  });

  it('toolPaths: cwd do bash, path com seletor do read e [arquivo#TAG] do edit', () => {
    expect(toolPaths({ cwd: 'xbi2', command: 'ls' })).toEqual([d('xbi2')]);
    expect(toolPaths({ path: 'gowa/src/a.ts:50-80;outro' })).toEqual([f('gowa/src/a.ts')]);
    expect(toolPaths({ input: '[/home/u/dev/yt/main.py#A1B2]\nPUT 1.=1:\n+x' })).toEqual([f('/home/u/dev/yt/main.py')]);
  });

  it('o parser guarda só as últimas 5 citações', () => {
    const s = createOmpState();
    const call = (path: string) =>
      JSON.stringify({ type: 'message', timestamp: '2026-10-24T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: path, name: 'read', arguments: { path } }], stopReason: 'toolUse' } });
    for (const p of ['a/1', 'a/2', 'a/3', 'b/1', 'b/2', 'b/3']) parseOmpLine(s, call(p), { idPrefix: 'k', now: 0 });
    expect(s.paths.map((p) => p.path)).toEqual(['a/2', 'a/3', 'b/1', 'b/2', 'b/3']);
    expect(projectDir(root, s.paths)).toBe(`${root}/b`);
  });
});
