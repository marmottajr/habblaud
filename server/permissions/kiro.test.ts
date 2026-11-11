// View dos pedidos de aprovação do Kiro (server/permissions/kiro.ts): título, resumo e argumentos pelos nomes de
// ferramenta do Kiro (shell/execute_bash -> comando; fs_write/write -> diff; outras -> genérico), com segredos
// mascarados. Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { kiroToolView } from './kiro';

describe('kiroToolView', () => {
  it('shell: título Bash(...), comando como "command" e segredo mascarado', () => {
    const v = kiroToolView('shell', { command: 'curl -H "Authorization: Bearer abcdef123456" https://api.x' });
    expect(v.title).toMatch(/^Bash\(curl/);
    expect(v.inputKind).toBe('command');
    expect(v.input).not.toContain('abcdef123456');
    expect(v.icon).toBeTruthy();
    expect(v.text).toBeTruthy();
  });

  it('execute_bash (2.x) também é shell', () => {
    const v = kiroToolView('execute_bash', { command: 'npm test' });
    expect(v.title).toMatch(/^Bash\(/);
    expect(v.inputKind).toBe('command');
  });

  it('fs_write (3.x): {path,text} vira diff do arquivo novo', () => {
    const v = kiroToolView('fs_write', { path: '/p/loja/x.ts', text: 'export const x = 1;\n' });
    expect(v.inputKind).toBe('diff');
    expect(v.input).toContain('x = 1');
  });

  it('read passa pelo genérico sem quebrar', () => {
    const v = kiroToolView('read', { operations: [{ mode: 'Line', path: '/a.ts' }] });
    expect(v.title).toBeTruthy();
    expect(v.text).toBeTruthy();
  });
});
