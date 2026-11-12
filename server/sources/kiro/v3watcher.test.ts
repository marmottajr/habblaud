import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Office } from '../../model/office';
import { NameStore } from '../../model/names';
import type { KiroLiveness } from './liveness';
import { KiroV3Watcher, readKiroV3Lease } from './v3watcher';
import { kiroV3SubTranscriptPath } from './v3paths';

// Pasta do Kiro 3.x sintética: session-leases/<id>.lease e sessions/<hash>/<id>/{session.json,messages.jsonl}.
const PID = 5151;
const SID = 'sess_00000000-aaaa-bbbb-cccc-000000000001';
const TOKEN = 'segredo-da-trava-nao-pode-vazar';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kiro-v3-'));
  dirs.push(root);
  let now = Date.parse('2030-01-02T12:00:00.000Z');
  const names = new NameStore(join(root, 'names.json'));
  names.load();
  const office = new Office({ names, version: 't', startedAt: now, accounts: () => [], sources: () => [], accountName: () => 'Kiro', now: () => now });
  const alive = new Set<number>([PID]);
  const liveness: KiroLiveness = { mode: 'proc', isKiro: (pid) => alive.has(pid) };
  const tracked: string[] = [];
  const watcher = new KiroV3Watcher({ office, kiroDir: root, now: () => now, liveness, pollMs: 3_600_000, onTrack: (id) => tracked.push(id) });
  const leases = join(root, 'session-leases');
  const sdir = join(root, 'sessions', 'a1b2c3', SID);
  mkdirSync(leases, { recursive: true });
  mkdirSync(sdir, { recursive: true });
  const transcript = join(sdir, 'messages.jsonl');
  let seq = 0;
  const line = (payload: Record<string, unknown>, at = now) => JSON.stringify({ id: `m${++seq}`, timestamp: new Date(at).toISOString(), payload }) + '\n';
  const session = (rows: Array<[Record<string, unknown>, number?]>, acquiredAt = now - 600_000) => {
    writeFileSync(
      join(leases, `${SID}.lease`),
      JSON.stringify({ v: 1, pid: PID, parentPid: 1, instanceId: 'i', hostId: 'h', acquiredAt: new Date(acquiredAt).toISOString(), token: TOKEN, clientName: 'kiro-cli' }),
    );
    writeFileSync(
      join(sdir, 'session.json'),
      JSON.stringify({ id: SID, title: 'Corrigir o login', agentMode: 'kiro_default', workspacePaths: ['/proj/app'], createdAt: new Date(acquiredAt).toISOString(), modelId: 'model-x', status: 'active' }),
    );
    writeFileSync(transcript, rows.map(([p, at]) => line(p, at)).join(''));
  };
  const append = (p: Record<string, unknown>) => appendFileSync(transcript, line(p));
  return {
    office,
    watcher,
    alive,
    tracked,
    leases,
    sdir,
    session,
    append,
    /** Linha no transcript do subagente (sub-executions/<sub>.jsonl, criado na primeira). */
    subAppend: (sub: string, p: Record<string, unknown>) => {
      mkdirSync(join(sdir, 'sub-executions'), { recursive: true });
      appendFileSync(join(sdir, 'sub-executions', `${sub}.jsonl`), line(p));
    },
    tick: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

describe('KiroV3Watcher', () => {
  it('relê a sessão aberta: tarefas, números, shell em segundo plano e status "shell"', () => {
    const t = setup();
    const at = t.now - 60_000;
    t.session([
      [{ type: 'user', content: 'Suba o servidor e escreva os testes' }, at],
      [{ type: 'turn_start', turnId: 't1' }, at],
      [{ type: 'tool_call', toolCallId: 'td', toolName: 'todo_list', args: { command: 'create', tasks: { '0': { task_description: 'Subir o servidor' }, '1': { task_description: 'Testes' } } } }, at + 1_000],
      [{ type: 'tool_call', toolCallId: 'td2', toolName: 'todo_list', args: { command: 'complete', completed_task_ids: { '0': '1' } } }, at + 2_000],
      [{ type: 'tool_call', toolCallId: 'sh', toolName: 'execute_bash', args: { command: 'npm run dev', run_in_background: true, description: 'Servidor de dev' } }, at + 3_000],
      [{ type: 'ContextualHookInvoked' }, at + 3_500],
      [{ type: 'assistant', content: 'Servidor subindo.', operationType: 'Say' }, at + 4_000],
      [{ type: 'turn_end', turnId: 't1', stopReason: 'end_turn' }, at + 5_000],
    ]);
    t.watcher.start();
    try {
      const a = t.office.get(SID);
      expect(a).toMatchObject({ provider: 'kiro', status: 'shell', title: 'Corrigir o login', model: 'model-x', role: 'default' });
      expect(a?.tasks.map((x) => `${x.id}:${x.status}`)).toEqual(['1:completed', '2:pending']);
      expect(a?.stats).toMatchObject({ toolCalls: 3, tokensIn: 0, tokensOut: 0 });
      expect(a?.shells).toEqual([{ id: 'sh', label: 'Servidor de dev', command: 'npm run dev', startedAt: at + 3_000, background: true, kind: 'shell' }]);
      expect(t.tracked).toEqual([SID]);
      expect(t.watcher.has(SID)).toBe(true);
      // o token da trava não aparece em lugar nenhum do escritório
      expect(JSON.stringify(t.office.commit().snapshot)).not.toContain(TOKEN);
      expect(JSON.stringify(readKiroV3Lease(join(t.leases, `${SID}.lease`)))).not.toContain(TOKEN);

      // ao vivo: o shell termina -> 'ShellDone' e ocioso
      t.tick(30_000);
      t.append({ type: 'tool_result', toolCallId: 'sh', content: 'ok', success: true });
      t.watcher.scan();
      const b = t.office.get(SID);
      expect(b?.status).toBe('idle');
      expect(b?.shells).toBeUndefined();
      expect(b?.activity?.tool).toBe('ShellDone');
    } finally {
      t.watcher.stop();
    }
  });

  it('ao vivo: pedido de aprovação -> esperando -> resolvido; shell em primeiro plano até o resultado', () => {
    const t = setup();
    t.session([]);
    t.watcher.start();
    try {
      expect(t.office.get(SID)?.status).toBe('idle');
      t.append({ type: 'user', content: 'liste os arquivos' });
      t.append({ type: 'turn_start', turnId: 't1' });
      t.append({ type: 'tool_call', toolCallId: 'c1', toolName: 'execute_bash', args: { command: 'ls -la' } });
      t.append({ type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'c1', question: 'Run?', options: [] });
      t.watcher.scan();
      expect(t.office.get(SID)).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
      // esperando aprovação: o comando ainda não começou
      expect(t.office.get(SID)?.shells).toBeUndefined();

      t.tick(5_000);
      t.append({ type: 'interaction_resolved', toolCallId: 'c1', outcome: 'selected', selectedOption: 'allow' });
      t.watcher.scan();
      const a = t.office.get(SID);
      expect(a?.status).toBe('working');
      expect(a?.shells).toMatchObject([{ id: 'c1', background: false }]);

      t.tick(2_000);
      t.append({ type: 'tool_result', toolCallId: 'c1', content: 'x', success: false });
      t.append({ type: 'turn_end', turnId: 't1', stopReason: 'end_turn' });
      t.watcher.scan();
      const b = t.office.get(SID);
      expect(b?.status).toBe('idle');
      expect(b?.shells).toBeUndefined();
      expect(b?.recent.some((x) => x.kind === 'error')).toBe(true);
    } finally {
      t.watcher.stop();
    }
  });

  it('turno aberto de antes da trava atual não conta como trabalhando', () => {
    const t = setup();
    const acquired = t.now - 1_000;
    t.session([[{ type: 'user', content: 'antigo' }, acquired - 60_000], [{ type: 'turn_start' }, acquired - 59_000]], acquired);
    t.watcher.start();
    try {
      expect(t.office.get(SID)?.status).toBe('idle');
    } finally {
      t.watcher.stop();
    }
  });

  it('processo morto ou trava apagada: o personagem sai', () => {
    const t = setup();
    t.session([]);
    t.watcher.start();
    try {
      expect(t.office.get(SID)?.status).toBe('idle');
      t.alive.delete(PID);
      t.watcher.scan();
      expect(t.office.get(SID)?.status).toBe('offline');
      expect(t.watcher.has(SID)).toBe(false);
      t.alive.add(PID);
      t.watcher.scan();
      expect(t.watcher.has(SID)).toBe(true);
      rmSync(join(t.leases, `${SID}.lease`));
      t.watcher.scan();
      expect(t.watcher.has(SID)).toBe(false);
    } finally {
      t.watcher.stop();
    }
  });

  it('pid da trava sem Kiro e sem sessão: nada aparece', () => {
    const t = setup();
    t.session([]);
    t.alive.clear();
    t.watcher.start();
    try {
      expect(t.office.get(SID)).toBeUndefined();
    } finally {
      t.watcher.stop();
    }
  });

  describe('subagentes do 3.x', () => {
    const SUB_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const SUB_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const A = `${SID}:${SUB_A}`;
    const B = `${SID}:${SUB_B}`;
    const briefing = '<orchestrator_briefing>contexto longo do orquestrador <how_to_interpret>x</how_to_interpret></orchestrator_briefing>\n';

    it('ao vivo: dois em paralelo viram personagens, com atividades, tarefas, resposta e erro', () => {
      const t = setup();
      t.session([[{ type: 'user', content: 'divida o trabalho' }], [{ type: 'turn_start' }]]);
      t.watcher.start();
      try {
        t.append({ type: 'tool_call', toolCallId: 'o1', toolName: 'orchestrate_subagent', args: { description: 'dividir' } });
        t.append({
          type: 'sub_agent_start',
          parentExecutionId: 'p1',
          subSessionId: SUB_A,
          subAgentName: 'kiro_dev-agent',
          prompt: `${briefing}<user_instruction>Corrija o login com GITHUB_TOKEN=abc123segredo</user_instruction>\nresto`,
          explanation: 'explicação longa',
        });
        t.append({ type: 'sub_agent_start', parentExecutionId: 'p1', subSessionId: SUB_B, subAgentName: 'revisor', prompt: 'Revise o <repo> inteiro' });
        t.watcher.scan();
        expect(t.office.get(A)).toMatchObject({ kind: 'sub', parentId: SID, role: 'dev-agent', status: 'working', title: 'Corrija o login com GITHUB_TOKEN=***' });
        expect(t.office.get(B)).toMatchObject({ kind: 'sub', parentId: SID, role: 'revisor', title: 'Revise o <repo> inteiro' });
        // o arquivo do subagente ainda não existe: abre o terminal assim que aparecer
        expect(t.watcher.transcriptPathOf(A)).toBe(join(t.sdir, 'sub-executions', `${SUB_A}.jsonl`));

        t.subAppend(SUB_A, { type: 'steering_inclusion' });
        t.subAppend(SUB_A, { type: 'tool_call', toolCallId: 'a1', toolName: 'todo_list', args: { command: 'create', tasks: { '0': { task_description: 'Ler o código' }, '1': { task_description: 'Corrigir' } } } });
        t.subAppend(SUB_A, { type: 'tool_call', toolCallId: 'a2', toolName: 'fs_read', args: { operations: [{ mode: 'Line', path: '/proj/app/login.ts' }] } });
        t.subAppend(SUB_A, { type: 'tool_result', toolCallId: 'a2', success: true, content: 'x' });
        t.subAppend(SUB_B, { type: 'tool_call', toolCallId: 'b1', toolName: 'execute_bash', args: { command: 'git log -1' } });
        t.watcher.scan();
        const a = t.office.get(A);
        expect(a?.tasks.map((x) => `${x.id}:${x.status}`)).toEqual(['1:pending', '2:pending']);
        expect(a?.stats.toolCalls).toBe(2);
        expect(a?.recent.some((x) => x.tool === 'fs_read')).toBe(true);
        expect(t.office.get(B)?.recent.some((x) => x.tool === 'execute_bash')).toBe(true);
        expect(t.office.get(B)?.shells).toMatchObject([{ id: 'b1', background: false }]);
        // as atividades do subagente não vão para o principal
        expect(t.office.get(SID)?.recent.some((x) => x.tool === 'fs_read')).toBe(false);

        // o complete chega antes de o resto do arquivo ser lido: lê primeiro, depois conclui
        t.tick(10_000);
        t.subAppend(SUB_A, { type: 'tool_call', toolCallId: 'a3', toolName: 'todo_list', args: { command: 'complete', completed_task_ids: { '0': '1', '1': '2' } } });
        t.subAppend(SUB_A, { type: 'assistant', content: 'Pronto.', operationType: 'Say' });
        t.append({ type: 'sub_agent_complete', parentExecutionId: 'p1', subSessionId: SUB_A, response: 'Login corrigido em login.ts', status: 'success' });
        t.append({ type: 'sub_agent_complete', parentExecutionId: 'p1', subSessionId: SUB_B, response: null, status: 'error', errorMessage: 'Tempo esgotado' });
        t.watcher.scan();
        const a2 = t.office.get(A);
        expect(a2?.status).toBe('done');
        expect(a2?.tasks.every((x) => x.status === 'completed')).toBe(true);
        expect(a2?.recent.some((x) => x.kind === 'respond' && x.detail === 'Login corrigido em login.ts')).toBe(true);
        const b2 = t.office.get(B);
        expect(b2?.status).toBe('done');
        expect(b2?.shells).toBeUndefined();
        expect(b2?.recent.some((x) => x.kind === 'error' && x.detail === 'Tempo esgotado')).toBe(true);
        expect(t.office.get(SID)?.stats.subagents).toBe(2);
        expect(JSON.stringify(t.office.commit())).toContain('entregou');
        // concluído: o terminal ainda acha o arquivo
        expect(t.watcher.transcriptPathOf(A)).toBe(join(t.sdir, 'sub-executions', `${SUB_A}.jsonl`));
        expect(t.watcher.transcriptPathOf(`${SID}:../x`)).toBeUndefined();
      } finally {
        t.watcher.stop();
      }
    });

    it('releitura: o que já terminou não entra; o que ainda roda entra; sessão fechada leva os subagentes', () => {
      const t = setup();
      const at = t.now - 30_000;
      t.session([
        [{ type: 'user', content: 'divida' }, at],
        [{ type: 'sub_agent_start', subSessionId: SUB_A, subAgentName: 'velho', prompt: 'tarefa antiga' }, at + 1_000],
        [{ type: 'sub_agent_complete', subSessionId: SUB_A, response: 'ok', status: 'success' }, at + 2_000],
        [{ type: 'sub_agent_start', subSessionId: SUB_B, subAgentName: 'atual', prompt: 'tarefa atual' }, at + 3_000],
      ]);
      t.subAppend(SUB_A, { type: 'tool_call', toolCallId: 'a1', toolName: 'fs_read', args: {} });
      t.subAppend(SUB_B, { type: 'tool_call', toolCallId: 'b1', toolName: 'grep', args: { pattern: 'login' } });
      t.watcher.start();
      try {
        expect(t.office.get(A)).toBeUndefined();
        const b = t.office.get(B);
        expect(b).toMatchObject({ kind: 'sub', parentId: SID, role: 'atual', title: 'tarefa atual', status: 'working' });
        expect(b?.stats.toolCalls).toBe(1);
        expect(t.office.get(SID)?.stats.subagents).toBe(2);

        // ao vivo depois da releitura
        t.subAppend(SUB_B, { type: 'assistant', content: 'achei', operationType: 'Say' });
        t.watcher.scan();
        expect(t.office.get(B)?.recent.some((x) => x.kind === 'respond')).toBe(true);

        t.alive.delete(PID);
        t.watcher.scan();
        expect(t.office.get(SID)?.status).toBe('offline');
        expect(t.office.get(B)?.status).toBe('done');
        // aviso de entrega só para quem entregou de verdade
        expect(JSON.stringify(t.office.commit())).not.toContain('entregou');
      } finally {
        t.watcher.stop();
      }
    });

    it('sessão retomada noutro processo: subagente aberto do processo anterior não volta', () => {
      const t = setup();
      const acquired = t.now - 1_000;
      t.session([[{ type: 'sub_agent_start', subSessionId: SUB_A, subAgentName: 'x', prompt: 'p' }, acquired - 60_000]], acquired);
      t.watcher.start();
      try {
        expect(t.office.get(A)).toBeUndefined();
      } finally {
        t.watcher.stop();
      }
    });

    it('transcript do subagente de sessão encerrada pelo id do personagem', () => {
      const t = setup();
      t.session([]);
      t.subAppend(SUB_A, { type: 'assistant', content: 'oi' });
      const root = join(t.leases, '..');
      expect(kiroV3SubTranscriptPath(root, A)).toBe(join(t.sdir, 'sub-executions', `${SUB_A}.jsonl`));
      expect(kiroV3SubTranscriptPath(root, B)).toBeUndefined();
      expect(kiroV3SubTranscriptPath(root, SID)).toBeUndefined();
    });
  });
});
