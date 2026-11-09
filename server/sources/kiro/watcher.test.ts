import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Office } from '../../model/office';
import { NameStore } from '../../model/names';
import type { KiroHookPayload } from './live';
import type { KiroLiveness } from './liveness';
import { KiroWatcher, kiroRole } from './watcher';

const PID = 4242;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Row = Record<string, unknown>;
const prompt = (mid: string, text: string, tsSec?: number): Row => ({
  version: 'v1',
  kind: 'Prompt',
  data: { message_id: mid, content: [{ kind: 'text', data: text }], ...(tsSec ? { meta: { timestamp: tsSec } } : {}) },
});
const tool = (id: string, name: string, input: Row) => ({ kind: 'toolUse', data: { toolUseId: id, name, input } });
const assistant = (mid: string, text: string, ...tools: Row[]): Row => ({
  version: 'v1',
  kind: 'AssistantMessage',
  data: { message_id: mid, content: [{ kind: 'thinking', data: { text: '' } }, { kind: 'text', data: text }, ...tools] },
});
const results = (mid: string, ...ids: string[]): Row => ({
  version: 'v1',
  kind: 'ToolResults',
  data: { message_id: mid, content: ids.map((toolUseId) => ({ kind: 'toolResult', data: { toolUseId, status: 'Success', content: [] } })) },
});
const turn = (ids: string[], endMs: number, secs: number, reason = 'UserTurnEnd') => ({
  message_ids: ids,
  end_timestamp: new Date(endMs).toISOString(),
  turn_duration: { secs, nanos: 0 },
  end_reason: reason,
  input_token_count: 100,
  cache_read_input_token_count: 50,
  output_token_count: 20,
  loop_id: { agent_id: { name: 'kiro_default' } },
});

function setup(opts: { liveness?: KiroLiveness; approval?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-watch-'));
  dirs.push(dir);
  let now = Math.floor(Date.now() / 1000) * 1000;
  const names = new NameStore(join(dir, 'names.json'));
  names.load();
  const office = new Office({ names, version: 't', startedAt: now, accounts: () => [], sources: () => [], accountName: () => 'Kiro', now: () => now });
  const alive = new Set<number>([PID]);
  const kids = new Map<number, number>();
  /** I/O do processo do Kiro (rchar/wchar): parado = esperando você. */
  const io = { r: 1000, w: 1000 };
  const liveness: KiroLiveness = opts.liveness ?? { mode: 'proc', isKiro: (pid) => alive.has(pid), descendants: () => new Map(kids), io: () => ({ ...io }) };
  const watcher = new KiroWatcher({ office, sessionsDir: dir, now: () => now, liveness, approval: opts.approval, account: '.kiro' });
  const file = (id: string, ext: string) => join(dir, `${id}.${ext}`);
  const session = (id: string, meta: Row = {}, rows?: Row[]) => {
    writeFileSync(file(id, 'lock'), JSON.stringify({ pid: PID, started_at: new Date(now - 7200_000).toISOString() }));
    writeMeta(id, meta);
    if (rows) writeFileSync(file(id, 'jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  };
  let metaTouch = 0;
  const writeMeta = (id: string, meta: Row) => {
    const { turns = [], title, ...rest } = meta as { turns?: Row[]; title?: string };
    writeFileSync(
      file(id, 'json'),
      JSON.stringify({
        session_id: id,
        cwd: '/proj/app',
        ...(title ? { title } : {}),
        session_state: {
          agent_name: 'kiro_default',
          conversation_metadata: { user_turn_metadatas: turns },
          rts_model_state: { model_info: { model_id: 'claude-x' } },
          permissions: { trusted_tools: [] },
        },
        ...rest,
      }),
    );
    // mtime distinto a cada gravação (o watcher relê o .json quando o mtime muda)
    const t = new Date(Date.now() + ++metaTouch * 1000);
    utimesSync(file(id, 'json'), t, t);
  };
  const append = (id: string, ...rows: Row[]) => appendFileSync(file(id, 'jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  return {
    dir,
    office,
    watcher,
    alive,
    kids,
    io,
    file,
    session,
    writeMeta,
    append,
    now: () => now,
    tick: (ms: number) => {
      now += ms;
    },
    agent: (id: string) => office.get(id),
  };
}

describe('KiroWatcher: releitura ao achar a sessão', () => {
  it('horários reais dos turnos, sem feed, status do turno fechado, tokens e modelo do .json', () => {
    const t = setup();
    const t0 = t.now() - 3600_000; // turno de 30 s, 1 h atrás
    t.session('s1', { title: 'Revisar o parser', turns: [turn(['m1', 'm2', 'm3', 'm4'], t0 + 30_000, 30)] }, [
      prompt('m1', 'revise o parser', t0 / 1000),
      assistant('m2', '', tool('t1', 'read', { operations: [{ mode: 'Line', path: '/proj/app/parser.ts' }] })),
      results('m3', 't1'),
      assistant('m4', 'Pronto.'),
    ]);
    t.watcher.scan();
    const a = t.agent('s1')!;
    expect(a.status).toBe('idle');
    expect(a.role).toBe('default');
    expect(a.title).toBe('Revisar o parser');
    expect(a.model).toBe('claude-x');
    expect(a.stats).toMatchObject({ toolCalls: 1, tokensIn: 150, tokensOut: 20 });
    expect(a.recent.map((r) => [r.kind, r.at])).toEqual([
      ['prompt', t0],
      ['read', t0 + 10_000],
      ['respond', t0 + 30_000],
    ]);
    expect(t.office.recentFeed(50).filter((f) => f.agentId === 's1')).toEqual([]);
  });

  it('sessão retomada (lock mais novo que as linhas): linha sem turno fica no horário do prompt, não no do lock', () => {
    const t = setup();
    const old = t.now() - 3 * 86400_000;
    t.session('s1b', {}, [prompt('m1', 'antigo', old / 1000), assistant('m2', 'feito')]);
    t.watcher.scan();
    expect(t.agent('s1b')?.recent.map((r) => r.at)).toEqual([old, old]);
  });

  it('papel: kiro_default -> default; agente gerado pelo Kiro Crew perde prefixo e hash', () => {
    expect(kiroRole('kiro_default')).toBe('default');
    expect(kiroRole('kirocrew-skill-view-593bb5a398584c558f88ae5e')).toBe('skill-view');
    expect(kiroRole('devops-agent')).toBe('devops-agent');
    expect(kiroRole(undefined)).toBeUndefined();
  });

  it('sessão do Kiro Crew: título sem o "[AGENT SYSTEM PROMPT]"', () => {
    const t = setup();
    const crew = '[AGENT SYSTEM PROMPT]\nagente\n[END AGENT SYSTEM PROMPT]\n[REPLY FORMAT RULES]\n(regra)\nmostre o status do cluster';
    t.session('s2', { title: '[AGENT SYSTEM PROMPT]' }, [prompt('m1', crew, t.now() / 1000)]);
    t.watcher.scan();
    expect(t.agent('s2')?.title).toBe('mostre o status do cluster');
    expect(t.agent('s2')?.status).toBe('working');
  });

  it('turno cancelado que o .json já fechou: idle e "Interrompido por você"', () => {
    const t = setup();
    const t0 = t.now() - 60_000;
    t.session('s3', { turns: [turn(['m1', 'm2'], t0 + 5_000, 5, 'Cancelled')] }, [prompt('m1', 'rode o build', t0 / 1000), assistant('m2', '', tool('t1', 'shell', { command: 'npm run build' }))]);
    t.watcher.scan();
    expect(t.agent('s3')?.status).toBe('idle');
    expect(t.agent('s3')?.activity?.text).toBe('Interrompido por você');
  });

  it('ferramenta parada desde antes de abrir o Habblaud: aprovação pendente assim que o processo fica quieto', () => {
    const t = setup();
    t.session('s4', {}, [prompt('m1', 'edite o README', t.now() / 1000 - 120), assistant('m2', '', tool('t1', 'write', { command: 'strReplace', path: '/proj/app/README.md' }))]);
    const old = new Date(t.now() - 60_000);
    utimesSync(t.file('s4', 'jsonl'), old, old);
    t.watcher.scan();
    expect(t.agent('s4')?.status).toBe('working'); // primeira leitura do I/O
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s4')?.status).toBe('waiting');
    expect(t.agent('s4')?.waitingFor).toBe('aprovar uma permissão');
  });
});

describe('KiroWatcher: ao vivo', () => {
  it('prompt -> ferramenta -> resposta: feed ao vivo, Concluiu e transcript criado depois do lock', () => {
    const t = setup();
    t.session('s5'); // sem .jsonl ainda
    t.watcher.scan();
    expect(t.agent('s5')?.status).toBe('idle');
    t.append('s5', prompt('m1', 'liste os pods', t.now() / 1000));
    t.watcher.scan();
    expect(t.agent('s5')?.status).toBe('working');
    t.tick(1_000);
    t.append('s5', assistant('m2', '', tool('t1', 'shell', { command: 'kubectl get pods' })));
    t.watcher.scan();
    expect(t.agent('s5')?.activity?.tool).toBe('shell');
    t.tick(1_000);
    t.append('s5', results('m3', 't1'), assistant('m4', 'Tudo rodando.'));
    t.watcher.scan();
    const a = t.agent('s5')!;
    expect(a.status).toBe('idle');
    expect(a.recent.map((r) => r.kind)).toEqual(['prompt', 'run', 'respond', 'done']);
    expect(a.stats.toolCalls).toBe(1); // contagem ao vivo, sem esperar o .json
    expect(t.office.recentFeed(50).filter((f) => f.agentId === 's5').length).toBeGreaterThanOrEqual(3);
  });

  it('write parado além do normal = "aprovar uma permissão"; o ToolResults volta a trabalhar', () => {
    const t = setup();
    t.session('s6', {}, []);
    t.watcher.scan();
    t.append('s6', prompt('m1', 'edite', t.now() / 1000), assistant('m2', '', tool('t1', 'write', { command: 'create', path: '/proj/app/a.md' })));
    t.watcher.scan();
    expect(t.agent('s6')?.status).toBe('working');
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6')?.status).toBe('working');
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6')?.status).toBe('waiting');
    t.append('s6', results('m3', 't1'));
    t.watcher.scan();
    expect(t.agent('s6')?.status).toBe('working');
  });

  it('ferramenta já rodou e o modelo está pensando (o ToolResults só vem com a resposta): I/O mexendo não é aprovação', () => {
    const t = setup();
    t.session('s6b', {}, []);
    t.watcher.scan();
    t.append('s6b', prompt('m1', 'leia', t.now() / 1000), assistant('m2', '', tool('t1', 'read', { operations: [{ mode: 'Line', path: '/proj/app/a.ts' }] })));
    for (let i = 0; i < 10; i++) {
      t.tick(2_000);
      t.io.r += 40; // rede (stream do modelo)
      t.io.w += 8; // spinner
      t.watcher.scan();
    }
    expect(t.agent('s6b')?.status).toBe('working');
    // parou de vez (o pedido de aprovação na tela): vira espera; a tela redesenhada depois do "y" tira dela
    t.tick(2_000);
    t.watcher.scan();
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6b')?.status).toBe('waiting');
    // surto solto (telemetria, redesenho) não tira da espera
    t.io.r += 5_000;
    t.tick(2_000);
    t.watcher.scan();
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6b')?.status).toBe('waiting');
    // aprovado: a tela redesenha e o modelo volta (I/O seguido por 4 s)
    t.io.w += 200_000;
    t.tick(1_000);
    t.watcher.scan();
    expect(t.agent('s6b')?.status).toBe('waiting');
    t.io.w += 8;
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6b')?.status).toBe('waiting');
    t.io.w += 8;
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('s6b')?.status).toBe('working');
    expect(t.agent('s6b')?.recent.filter((r) => r.kind === 'wait').length).toBe(1); // um aviso só
  });

  it('sem /proc (pid, tasklist, ps) não deduz aprovação', () => {
    const t = setup({ liveness: { mode: 'pid', isKiro: () => true } });
    t.session('s6c', {}, [prompt('m1', 'x', t.now() / 1000), assistant('m2', '', tool('t1', 'write', { command: 'create', path: '/a' }))]);
    t.watcher.scan();
    t.tick(60_000);
    t.watcher.scan();
    expect(t.agent('s6c')?.status).toBe('working');
  });

  it('shell: processo novo debaixo do Kiro = comando rodando (sem processo = aprovação)', () => {
    const t = setup();
    t.session('s7', {}, []);
    t.watcher.scan();
    t.append('s7', prompt('m1', 'teste', t.now() / 1000), assistant('m2', '', tool('t1', 'shell', { command: 'npm test' })));
    t.watcher.scan();
    t.kids.set(900, t.now() + 300); // o servidor MCP antigo não conta; este começou depois do toolUse
    t.kids.set(800, t.now() - 3600_000);
    t.tick(10_000);
    t.watcher.scan();
    expect(t.agent('s7')?.status).toBe('working');

    t.kids.delete(900);
    t.append('s7', results('m3', 't1'), assistant('m4', '', tool('t2', 'shell', { command: 'git push' })));
    t.watcher.scan();
    t.tick(3_000);
    t.watcher.scan();
    expect(t.agent('s7')?.status).toBe('waiting');
    t.kids.set(901, t.now()); // aprovado: o comando começou
    t.watcher.scan();
    expect(t.agent('s7')?.status).toBe('working');
  });

  it('subagente nunca vira aprovação; HABBLAUD_KIRO_APPROVAL=0 desliga tudo', () => {
    const t = setup();
    t.session('s8', {}, [prompt('m1', 'x', t.now() / 1000), assistant('m2', '', tool('t1', 'subagent', { task: 'revisar' }))]);
    t.watcher.scan();
    t.tick(600_000);
    t.watcher.scan();
    expect(t.agent('s8')?.status).toBe('working');

    const off = setup({ approval: false });
    off.session('s9', {}, [prompt('m1', 'x', off.now() / 1000), assistant('m2', '', tool('t1', 'write', { command: 'create', path: '/a' }))]);
    off.watcher.scan();
    off.tick(60_000);
    off.watcher.scan();
    expect(off.agent('s9')?.status).toBe('working');
  });
});

describe('KiroWatcher: sessões abertas', () => {
  it('PID que não é do Kiro não entra; o Kiro que fecha sai do escritório', () => {
    const t = setup();
    t.alive.clear();
    t.session('s10', {}, []);
    t.watcher.scan();
    expect(t.agent('s10')).toBeUndefined();
    t.alive.add(PID);
    t.watcher.scan();
    expect(t.agent('s10')?.status).toBe('idle');
    t.alive.clear();
    t.watcher.scan();
    expect(t.watcher.sessionCount()).toBe(0);
    expect(t.agent('s10')?.status ?? 'offline').toBe('offline');
  });

  it('mtime: o que vale é o arquivo mais recente (lock velho com transcript mexido conta)', () => {
    const t = setup({ liveness: { mode: 'mtime', isKiro: () => undefined } });
    t.session('s11', {}, [prompt('m1', 'x', t.now() / 1000)]);
    const old = new Date(t.now() - 20 * 3600_000);
    utimesSync(t.file('s11', 'lock'), old, old);
    utimesSync(t.file('s11', 'json'), old, old);
    t.watcher.scan();
    expect(t.watcher.sessionCount()).toBe(1);
    utimesSync(t.file('s11', 'jsonl'), old, old);
    t.watcher.scan();
    expect(t.watcher.sessionCount()).toBe(0);
  });

  it('mtime (sem ver processos) não deduz aprovação', () => {
    const t = setup({ liveness: { mode: 'mtime', isKiro: () => undefined } });
    t.session('s12', {}, [prompt('m1', 'x', t.now() / 1000), assistant('m2', '', tool('t1', 'write', { command: 'create', path: '/a' }))]);
    t.watcher.scan();
    t.tick(60_000);
    t.watcher.scan();
    expect(t.agent('s12')?.status).toBe('working');
  });
});

describe('KiroWatcher: eventos do hook', () => {
  const hook = (hook_event_name: KiroHookPayload['hook_event_name'], extra: Partial<KiroHookPayload> = {}): KiroHookPayload => ({ hook_event_name, session_id: 'h1', cwd: '/proj/app', ...extra });

  it('UserPromptSubmit põe para trabalhar na hora; o Prompt do transcript não repete o pedido', () => {
    const t = setup();
    t.session('h1', {}, []);
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('idle');
    expect(t.watcher.applyHook('h1', hook('UserPromptSubmit', { prompt: 'liste os pods' }))).toBe(true);
    expect(t.agent('h1')?.status).toBe('working');
    expect(t.agent('h1')?.title).toBe('liste os pods');
    // primeira resposta do modelo: o Kiro grava o pedido e a ferramenta juntos
    t.tick(3_000);
    t.append('h1', prompt('m1', 'liste os pods', t.now() / 1000), assistant('m2', '', tool('t1', 'shell', { command: 'kubectl get pods' })));
    t.watcher.scan();
    expect(t.agent('h1')?.recent.map((r) => r.kind)).toEqual(['prompt', 'run']);
    expect(t.agent('h1')?.status).toBe('working');
  });

  it('PostToolUse fecha a ferramenta: o modelo pensando depois dela não vira aprovação (mesmo com o processo quieto)', () => {
    const t = setup();
    t.session('h1', {}, []);
    t.watcher.scan();
    t.watcher.applyHook('h1', hook('UserPromptSubmit', { prompt: 'leia' }));
    t.append('h1', prompt('m1', 'leia', t.now() / 1000), assistant('m2', '', tool('t1', 'read', { operations: [{ mode: 'Line', path: '/proj/app/a.ts' }] })));
    t.watcher.scan();
    t.watcher.applyHook('h1', hook('PostToolUse', { tool_name: 'read' }));
    t.tick(30_000); // o modelo pensando: o ToolResults só vem com a resposta
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('working');
  });

  it('ferramenta rápida sem PostToolUse = aprovação, em qualquer sistema; o PostToolUse tira da espera', () => {
    const t = setup({ liveness: { mode: 'tasklist', isKiro: () => true } });
    t.session('h1', {}, []);
    t.watcher.scan();
    t.watcher.applyHook('h1', hook('UserPromptSubmit', { prompt: 'edite' }));
    t.append('h1', prompt('m1', 'edite', t.now() / 1000), assistant('m2', '', tool('t1', 'write', { command: 'create', path: '/proj/app/a.md' })));
    t.watcher.scan();
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('working');
    t.tick(1_000);
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('waiting');
    t.watcher.applyHook('h1', hook('PostToolUse', { tool_name: 'write' }));
    expect(t.agent('h1')?.status).toBe('working');
  });

  it('PostToolUse antes de a linha do toolUse ser lida também conta', () => {
    const t = setup();
    t.session('h1', {}, []);
    t.watcher.scan();
    t.watcher.applyHook('h1', hook('UserPromptSubmit', { prompt: 'x' }));
    t.watcher.applyHook('h1', hook('PostToolUse', { tool_name: 'read' }));
    t.append('h1', prompt('m1', 'x', t.now() / 1000), assistant('m2', '', tool('t1', 'read', { operations: [{ mode: 'Line', path: '/a' }] })));
    t.watcher.scan();
    t.tick(10_000);
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('working');
  });

  it('Stop fecha o turno se a resposta final não aparecer no transcript', () => {
    const t = setup();
    t.session('h1', {}, []);
    t.watcher.scan();
    t.watcher.applyHook('h1', hook('UserPromptSubmit', { prompt: 'oi' }));
    t.watcher.applyHook('h1', hook('Stop', { assistant_response: 'Olá' }));
    expect(t.agent('h1')?.status).toBe('working');
    t.tick(2_000);
    t.watcher.scan();
    expect(t.agent('h1')?.status).toBe('idle');
    expect(t.agent('h1')?.activity?.kind).toBe('done');
  });

  it('sessão desconhecida: false', () => {
    const t = setup();
    expect(t.watcher.applyHook('nada', hook('Stop'))).toBe(false);
  });
});
