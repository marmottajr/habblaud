import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { HermesSource } from './source';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-hermes-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, cwd TEXT, git_repo_root TEXT, title TEXT, model TEXT, git_branch TEXT, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER)');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, tool_name TEXT, timestamp REAL)');
  let time = 1_800_000_000_000;
  const now = () => time;
  const accounts = new AccountsService({ dirs: [], home: dir, env: {}, onChange() {} });
  const office = new Office({ names: new NameStore(null), version: 'test', startedAt: time, accounts: (s) => accounts.list(s), sources: () => [], accountName: (id) => accounts.find(id)?.detected.name, now });
  const source = new HermesSource({ accounts, office, dirs: [dir], now });
  return { db, source, office, now, advance(ms: number) { time += ms; }, agent() { return office.commit().snapshot.agents.find((a) => a.provider === 'hermes'); } };
}

it('shows only recently active genuine CLI sessions and uses project cwd', () => {
  const x = fixture();
  x.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('current', 'cli', null, x.now()/1000-50, null, x.now()/1000-2, '/work/project', null, null, 'test-model', 'feature', 1, 20, 3);
  x.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('stale', 'cli', null, x.now()/1000-900, null, x.now()/1000-800, '/work/old', null, null, null, null, 0, 0, 0);
  x.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('closed', 'cli', null, x.now()/1000-50, x.now()/1000-1, x.now()/1000-1, '/work/closed', null, null, null, null, 0, 0, 0);
  x.source.boot();
  expect(x.agent()).toMatchObject({ provider: 'hermes', sessionId: 'current', roomId: '/work/project', model: 'test-model', gitBranch: 'feature', stats: { toolCalls: 1, tokensIn: 20, tokensOut: 3 } });
  expect(x.office.commit().snapshot.agents.filter((a) => a.provider === 'hermes')).toHaveLength(1);
  x.advance(121_000);
  x.source.poll();
  expect(x.agent()?.status).toBe('offline');
  x.db.close();
});

it('reports tool-name activity without loading message bodies and ignores sessions without cwd', () => {
  const x = fixture();
  x.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('live', 'cli', null, x.now()/1000-50, null, x.now()/1000-2, '/work', null, null, null, null, 1, 0, 0);
  x.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('nocwd', 'gateway', null, x.now()/1000-50, null, x.now()/1000-2, null, null, null, null, null, 0, 0, 0);
  x.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(1, 'live', 'tool', 'terminal', x.now()/1000-1);
  x.source.boot();
  expect(x.agent()?.activity).toMatchObject({ tool: 'terminal', kind: 'run' });
  expect(x.source.sources()[0].sessions).toBe(1);
  expect(x.source.transcriptPathOf(x.agent()!.id)).toBeUndefined();
  x.db.close();
});
