import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { FILE_LIST_MAX, listDir, locate, resolveRoots, type BrowseFs } from './browse';

const cleanups: (() => void)[] = [];
function tmp(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return realpathSync(t.dir);
}
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function proj(): { tmp: string; root: string } {
  const t = tmp();
  const root = join(t, 'proj');
  mkdirSync(join(root, 'sub'), { recursive: true });
  return { tmp: t, root };
}

describe('resolveRoots', () => {
  it('descarta /, pasta de 1 nível, inexistente, arquivo e repetição', () => {
    const { tmp: t, root } = proj();
    writeFileSync(join(t, 'arquivo.txt'), 'x');
    symlinkSync(root, join(t, 'alias'));
    const roots = resolveRoots([
      { path: '/', label: 'raiz' },
      { path: '/tmp', label: 'um nível' },
      { path: join(t, 'nao-existe'), label: 'nada' },
      { path: join(t, 'arquivo.txt'), label: 'arquivo' },
      { path: root, label: 'proj', roomId: 'r1' },
      { path: join(t, 'alias'), label: 'alias' },
    ]);
    expect(roots).toEqual([{ path: root, label: 'proj', roomId: 'r1' }]);
  });
});

describe('locate', () => {
  it('aceita a própria raiz e um arquivo dentro dela', () => {
    const { root } = proj();
    writeFileSync(join(root, 'a.txt'), 'abc');
    const roots = resolveRoots([{ path: root, label: 'proj' }]);
    expect(locate(root, roots)).toEqual({ path: root, root, isDir: true, size: expect.any(Number) });
    expect(locate(join(root, 'a.txt'), roots)).toEqual({ path: join(root, 'a.txt'), root, isDir: false, size: 3 });
  });

  it('recusa .., relativo e \\0 com 400', () => {
    const { root } = proj();
    const roots = resolveRoots([{ path: root, label: 'proj' }]);
    for (const p of [`${root}/../x`, 'proj/a.txt', `${root}/a\0b`, '']) {
      expect(locate(p, roots)).toMatchObject({ status: 400 });
    }
  });

  it('404 para pasta irmã com prefixo igual', () => {
    const { tmp: t, root } = proj();
    mkdirSync(join(t, 'proj-b'));
    writeFileSync(join(t, 'proj-b', 'a.txt'), 'x');
    const roots = resolveRoots([{ path: root, label: 'proj' }]);
    expect(locate(join(t, 'proj-b', 'a.txt'), roots)).toMatchObject({ status: 404 });
  });

  it.skipIf(process.platform === 'win32')('404 para link dentro da raiz que aponta para fora', () => {
    const { tmp: t, root } = proj();
    writeFileSync(join(t, 'fora.txt'), 'x');
    symlinkSync(join(t, 'fora.txt'), join(root, 'link.txt'));
    symlinkSync(t, join(root, 'linkdir'));
    const roots = resolveRoots([{ path: root, label: 'proj' }]);
    expect(locate(join(root, 'link.txt'), roots)).toMatchObject({ status: 404 });
    expect(locate(join(root, 'linkdir', 'fora.txt'), roots)).toMatchObject({ status: 404 });
  });

  it('404 para ocultos e segredos', () => {
    const { root } = proj();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.env'), 's');
    writeFileSync(join(root, '.git', 'config'), 's');
    writeFileSync(join(root, 'sub', 'id_rsa'), 's');
    writeFileSync(join(root, 'token.txt'), 's');
    const roots = resolveRoots([{ path: root, label: 'proj' }]);
    for (const p of ['.env', '.git/config', 'sub/id_rsa', 'token.txt']) {
      expect(locate(join(root, p), roots)).toMatchObject({ status: 404 });
    }
  });
});

describe('listDir', () => {
  it('esconde ocultos/segredos e link para fora, mostra link para dentro, pastas antes, kind e size', () => {
    const { tmp: t, root } = proj();
    writeFileSync(join(root, 'b.png'), '12345');
    writeFileSync(join(root, 'a.ts'), 'x');
    writeFileSync(join(root, '.env'), 's');
    writeFileSync(join(root, 'token.txt'), 's');
    writeFileSync(join(t, 'fora.txt'), 'x');
    if (process.platform !== 'win32') {
      symlinkSync(join(t, 'fora.txt'), join(root, 'fora-link.txt'));
      symlinkSync(join(root, 'a.ts'), join(root, 'dentro-link.ts'));
    }
    const { entries, truncated } = listDir(root, root);
    expect(truncated).toBe(false);
    const names = entries.map((e) => e.name);
    expect(names[0]).toBe('sub');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('token.txt');
    expect(names).not.toContain('fora-link.txt');
    if (process.platform !== 'win32') expect(names).toContain('dentro-link.ts');
    const png = entries.find((e) => e.name === 'b.png')!;
    expect(png).toMatchObject({ type: 'file', size: 5, kind: 'image' });
    expect(entries.find((e) => e.name === 'a.ts')!.kind).toBeUndefined();
    expect(entries[0].type).toBe('dir');
  });

  it('corta em FILE_LIST_MAX com truncated', () => {
    const names = Array.from({ length: FILE_LIST_MAX + 5 }, (_, i) => `f${String(i).padStart(5, '0')}.txt`);
    const fs: BrowseFs = {
      realpath: (p) => p,
      stat: () => ({ isFile: () => true, isDirectory: () => false, size: 1, mtimeMs: 1 }),
      readdir: () => names,
    };
    const r = listDir('/a/b', '/a/b', fs);
    expect(r.entries).toHaveLength(FILE_LIST_MAX);
    expect(r.truncated).toBe(true);
  });
});
