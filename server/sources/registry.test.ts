import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import type { ProcLookup, ProcStart, ProcStarts } from './procstart';
import { compareVersions, parseRegistryEntry, parseStaleSessions, registryLastWrite, registryStatus, RegistryReader, staleKey } from './registry';

const entry = (pid: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, cwd: '/projetos/app', startedAt: 1, kind: 'interactive', status: 'idle', ...extra });

describe('registro de sessões', () => {
  let tmp: ReturnType<typeof tempDir>;
  let sessions: string;
  beforeEach(() => {
    tmp = tempDir();
    sessions = join(tmp.dir, 'sessions');
    mkdirSync(sessions);
  });
  afterEach(() => tmp.cleanup());

  it('mapeia busy/idle/waiting/shell', () => {
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'busy' }))!)).toEqual({ status: 'working' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'idle' }))!)).toEqual({ status: 'idle' });
    // Ocioso com shell em segundo plano rodando (Claude Code 2.1.292+).
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'shell' }))!)).toEqual({ status: 'shell' });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'input needed' }))!)).toEqual({
      status: 'waiting',
      waitingFor: 'responder uma pergunta',
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: 'waiting', waitingFor: 'Allow Bash(rm -rf x)?' }))!)).toEqual({
      status: 'waiting',
      waitingFor: 'aprovar uma permissão',
    });
    expect(registryStatus(parseRegistryEntry(entry(1, { status: undefined }))!)).toEqual({});
  });

  it('compara versões do Claude Code', () => {
    expect(compareVersions('2.1.292', '2.1.292')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.292')).toBeGreaterThan(0);
    expect(compareVersions('2.1.29', '2.1.292')).toBeLessThan(0);
    expect(compareVersions('2.2.0-beta', '2.1.999')).toBeGreaterThan(0);
  });

  it('rejeita registros sem os campos essenciais', () => {
    expect(parseRegistryEntry('{"pid":1}')).toBeUndefined();
    expect(parseRegistryEntry('não é json')).toBeUndefined();
    expect(parseRegistryEntry(entry(7, { agent: 'frinus' }))).toMatchObject({ pid: 7, sessionId: 's-7', agent: 'frinus' });
  });

  it('lista sessões vivas, ignora .key e confere o PID fora do Docker', () => {
    writeFileSync(join(sessions, '10.json'), entry(10));
    writeFileSync(join(sessions, '11.json'), entry(11));
    writeFileSync(join(sessions, '10.abcdef.key'), 'segredo');
    const alive = new Set([10]);
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: (pid) => alive.has(pid) });
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    const docker = new RegistryReader(tmp.dir, { checkPid: false });
    expect(docker.poll().entries.map((e) => e.pid).sort()).toEqual([10, 11]);
  });

  it('JSON inválido (gravação em andamento) mantém a última versão boa', () => {
    const file = join(sessions, '20.json');
    writeFileSync(file, entry(20, { status: 'busy' }));
    const reader = new RegistryReader(tmp.dir, { checkPid: false });
    expect(reader.poll().entries[0].status).toBe('busy');
    writeFileSync(file, '{"pid":20,"sessionId":"s-20","cw');
    expect(reader.poll().entries[0].status).toBe('busy');
    writeFileSync(file, entry(20, { status: 'idle', extra: 'x' }));
    expect(reader.poll().entries[0].status).toBe('idle');
    rmSync(file);
    expect(reader.poll().entries).toEqual([]);
  });

  it('pasta sessions/ ausente é reportada como fonte com problema', () => {
    const reader = new RegistryReader(join(tmp.dir, 'nada'), { checkPid: false });
    expect(reader.poll()).toMatchObject({ ok: false, entries: [] });
  });

  it('guarda o `procStart`; a última gravação vem dos horários do registro (ou da data do arquivo)', () => {
    const e = parseRegistryEntry(entry(7, { procStart: '134381216624905399', startedAt: 100, updatedAt: 300, statusUpdatedAt: 250 }))!;
    expect(e.procStart).toBe('134381216624905399');
    expect(registryLastWrite(e, 9_999)).toBe(300);
    expect(registryLastWrite(parseRegistryEntry(entry(7, { startedAt: undefined }))!, 9_999)).toBe(9_999);
  });
});

// ------------------------------------------------------------------ registros antigos

/** Consulta de mentira: `table` é o que o sistema operacional diria de cada PID (ausente = o processo não existe). */
function fakeProcs(table: Map<number, ProcStart | null>, fail = false) {
  const calls = { sync: [] as number[][], async: [] as number[][] };
  const answer = (pids: readonly number[]): ProcStarts | undefined =>
    fail ? undefined : new Map(pids.filter((p) => table.has(p)).map((p) => [p, table.get(p)!]));
  const procs: ProcLookup = {
    sync: (pids) => (calls.sync.push([...pids]), answer(pids)),
    async: (pids) => (calls.async.push([...pids]), Promise.resolve(answer(pids))),
  };
  return { procs, calls };
}

const flush = () => new Promise((ok) => setTimeout(ok, 0));
const T0 = 1_793_648_064_000;
/** Registro gravado pela última vez em `at` (padrão T0). */
const reg = (pid: number, at = T0, extra: Record<string, unknown> = {}) => entry(pid, { startedAt: at - 1_000, updatedAt: at, ...extra });
/** Processo que já existia quando o registro foi gravado / que só nasceu dias depois. */
const BEFORE = { startMs: T0 - 2_000 };
const DAYS_LATER = { startMs: T0 + 13 * 86_400_000 };

describe('registros antigos (o processo morreu e o arquivo ficou)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let sessions: string;
  beforeEach(() => {
    tmp = tempDir();
    sessions = join(tmp.dir, 'sessions');
    mkdirSync(sessions);
  });
  afterEach(() => tmp.cleanup());

  it('PID reaproveitado por outro processo: o registro não aparece, já na primeira leitura (uma consulta só, bloqueando)', () => {
    writeFileSync(join(sessions, '10.json'), reg(10));
    writeFileSync(join(sessions, '2932.json'), reg(2932));
    writeFileSync(join(sessions, '30.json'), reg(30));
    writeFileSync(join(sessions, '40.json'), reg(40));
    // 10: o processo da sessão; 2932: um svchost que nasceu 13 dias depois; 30: início ilegível; 40: morreu.
    const { procs, calls } = fakeProcs(new Map<number, ProcStart | null>([[10, BEFORE], [2932, DAYS_LATER], [30, null]]));
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: (pid) => pid !== 40, procs });
    expect(reader.poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 30]);
    expect(calls.sync.map((p) => p.sort((a, b) => a - b))).toEqual([[10, 30, 2932]]);
    // O que já foi conferido não é consultado de novo, nem quando o registro é regravado (mudança de status).
    writeFileSync(join(sessions, '10.json'), reg(10, T0 + 60_000, { status: 'busy', waitingFor: 'x' }));
    expect(reader.poll().entries.map((e) => [e.pid, e.status]).sort()).toEqual([[10, 'busy'], [30, 'idle']]);
    expect(calls.sync).toHaveLength(1);
    expect(calls.async).toHaveLength(0);
  });

  it('`procStart` igual ao início lido: é a sessão, mesmo com o registro "mais velho" que o processo', () => {
    const ft = '134381216624905399';
    writeFileSync(join(sessions, '10.json'), reg(10, T0, { procStart: ft }));
    writeFileSync(join(sessions, '11.json'), reg(11, T0, { procStart: ft }));
    const procs = fakeProcs(new Map([[10, { startMs: T0 + 86_400_000, fileTime: ft }], [11, { startMs: T0 + 86_400_000, fileTime: '134382080624905399' }]])).procs;
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: () => true, procs });
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
  });

  it('sem resposta da consulta: tudo aparece, como sempre apareceu', () => {
    writeFileSync(join(sessions, '10.json'), reg(10));
    writeFileSync(join(sessions, '2932.json'), reg(2932));
    const { procs, calls } = fakeProcs(new Map(), true);
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: () => true, procs });
    expect(reader.poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 2932]);
    reader.poll();
    expect(calls.sync).toHaveLength(1);
    expect(calls.async).toHaveLength(0);
  });

  it('registro que chega depois: conferido sem bloquear, e só aparece com a resposta', async () => {
    const table = new Map<number, ProcStart | null>([[10, BEFORE]]);
    const { procs, calls } = fakeProcs(table);
    let changes = 0;
    writeFileSync(join(sessions, '10.json'), reg(10));
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: () => true, procs, onChange: () => changes++ });
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    // Uma sessão nova (o processo dela) e um registro antigo cujo PID acabou de voltar a existir (outro processo).
    table.set(20, { startMs: T0 + 100_000 });
    table.set(2932, DAYS_LATER);
    writeFileSync(join(sessions, '20.json'), reg(20, T0 + 101_000));
    writeFileSync(join(sessions, '2932.json'), reg(2932));
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    expect(reader.poll().entries.map((e) => e.pid)).toEqual([10]);
    expect(calls.async.map((p) => p.sort((a, b) => a - b))).toEqual([[20, 2932]]);
    expect(changes).toBe(0);
    await flush();
    expect(changes).toBe(1);
    expect(reader.poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 20]);
    expect(calls.sync).toHaveLength(1);
    expect(calls.async).toHaveLength(1);
  });

  it('o processo sai e o PID volta com outro: a conferência recomeça', async () => {
    const table = new Map<number, ProcStart | null>([[10, BEFORE]]);
    const { procs, calls } = fakeProcs(table);
    const alive = new Set([10]);
    writeFileSync(join(sessions, '10.json'), reg(10));
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: (pid) => alive.has(pid), procs });
    expect(reader.poll().entries).toHaveLength(1);
    // A sessão morre sem apagar o registro.
    alive.delete(10);
    table.delete(10);
    expect(reader.poll().entries).toHaveLength(0);
    // Dias depois, o PID 10 é de outro processo.
    alive.add(10);
    table.set(10, DAYS_LATER);
    expect(reader.poll().entries).toHaveLength(0);
    await flush();
    expect(reader.poll().entries).toHaveLength(0);
    expect(calls.async).toEqual([[10]]);
  });

  it('dado como antigo e regravado depois: quem grava está vivo, volta a aparecer', () => {
    writeFileSync(join(sessions, '10.json'), reg(10));
    const { procs, calls } = fakeProcs(new Map([[10, DAYS_LATER]]));
    const reader = new RegistryReader(tmp.dir, { checkPid: true, isAlive: () => true, procs });
    expect(reader.poll().entries).toHaveLength(0);
    // (campo a mais: o leitor só relê o arquivo quando a data ou o tamanho mudam, e a data pode cair no mesmo instante)
    writeFileSync(join(sessions, '10.json'), reg(10, T0 + 14 * 86_400_000, { status: 'busy', waitingFor: 'x' }));
    expect(reader.poll().entries.map((e) => e.status)).toEqual(['busy']);
    expect(calls.sync).toHaveLength(1);
  });

  it('Docker: sem conferir PIDs, saem só os registros que o host listou (conta, PID, sessão e início)', () => {
    writeFileSync(join(sessions, '10.json'), reg(10));
    writeFileSync(join(sessions, '2932.json'), reg(2932));
    const stale = [{ account: '.claude', pid: 2932, sessionId: 's-2932', startedAt: T0 - 1_000 }];
    const isStale = parseStaleSessions(JSON.stringify(stale))!;
    const reader = (account: string) => new RegistryReader(tmp.dir, { checkPid: false, isStale: (e) => isStale(account, e) });
    expect(reader('.claude').poll().entries.map((e) => e.pid)).toEqual([10]);
    // Outra conta com um registro igual não é afetada.
    expect(reader('.claude-2').poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 2932]);
    // Um Claude Code novo que receba o PID 2932 grava outra sessão (ou outro início): aparece.
    const r = reader('.claude');
    writeFileSync(join(sessions, '2932.json'), entry(2932, { sessionId: 'nova', startedAt: T0 + 5_000 }));
    expect(r.poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 2932]);
    writeFileSync(join(sessions, '2932.json'), reg(2932, T0 + 9_000));
    expect(r.poll().entries.map((e) => e.pid).sort((a, b) => a - b)).toEqual([10, 2932]);
  });

  it('HABBLAUD_STALE_SESSIONS vazia, inválida ou sem itens aproveitáveis: nada a ignorar', () => {
    for (const raw of [undefined, '', '  ', 'não é json', '{}', '[]', '[null, 1, {"account":".claude"}, {"account":".claude","pid":"7","sessionId":"x"}]']) {
      expect(parseStaleSessions(raw), String(raw)).toBeUndefined();
    }
    const isStale = parseStaleSessions('[{"account":".claude","pid":7,"sessionId":"x"}, "lixo"]')!;
    expect(isStale('.claude', parseRegistryEntry(entry(7, { sessionId: 'x', startedAt: undefined }))!)).toBe(true);
    expect(isStale('.claude', parseRegistryEntry(entry(7, { sessionId: 'x' }))!)).toBe(false);
    expect(staleKey('a', { pid: 1, sessionId: 's', startedAt: 5 })).not.toBe(staleKey('a', { pid: 1, sessionId: 's' }));
  });
});
