// Fonte do DeepSeek Harness: uma pasta ~/.dsh temporária com sessões sintéticas (JSONL em vários quadros zstd).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { decodeFrames, describeDshTool, discoverDshDir, DshSource } from './source';

setQuiet(true);

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
const SID = '01cf02e4-f437-4875-b90d-9efced4f6921';

function frame(lines: object[]): Buffer {
  return zlib.zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-dsh-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sessionDir = join(dir, 'sessions', '--D-proj--', `session-${SID}`);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, 'session.v4.jsonl.zstd');
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: dir, env: {}, now, onChange: () => late.office?.markDirty() });
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
  const source = new DshSource({ accounts, office, dir, env: {}, now });
  cleanups.unshift(() => source.stop());
  return {
    dir,
    file,
    source,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      office.commit();
    },
    agents: () => office.commit().snapshot.agents,
    at: () => clock,
  };
}

describe.skipIf(!hasZstd)('DeepSeek Harness', () => {
  it('decodeFrames: lê todos os quadros completos e deixa o último, incompleto, para depois', () => {
    const a = frame([{ n: 1 }]);
    const b = frame([{ n: 2 }]);
    const c = frame([{ n: 3 }]);
    const all = Buffer.concat([a, b, c.subarray(0, c.length - 3)]);
    const r = decodeFrames(all);
    expect(r.text).toBe('{"n":1}\n{"n":2}\n');
    expect(r.used).toBe(a.length + b.length);
    expect(decodeFrames(Buffer.from('nada'))).toEqual({ text: '', used: 0 });
  });

  it('describeDshTool: as ferramentas do DSH viram as do Claude Code', () => {
    expect(describeDshTool('read', { file_path: 'D:\\proj\\a.ts' }).tool).toBe('Read');
    expect(describeDshTool('pwsh', { command: 'npm test' }).tool).toBe('Bash');
    expect(describeDshTool('grep', { pattern: 'x' }).tool).toBe('Grep');
  });

  it('discoverDshDir: só com a pasta sessions/', () => {
    const { dir } = setup();
    expect(discoverDshDir({ HABBLAUD_DSH_DIR: dir })).toBe(dir);
    expect(discoverDshDir({ HABBLAUD_DSH_DIR: join(dir, 'nao-existe') })).toBeUndefined();
  });

  it('sessão: entra trabalhando, mostra a ferramenta, o título e o modelo, e fica parada no fim do turno', () => {
    const h = setup();
    const t = h.at();
    writeFileSync(
      h.file,
      Buffer.concat([
        frame([{ type: 'session', version: 4, id: SID, createdAt: t - 5000, cwd: 'D:\\proj', delegationDepth: 0 }]),
        frame([
          { type: 'turn/start', seq: 1, time: t - 4000, data: { turn: 1 } },
          { type: 'session/title', seq: 2, time: t - 3900, data: { title: 'Instalar e rodar' } },
          { type: 'request/context', seq: 3, time: t - 3800, data: { provider: 'p', model: 'modelo-x' } },
          { type: 'tool/call', seq: 4, time: t - 3000, data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm ci' }) } },
        ]),
      ]),
    );
    h.poll();
    const [a] = h.agents();
    expect(a).toMatchObject({ id: `.dsh:${SID}`, provider: 'dsh', status: 'working', roomId: 'D:\\proj', title: 'Instalar e rodar', model: 'modelo-x' });
    expect(a.stats.toolCalls).toBe(1);

    appendFileSync(h.file, frame([{ type: 'turn/end', seq: 5, time: t - 1000, data: { turn: 1, reason: { kind: 'completed' } } }]));
    h.advance(1000);
    h.poll();
    expect(h.agents()[0].status).toBe('idle');
  });

  it('subagente: entra no escritório sob o agente que o chamou e entrega o trabalho no fim do turno', () => {
    const h = setup();
    const t = h.at();
    const KID = '3eb25a95-ad88-4175-95b8-8dd70ef7ae94';
    writeFileSync(
      h.file,
      frame([
        { type: 'session', version: 4, id: `session-${SID}`, createdAt: t - 9000, cwd: 'D:\\proj', delegationDepth: 0 },
        { type: 'turn/start', seq: 1, time: t - 8000, data: { turn: 1 } },
      ]),
    );
    const kidDir = join(h.dir, 'sessions', '--D-proj--', KID);
    mkdirSync(kidDir, { recursive: true });
    const kidFile = join(kidDir, 'session.v4.jsonl.zstd');
    writeFileSync(
      kidFile,
      frame([
        { type: 'session', version: 4, id: KID, createdAt: t - 5000, cwd: 'D:\\proj', parentSession: `session-${SID}`, origin: 'subagent', delegationDepth: 1 },
        { type: 'subagent/descriptor', seq: 0, time: t - 5000, data: { label: 'traduzir zh' } },
        { type: 'turn/start', seq: 1, time: t - 4000, data: { turn: 1 } },
        { type: 'tool/call', seq: 2, time: t - 3000, data: { callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'D:\\proj\\a.ts' }) } },
      ]),
    );
    h.poll();
    const kid = h.agents().find((a) => a.id === `.dsh:${KID}`);
    expect(kid).toMatchObject({ kind: 'sub', parentId: `.dsh:${SID}`, provider: 'dsh', status: 'working', title: 'traduzir zh', roomId: 'D:\\proj' });
    expect(h.source.transcriptPathOf(`.dsh:${KID}`)).toBe(kidFile);
    expect(h.source.sources()[0].sessions).toBe(1);

    appendFileSync(kidFile, frame([{ type: 'turn/end', seq: 3, time: t - 1000, data: { turn: 1, reason: { kind: 'completed' } } }]));
    h.advance(1000);
    h.poll();
    expect(h.agents().find((a) => a.id === `.dsh:${KID}`)?.status).toBe('done');
  });

  it('subagente já concluído quando o Habblaud abre não entra', () => {
    const h = setup();
    const t = h.at();
    const KID = '1bb30408-e944-4718-9631-18d947974b9b';
    writeFileSync(h.file, frame([{ type: 'session', version: 4, id: `session-${SID}`, cwd: 'D:\\proj' }, { type: 'turn/start', seq: 1, time: t, data: {} }]));
    const kidDir = join(h.dir, 'sessions', '--D-proj--', KID);
    mkdirSync(kidDir, { recursive: true });
    writeFileSync(
      join(kidDir, 'session.v4.jsonl.zstd'),
      frame([
        { type: 'session', version: 4, id: KID, cwd: 'D:\\proj', parentSession: `session-${SID}` },
        { type: 'turn/start', seq: 1, time: t - 4000, data: { turn: 1 } },
        { type: 'turn/end', seq: 2, time: t - 1000, data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    );
    h.poll();
    expect(h.agents().map((a) => a.id)).toEqual([`.dsh:${SID}`]);
  });

  it('sessões internas (botharness) e antigas ficam de fora', () => {
    const h = setup();
    const internal = join(h.dir, 'sessions', '--C-Users-x-.dsh-botharness-r--', 'session-aaaa');
    mkdirSync(internal, { recursive: true });
    writeFileSync(join(internal, 'session.v4.jsonl.zstd'), frame([{ type: 'session', version: 4, id: 'aaaa', cwd: 'C:\\x' }, { type: 'turn/start', seq: 1, time: h.at(), data: {} }]));
    writeFileSync(h.file, frame([{ type: 'session', version: 4, id: SID, cwd: 'D:\\proj' }]));
    h.advance(2 * 60 * 60_000);
    h.poll();
    expect(h.agents()).toEqual([]);
  });
});