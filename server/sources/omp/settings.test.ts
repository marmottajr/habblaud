import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OmpSettings } from './settings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(join(tmpdir(), 'omp-settings-'));
  dirs.push(d);
  return join(d, 'sub', 'omp.json');
};

describe('OmpSettings (Configurações › Sala do omp segue o projeto)', () => {
  it('desligada sem arquivo; ligar grava e sobrevive a um novo load', () => {
    const f = file();
    const a = new OmpSettings(f);
    a.load();
    expect(a.roomByProject).toBe(false);
    a.setRoomByProject(true);
    const b = new OmpSettings(f);
    b.load();
    expect(b.roomByProject).toBe(true);
  });

  it('arquivo ilegível ou com valor que não é true: desligada', () => {
    const f = file();
    new OmpSettings(f).setRoomByProject(false);
    writeFileSync(f, '{ quebrado');
    const a = new OmpSettings(f);
    a.load();
    expect(a.roomByProject).toBe(false);
    writeFileSync(f, JSON.stringify({ roomByProject: 'sim' }));
    a.load();
    expect(a.roomByProject).toBe(false);
  });
});
