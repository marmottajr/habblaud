import { describe, expect, it } from 'vitest';
import type { FileRoot } from '../../../shared/types';
import { crumbs, listUrl, parseListing, parseRoots, rawUrl, rootFor } from './files-model';

const root: FileRoot = { path: '/home/u/proj', label: 'proj', roomId: 'r1' };

describe('rawUrl / listUrl', () => {
  it('codifica espaço, # e ? e só põe download=1 quando pedido', () => {
    expect(rawUrl('/a b/c#d?e.txt', false)).toBe('/api/files/raw?path=%2Fa%20b%2Fc%23d%3Fe.txt');
    expect(rawUrl('/a.txt', true)).toBe('/api/files/raw?path=%2Fa.txt&download=1');
    expect(listUrl('/a b')).toBe('/api/files/list?path=%2Fa%20b');
  });
});

describe('crumbs', () => {
  it('só a raiz na própria raiz', () => {
    expect(crumbs(root, root.path)).toEqual([{ label: 'proj', path: '/home/u/proj' }]);
  });
  it('1 e 3 níveis', () => {
    expect(crumbs(root, '/home/u/proj/sub')).toEqual([
      { label: 'proj', path: '/home/u/proj' },
      { label: 'sub', path: '/home/u/proj/sub' },
    ]);
    expect(crumbs(root, '/home/u/proj/a/b/c').map((c) => c.label)).toEqual(['proj', 'a', 'b', 'c']);
    expect(crumbs(root, '/home/u/proj/a/b/c').at(-1)!.path).toBe('/home/u/proj/a/b/c');
  });
  it('separador \\ do Windows', () => {
    const w: FileRoot = { path: 'C:\\u\\proj', label: 'proj' };
    expect(crumbs(w, 'C:\\u\\proj\\a\\b')).toEqual([
      { label: 'proj', path: 'C:\\u\\proj' },
      { label: 'a', path: 'C:\\u\\proj\\a' },
      { label: 'b', path: 'C:\\u\\proj\\a\\b' },
    ]);
  });
});

describe('rootFor', () => {
  const roots: FileRoot[] = [{ path: '/x/a', label: 'a' }, root];
  it('sala existente, ausente e lista vazia', () => {
    expect(rootFor(roots, 'r1')).toBe(root);
    expect(rootFor(roots, 'nao')).toBe(roots[0]);
    expect(rootFor(roots, undefined)).toBe(roots[0]);
    expect(rootFor([], 'r1')).toBeUndefined();
  });
});

describe('parse', () => {
  it('parseRoots ignora o que não é raiz', () => {
    expect(parseRoots({ roots: [root, { path: 1 }, null] })).toEqual([root]);
    expect(parseRoots(null)).toEqual([]);
  });
  it('parseListing recusa entrada sem name ou com type estranho', () => {
    const ok = { name: 'a', type: 'file', size: 1, mtime: 2 };
    const l = parseListing({ path: '/p', root: '/p', truncated: false, entries: [ok, { type: 'file', size: 1, mtime: 2 }, { ...ok, type: 'link' }] });
    expect(l?.entries).toEqual([ok]);
    expect(parseListing({ path: '/p' })).toBeNull();
  });
});
