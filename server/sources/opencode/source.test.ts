// Fonte do OpenCode sobre um banco em memória com as colunas que ela lê (session_v2 e session_message).
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { describeOpencodeTool, parseOpencodeMessage } from './parse';
import { opencodeDataDir, OpencodeSource, PRESENCE_MS, sqliteOpener } from './source';

setQuiet(true);

type Db = { exec(sql: string): void; prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown }; close(): void };
const sqlite = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (p: string) => Db } | undefined;

const SCHEMA = `
create table session_v2 (id text primary key, parent_id text, directory text not null, title text, agent text, model text,
  time_created integer not null, time_updated integer not null, time_idle integer, time_archived integer, cost real default 0 not null,
  tokens_input integer default 0 not null, tokens_output integer default 0 not null, tokens_reasoning integer default 0 not null,
  tokens_cache_read integer default 0 not null, tokens_cache_write integer default 0 not null);
create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null,
  time_created integer not null, time_updated integer not null, data text not null);`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const db = new sqlite!.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/nao/existe', env: {}, now, onChange: () => late.office?.markDirty() });
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
  const source = new OpencodeSource({ accounts, office, dir: '/dados/opencode', open: () => ({ prepare: (s) => db.prepare(s), close: () => undefined }), now });
  cleanups.push(() => {
    source.stop();
    db.close();
  });
  let seq = 0;
  const t = {
    db,
    office,
    source,
    accounts,
    advance(ms: number) {
      clock += ms;
    },
    session(id: string, o: { parent?: string; dir?: string; idle?: boolean; title?: string } = {}) {
      db.prepare(
        'insert into session_v2 (id, parent_id, directory, title, agent, model, time_created, time_updated, time_idle) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, o.parent ?? null, o.dir ?? '/p/loja', o.title ?? 'Arrumar o carrinho', o.parent ? 'explore' : 'build', '{"id":"gpt-x","providerID":"x"}', clock, clock, o.idle ? clock + 1 : null);
    },
    message(session: string, type: string, data: Record<string, unknown>) {
      seq++;
      db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run(`msg_${seq}`, session, type, seq, clock, clock, JSON.stringify({ time: { created: clock }, ...data }));
      db.prepare('update session_v2 set time_updated = ? where id = ?').run(clock, session);
      if (type === 'idle') db.prepare('update session_v2 set time_idle = ? where id = ?').run(clock + 1, session);
    },
    poll() {
      source.poll();
      office.tick();
      office.commit();
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
  };
  return t;
}

describe.skipIf(!sqlite)('OpencodeSource', () => {
  it('registra a conta OpenCode e põe a sessão na sala do projeto, trabalhando', () => {
    const t = setup();
    t.session('ses_a');
    t.message('ses_a', 'user', { text: 'conserta o carrinho' });
    t.message('ses_a', 'assistant', { content: [{ type: 'tool', id: 'c1', name: 'read', state: { status: 'running', input: { path: '/p/loja/cart.ts' } } }] });
    t.poll();
    const a = t.agent('opencode:ses_a');
    expect(a).toMatchObject({ provider: 'opencode', account: 'opencode', status: 'working', kind: 'main' });
    expect(t.accounts.entriesOf('opencode')[0]?.detected.name).toBe('OpenCode');
    expect(t.source.sources()).toEqual([expect.objectContaining({ provider: 'opencode', sessions: 1, ok: true })]);
  });

  it('fica ocioso no fim do turno e espera com uma pergunta aberta', () => {
    const t = setup();
    t.session('ses_a');
    t.message('ses_a', 'user', { text: 'oi' });
    t.poll();
    t.advance(1_000);
    t.message('ses_a', 'assistant', { content: [{ type: 'tool', id: 'q', name: 'question', state: { status: 'running', input: { questions: [{ question: 'Qual cor?' }] } } }] });
    t.poll();
    expect(t.agent('opencode:ses_a')?.status).toBe('waiting');
    t.advance(1_000);
    t.message('ses_a', 'idle', { outcome: 'succeeded' });
    t.poll();
    expect(t.agent('opencode:ses_a')?.status).toBe('idle');
  });

  it('sai do escritório depois de PRESENCE_MS parada', () => {
    const t = setup();
    t.session('ses_a', { idle: true });
    t.poll();
    expect(t.agent('opencode:ses_a')).toBeDefined();
    t.advance(PRESENCE_MS + 5_000);
    t.poll();
    t.advance(5_000);
    t.poll();
    const a = t.agent('opencode:ses_a');
    expect(!a || a.status === 'offline').toBe(true);
  });

  it('subagente entra sob o principal enquanto trabalha', () => {
    const t = setup();
    t.session('ses_a');
    t.message('ses_a', 'user', { text: 'investiga' });
    t.session('ses_b', { parent: 'ses_a' });
    t.message('ses_b', 'user', { text: 'procura os testes' });
    t.poll();
    expect(t.agent('opencode:ses_b')).toMatchObject({ kind: 'sub', parentId: 'opencode:ses_a', provider: 'opencode' });
  });

  it('ignora sessões arquivadas', () => {
    const t = setup();
    t.session('ses_a');
    t.db.prepare('update session_v2 set time_archived = 1 where id = ?').run('ses_a');
    t.poll();
    expect(t.agent('opencode:ses_a')).toBeUndefined();
  });
});

describe('parse do OpenCode', () => {
  it('traduz as ferramentas para as descrições do escritório', () => {
    expect(describeOpencodeTool('edit', { path: '/x/App.tsx' }).desc.text).toContain('App.tsx');
    expect(describeOpencodeTool('shell', { command: 'npm test' }).tool).toBe('Bash');
    expect(describeOpencodeTool('question', { questions: [] }).desc.kind).toBe('ask');
  });

  it('não repete a mesma atividade quando a mensagem é relida', () => {
    const seen = new Set<string>();
    const row = { id: 'm1', seq: 1, type: 'assistant', time_created: 1, time_updated: 1, data: JSON.stringify({ content: [{ type: 'tool', id: 'c', name: 'read', state: { status: 'completed', input: {} } }] }) };
    expect(parseOpencodeMessage('s', row, seen).activities).toHaveLength(1);
    expect(parseOpencodeMessage('s', row, seen).activities).toHaveLength(0);
  });

  it('acha a pasta de dados pelo XDG_DATA_HOME ou pela variável do Habblaud', () => {
    expect(opencodeDataDir({ HOME: '/h' })).toBe('/h/.local/share/opencode');
    expect(opencodeDataDir({ HOME: '/h', XDG_DATA_HOME: '/x' })).toBe('/x/opencode');
    expect(opencodeDataDir({ HABBLAUD_OPENCODE_DIR: '/o' })).toBe('/o');
  });

  it('abre o node:sqlite quando existe', () => {
    expect(typeof sqliteOpener()).toBe(sqlite ? 'function' : 'undefined');
  });
});
