import { describe, expect, it } from 'vitest';
import { applyKiroTodo, applyKiroV3Line, createKiroV3State, diffLineCounts, kiroEditLines, kiroSubTitle, kiroV3Text } from './v3parser';

// Dados sintéticos no formato do messages.jsonl do Kiro CLI 3.x.
const T0 = Date.parse('2030-01-02T10:00:00.000Z');
let n = 0;
const row = (payload: Record<string, unknown>, ms = 0) => JSON.stringify({ id: `m${++n}`, timestamp: new Date(T0 + ms).toISOString(), payload });
const run = (state = createKiroV3State()) => ({ state, line: (p: Record<string, unknown>, ms = 0) => applyKiroV3Line(state, row(p, ms), { idPrefix: 'sess_x' }) });

describe('applyKiroV3Line', () => {
  it('user -> pedido e trabalhando; assistant Say/Reasoning; turn_end -> ocioso', () => {
    const { line } = run();
    const u = line({ type: 'user', content: 'Arrume o teste do login' });
    expect(u).toMatchObject({ status: 'working', promptText: 'Arrume o teste do login', at: T0 });
    expect(u?.activities[0]).toMatchObject({ kind: 'prompt', at: T0 });
    expect(line({ type: 'turn_start', turnId: 't1' })?.status).toBe('working');
    expect(line({ type: 'assistant', content: '', operationType: 'Reasoning' })?.activities[0].kind).toBe('think');
    expect(line({ type: 'assistant', content: 'Pronto.', operationType: 'Say' })?.activities[0].kind).toBe('respond');
    const end = line({ type: 'turn_end', turnId: 't1', stopReason: 'end_turn' });
    expect(end?.status).toBe('idle');
    expect(end?.shells).toEqual([{ type: 'turnEnd' }]);
    expect(end?.activities).toEqual([]);
  });

  it('turn_end cancelado vira "interrompido"; displayError vira erro', () => {
    const { line } = run();
    expect(line({ type: 'turn_end', stopReason: 'cancelled' })?.activities[0].text).toContain('Interrompido');
    const e = line({ type: 'session_metadata', key: 'displayError', value: { message: 'falhou o modelo', errorType: 'x' } });
    expect(e?.activities[0]).toMatchObject({ kind: 'error', error: true });
    expect(line({ type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: 12 } })).toBeUndefined();
  });

  it('ruído e linhas inválidas são ignorados', () => {
    const { line } = run();
    for (const type of ['ContextualHookInvoked', 'steering_inclusion', 'session_event', 'agent_note']) expect(line({ type })).toBeUndefined();
    expect(applyKiroV3Line(createKiroV3State(), '{nope')).toBeUndefined();
    expect(applyKiroV3Line(createKiroV3State(), JSON.stringify({ id: 'a' }))).toBeUndefined();
  });

  it('tool_call conta ferramenta uma vez só; tool_result com success:false vira erro', () => {
    const { state, line } = run();
    const c = line({ type: 'tool_call', toolCallId: 'tc1', toolName: 'fs_read', args: { path: '/p/a.ts' }, status: 'completed' });
    expect(c?.activities[0]).toMatchObject({ id: 'sess_x#tc1', tool: 'fs_read' });
    line({ type: 'tool_call', toolCallId: 'tc1', toolName: 'fs_read', args: { path: '/p/a.ts' }, status: 'completed' });
    expect(state.stats.toolCalls).toBe(1);
    const r = line({ type: 'tool_result', toolCallId: 'tc1', content: 'nope', success: false });
    expect(r?.activities[0]).toMatchObject({ kind: 'error', error: true });
    expect(r?.status).toBe('working');
  });

  it('pending_interaction tool_approval -> esperando; interaction_resolved -> trabalhando', () => {
    const { line } = run();
    line({ type: 'tool_call', toolCallId: 'tc2', toolName: 'fs_write', args: { path: '/p/x' } });
    const w = line({ type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc2', question: 'Allow?', options: [] });
    expect(w).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    const ok = line({ type: 'interaction_resolved', toolCallId: 'tc2', outcome: 'selected', selectedOption: 'allow_once' });
    expect(ok?.status).toBe('working');
    expect(ok?.activities).toEqual([]);
  });

  it('aprovação recusada vira "Você recusou"; tool_result também tira da espera', () => {
    const { line } = run();
    line({ type: 'tool_call', toolCallId: 'a', toolName: 'execute_bash', args: { command: 'rm -rf build' } });
    line({ type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'a' });
    const rej = line({ type: 'interaction_resolved', toolCallId: 'a', outcome: 'selected', selectedOption: { id: 'reject' } });
    expect(rej?.activities[0].text).toContain('recusou');
    expect(rej?.shells).toEqual([{ type: 'result', toolUseId: 'a', error: true }]);
    line({ type: 'tool_call', toolCallId: 'b', toolName: 'fs_write', args: { path: '/p/y' } });
    expect(line({ type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'b' })?.status).toBe('waiting');
    expect(line({ type: 'tool_result', toolCallId: 'b', content: 'ok', success: true })?.status).toBe('working');
  });

  it('shell em segundo plano: início no horário da linha, fim no tool_result', () => {
    const { line } = run();
    const s = line({ type: 'tool_call', toolCallId: 'sh1', toolName: 'execute_bash', args: { command: 'npm run dev', run_in_background: true, description: 'Servidor de dev' } }, 1_000);
    expect(s?.shells).toEqual([{ type: 'start', shell: { toolUseId: 'sh1', label: 'Servidor de dev', command: 'npm run dev', background: true, kind: 'shell', at: T0 + 1_000 } }]);
    const fg = line({ type: 'tool_call', toolCallId: 'sh2', toolName: 'shell', args: { command: 'ls' } }, 2_000);
    expect(fg?.shells[0]).toMatchObject({ type: 'start', shell: { background: false, at: T0 + 2_000 } });
    const end = line({ type: 'tool_result', toolCallId: 'sh1', content: 'done', success: true }, 9_000);
    expect(end).toMatchObject({ at: T0 + 9_000, shells: [{ type: 'result', toolUseId: 'sh1', error: false }] });
  });

  it('resultado de shell em segundo plano depois do turn_end não volta a "trabalhando"', () => {
    const { line } = run();
    line({ type: 'user', content: 'suba o servidor' });
    line({ type: 'tool_call', toolCallId: 'bg', toolName: 'execute_bash', args: { command: 'sleep 99', run_in_background: true } });
    line({ type: 'turn_end', stopReason: 'end_turn' });
    const r = line({ type: 'tool_result', toolCallId: 'bg', content: '', success: true });
    expect(r?.status).toBeUndefined();
    expect(r?.shells).toEqual([{ type: 'result', toolUseId: 'bg', error: false }]);
  });

  it('subagentes: orchestrate_subagent e sub_agent_start não contam em dobro', () => {
    const { state, line } = run();
    const c = line({ type: 'tool_call', toolCallId: 's1', toolName: 'orchestrate_subagent', args: { description: 'Revisar o PR' } });
    expect(c?.activities[0].kind).toBe('delegate');
    line({ type: 'sub_agent_start' });
    expect(state.stats.subagents).toBe(1);
    line({ type: 'sub_agent_start' });
    expect(state.stats.subagents).toBe(2);
    expect(state.stats.tokensIn).toBe(0);
  });

  it('edições somam linhas só quando dão certo', () => {
    const { state, line } = run();
    line({ type: 'tool_call', toolCallId: 'e1', toolName: 'str_replace', args: { path: '/p/a', oldStr: 'a\nb\nc', newStr: 'a\nB\nB2\nc' } });
    line({ type: 'tool_result', toolCallId: 'e1', content: '', success: true });
    line({ type: 'tool_call', toolCallId: 'e2', toolName: 'fs_write', args: { path: '/p/n', text: 'x\ny\n' } });
    line({ type: 'tool_result', toolCallId: 'e2', content: '', success: false });
    line({ type: 'tool_call', toolCallId: 'e3', toolName: 'fs_append', args: { path: '/p/n', content: 'z' } });
    line({ type: 'tool_result', toolCallId: 'e3', content: '', success: true });
    expect(state.stats).toMatchObject({ linesAdded: 3, linesRemoved: 1 });
  });

  it('todo_list create e complete viram tarefas', () => {
    const { state, line } = run();
    const c = line({
      type: 'tool_call',
      toolCallId: 'td1',
      toolName: 'todo_list',
      args: { command: 'create', tasks: { '0': { task_description: 'Ler o código', details: '' }, '1': { task_description: 'Escrever testes', details: '' } } },
    });
    expect(c?.tasksChanged).toBe(true);
    expect(state.tasks).toEqual([
      { id: '1', title: 'Ler o código', status: 'pending' },
      { id: '2', title: 'Escrever testes', status: 'pending' },
    ]);
    line({ type: 'tool_call', toolCallId: 'td2', toolName: 'todo_list', args: { command: 'complete', completed_task_ids: { '0': '1' }, context_update: 'li' } });
    expect(state.tasks.map((t) => t.status)).toEqual(['completed', 'pending']);
  });
});

describe('applyKiroTodo (formatos alternativos)', () => {
  it('lista, add e ids a partir do zero', () => {
    const t = applyKiroTodo([], { command: 'create', tasks: ['A', { task_description: 'B' }] })!;
    expect(t.map((x) => x.id)).toEqual(['1', '2']);
    const t2 = applyKiroTodo(t, { command: 'add', new_tasks: [{ task_description: 'C' }] })!;
    expect(t2.map((x) => `${x.id}:${x.title}`)).toEqual(['1:A', '2:B', '3:C']);
    expect(applyKiroTodo(t2, { command: 'complete', completed_task_ids: [0, 2] })!.map((x) => x.status)).toEqual(['completed', 'pending', 'completed']);
    expect(applyKiroTodo(t2, { command: 'lookup' })).toBeUndefined();
  });
});

describe('ajudantes', () => {
  it('diffLineCounts, kiroEditLines e kiroV3Text', () => {
    expect(diffLineCounts('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(diffLineCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(kiroEditLines('fs_read', {})).toBeUndefined();
    expect(kiroV3Text([{ type: 'text', text: 'oi' }, { kind: 'text', data: 'tchau' }])).toBe('oi\ntchau');
  });
});

describe('subagentes do 3.x', () => {
  it('sub_agent_start: papel, título sem o briefing e com segredo mascarado; complete com erro e sucesso', () => {
    const { state, line } = run();
    const s = line({
      type: 'sub_agent_start',
      parentExecutionId: 'p',
      subSessionId: 'sub-1',
      subAgentName: 'kirocrew-revisor-0123456789abcdef0123',
      prompt: '<orchestrator_briefing>muito contexto</orchestrator_briefing>\n  Revise   o login, senha password=hunter2xyz',
    });
    expect(s?.subStart).toEqual({ subSessionId: 'sub-1', role: 'revisor', title: 'Revise o login, senha password=***' });
    expect(state.stats.subagents).toBe(1);
    expect(line({ type: 'sub_agent_complete', subSessionId: 'sub-1', response: 'feito', status: 'success' })?.subComplete).toEqual({ subSessionId: 'sub-1', error: false, text: 'feito' });
    expect(line({ type: 'sub_agent_complete', subSessionId: 'sub-2', status: 'error', errorMessage: 'falhou' })?.subComplete).toEqual({ subSessionId: 'sub-2', error: true, text: 'falhou' });
    expect(line({ type: 'sub_agent_complete', subSessionId: 'sub-3' })?.subComplete).toEqual({ subSessionId: 'sub-3', error: false });
    expect(line({ type: 'sub_agent_start', subAgentName: 'x' })?.subStart).toBeUndefined();
  });

  it('kiroSubTitle: <user_instruction> (mesmo sem fechar), corte em 90, explicação como reserva', () => {
    expect(kiroSubTitle('<orchestrator_briefing>a</orchestrator_briefing><user_instruction>Faça X</user_instruction> resto')).toBe('Faça X');
    expect(kiroSubTitle('<orchestrator_briefing>a</orchestrator_briefing><user_instruction>Faça Y\n<how_to_interpret>z</how_to_interpret>')).toBe('Faça Y z');
    expect(kiroSubTitle('x'.repeat(200))?.length).toBeLessThanOrEqual(90);
    expect(kiroSubTitle('<orchestrator_briefing>só briefing', 'Explorar o repo')).toBe('Explorar o repo');
    expect(kiroSubTitle('', '')).toBeUndefined();
  });
});
