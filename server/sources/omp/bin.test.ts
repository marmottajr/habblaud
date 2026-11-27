import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ompBinFrom } from './bin';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmp(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

function touch(file: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
  return file;
}

describe('ompBinFrom (Windows: basta o arquivo existir)', () => {
  it('HABBLAUD_OMP_BIN com caminho vale se o arquivo existe; nome é procurado no PATH', () => {
    const dir = tmp();
    const file = touch(join(dir, 'meu-omp.exe'));
    expect(ompBinFrom({ HABBLAUD_OMP_BIN: file }, dir, 'win32')).toBe(file);
    expect(ompBinFrom({ HABBLAUD_OMP_BIN: join(dir, 'nao-existe.exe') }, dir, 'win32')).toBeUndefined();
    expect(ompBinFrom({ HABBLAUD_OMP_BIN: 'meu-omp', PATH: dir }, dir, 'win32')).toBe(file);
  });

  it('sem variável: omp no PATH antes do ~/.bun/bin; nenhum dos dois = undefined', () => {
    const home = tmp();
    const bin = tmp();
    expect(ompBinFrom({ PATH: bin }, home, 'win32')).toBeUndefined();
    const bun = touch(join(home, '.bun', 'bin', 'omp.exe'));
    expect(ompBinFrom({ PATH: bin }, home, 'win32')).toBe(bun);
    const inPath = touch(join(bin, 'omp.exe'));
    expect(ompBinFrom({ PATH: bin }, home, 'win32')).toBe(inPath);
  });

  it('Windows: um omp.cmd no PATH (node_modules/.bin) não serve; vale o omp.exe do bun', () => {
    const home = tmp();
    const bin = tmp();
    touch(join(bin, 'omp.cmd'));
    expect(ompBinFrom({ PATH: bin, PATHEXT: '.COM;.EXE;.CMD' }, home, 'win32')).toBeUndefined();
    const bun = touch(join(home, '.bun', 'bin', 'omp.exe'));
    expect(ompBinFrom({ PATH: bin, PATHEXT: '.COM;.EXE;.CMD' }, home, 'win32')).toBe(bun);
  });
});
