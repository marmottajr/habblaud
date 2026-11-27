// Arquivos do omp: índice das sessões principais, subagentes da pasta irmã, cabeçalho e presença (session_exit + mtime).
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { endsWithExit, LivenessCache, OmpIndex, parseSessionName, PRESENT_MS, readOmpHead, subagentsOf } from './files';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const A = '01a20000-0000-7000-8000-000000000001';
const B = '01a20000-0000-7000-8000-000000000002';
const SLOT = JSON.stringify({ type: 'title', v: 1, title: '', pad: '' });
const exitLine = JSON.stringify({ type: 'custom', customType: 'session_exit', data: { kind: 'normal' } });
const userLine = JSON.stringify({ type: 'message', message: { role: 'user', content: [] } });

function setup() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const agent = join(tmp.dir, '.omp', 'agent');
  const proj = join(agent, 'sessions', '-proj');
  mkdirSync(proj, { recursive: true });
  const write = (name: string, lines: string[], ageMs = 0) => {
    const path = join(proj, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
    return path;
  };
  return { agent, proj, write };
}

const main = (id: string) => `2026-10-19T13-00-00-000Z_${id}.jsonl`;
const header = (id: string, extra = {}) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-19T13:00:00.000Z', cwd: '/p', ...extra });

describe('índice', () => {
  it('só arquivos com nome de sessão; ignora logs, pastas e outros .jsonl; acha por id', () => {
    const s = setup();
    const a = s.write(main(A), [SLOT, header(A)]);
    s.write(main(B), [SLOT, header(B)]);
    s.write('1.bash.log', ['x']);
    s.write('qualquer.jsonl', ['x']);
    s.write(`${main(A).replace('.jsonl', '')}/ArchScout.jsonl`, [SLOT, header('sub')]);
    const index = new OmpIndex(s.agent);
    expect(index.scan().map((f) => f.sessionId).sort()).toEqual([A, B]);
    expect(index.find(A.toUpperCase())).toMatchObject({ path: a, sessionId: A });
    expect(index.find('01a20000-0000-7000-8000-0000000000ff')).toBeUndefined();
    expect(index.dirs()).toEqual([s.proj]);
  });

  it('sem sessions/: nada, sem erro', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    expect(new OmpIndex(join(tmp.dir, 'nao-existe')).scan()).toEqual([]);
    expect(parseSessionName('x.jsonl')).toBeUndefined();
    expect(parseSessionName(main(A))).toBe(A);
  });
});

describe('subagentes', () => {
  it('um por <Nome>.jsonl da pasta irmã (sem .jsonl); sem a pasta, nenhum', () => {
    const s = setup();
    const path = s.write(main(A), [SLOT, header(A)]);
    expect(subagentsOf(path)).toEqual([]);
    s.write(`${main(A).replace('.jsonl', '')}/ArchScout.jsonl`, [SLOT, header('x')]);
    s.write(`${main(A).replace('.jsonl', '')}/ApiScout.jsonl`, [SLOT, header('y')]);
    s.write(`${main(A).replace('.jsonl', '')}/1.bash.log`, ['z']);
    expect(subagentsOf(path).map((f) => f.name).sort()).toEqual(['ApiScout', 'ArchScout']);
  });
});

describe('cabeçalho e fim do arquivo', () => {
  it('readOmpHead: id, cwd, parentSession; arquivo só com o slot (recém-criado) = sem cabeçalho', () => {
    const s = setup();
    const full = s.write(main(A), [SLOT, header(A, { parentSession: 'C:\\x\\pai.jsonl' }), userLine]);
    expect(readOmpHead(full).header).toMatchObject({ id: A, cwd: '/p', parentSession: 'C:\\x\\pai.jsonl' });
    const fresh = s.write(main(B), [SLOT]);
    expect(readOmpHead(fresh)).toEqual({ bytes: 0 });
    expect(readOmpHead(join(s.proj, 'nao-existe.jsonl'))).toEqual({ bytes: 0 });
  });

  it('endsWithExit: só se a ÚLTIMA linha é o session_exit (retomar a sessão acrescenta linhas)', () => {
    const s = setup();
    const path = s.write(main(A), [SLOT, header(A), userLine, exitLine]);
    const size = () => statSync(path).size;
    expect(endsWithExit(path, size())).toBe(true);
    appendFileSync(path, `${userLine}\n`);
    expect(endsWithExit(path, size())).toBe(false);
  });
});

describe('presença', () => {
  it('nova = viva; encerrada (session_exit) = não; parada há 11 min = não; retomada = volta', () => {
    const s = setup();
    const fresh = s.write(main(A), [SLOT, header(A), userLine]);
    const done = s.write(main(B), [SLOT, header(B), userLine, exitLine]);
    const stale = s.write('2026-10-19T12-00-00-000Z_01a20000-0000-7000-8000-000000000003.jsonl', [SLOT, header('c'), userLine], PRESENT_MS + 60_000);
    const cache = new LivenessCache();
    const now = Date.now();
    const files = new OmpIndex(s.agent).scan();
    const live = files.filter((f) => cache.isLive(f, now)).map((f) => f.path);
    expect(live).toEqual([fresh]);
    expect([done, stale].every((p) => !live.includes(p))).toBe(true);

    // Retomada: linhas depois do session_exit; o cache confere de novo porque o tamanho mudou.
    appendFileSync(done, `${userLine}\n`);
    const again = new OmpIndex(s.agent).scan().find((f) => f.path === done)!;
    expect(cache.isLive(again, Date.now())).toBe(true);
    // E o tempo passando sem escrita tira a sessão.
    expect(cache.isLive(again, Date.now() + PRESENT_MS + 1_000)).toBe(false);
  });
});
