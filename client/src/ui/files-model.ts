// Navegador de arquivos: partes puras (URLs, migalhas, escolha de raiz, validação das respostas). Sem DOM.
// Rotas em server/http/files.ts; a janela é ui/files.ts.
import type { FileEntry, FileListing, FileRoot } from '../../../shared/types';

export const FILES_URL = '/api/files';

/** URL do arquivo para ver (inline) ou baixar. */
export function rawUrl(path: string, download: boolean): string {
  return `${FILES_URL}/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}

export function listUrl(path: string): string {
  return `${FILES_URL}/list?path=${encodeURIComponent(path)}`;
}

/** Migalhas da raiz até a pasta: [{label: rótulo da raiz, path: raiz}, {label: 'sub', path: raiz/sub}, ...]. */
export function crumbs(root: FileRoot, dir: string): { label: string; path: string }[] {
  const out = [{ label: root.label, path: root.path }];
  if (dir === root.path || !dir.startsWith(root.path)) return out;
  const sep = root.path.includes('\\') && !root.path.includes('/') ? '\\' : '/';
  const base = root.path.endsWith(sep) ? root.path.slice(0, -1) : root.path;
  let at = base;
  for (const part of dir.slice(base.length).split(/[\\/]+/).filter(Boolean)) {
    at += sep + part;
    out.push({ label: part, path: at });
  }
  return out;
}

/** Raiz da sala (pelo roomId) ou, sem ela, a primeira; undefined sem raízes. */
export function rootFor(roots: readonly FileRoot[], roomId: string | undefined): FileRoot | undefined {
  return (roomId ? roots.find((r) => r.roomId === roomId) : undefined) ?? roots[0];
}

const KINDS = new Set(['image', 'pdf', 'video', 'page', 'text', 'file']);

function isRoot(v: unknown): v is FileRoot {
  const r = v as Partial<FileRoot> | null;
  return !!r && typeof r.path === 'string' && typeof r.label === 'string' && (r.roomId === undefined || typeof r.roomId === 'string');
}

function isEntry(v: unknown): v is FileEntry {
  const e = v as Partial<FileEntry> | null;
  return (
    !!e &&
    typeof e.name === 'string' &&
    !!e.name &&
    (e.type === 'dir' || e.type === 'file') &&
    typeof e.size === 'number' &&
    typeof e.mtime === 'number' &&
    (e.kind === undefined || KINDS.has(e.kind))
  );
}

/** Validação leve de GET /api/files (o que não tiver o formato certo fica de fora). */
export function parseRoots(v: unknown): FileRoot[] {
  const list = (v as { roots?: unknown } | null)?.roots;
  return Array.isArray(list) ? list.filter(isRoot) : [];
}

/** Validação leve de GET /api/files/list; null se a resposta não for uma listagem. */
export function parseListing(v: unknown): FileListing | null {
  const l = v as Partial<FileListing> | null;
  if (!l || typeof l.path !== 'string' || typeof l.root !== 'string' || !Array.isArray(l.entries)) return null;
  return { path: l.path, root: l.root, entries: l.entries.filter(isEntry), truncated: l.truncated === true };
}
