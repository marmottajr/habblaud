// Navegador de arquivos da pasta de trabalho (/api/files*, http/files.ts). Só leitura: nada aqui escreve no disco.
// Raízes = pastas das salas + ~/projetos. Nada com "." no nome (configurações, .git, .omp com o token do gateway)
// nem com cara de segredo aparece ou sai. Links que saem da raiz não contam. Toda rota que lê arquivo do usuário
// passa por locate(): é ele que garante a contenção.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, parse, sep } from 'node:path';
import { tr } from '../../shared/i18n';
import type { FileEntry, FileRoot } from '../../shared/types';
import { fileType, isSecretPath } from '../deliveries/files';

export const FILE_LIST_MAX = 2000;

/** Só o que o navegador de arquivos usa do disco; os testes podem simular. */
export interface BrowseFs {
  realpath(p: string): string;
  stat(p: string): { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number };
  readdir(p: string): string[];
}

const realFs: BrowseFs = {
  realpath: (p) => realpathSync(p),
  stat: (p) => statSync(p),
  readdir: (p) => readdirSync(p),
};

/** Nome que nunca aparece nem sai: começa com "." (configurações, .git, .omp com o token do gateway) ou tem cara de segredo. */
export function hiddenName(name: string): boolean {
  return name.startsWith('.') || isSecretPath(name);
}

/** Segmentos do caminho (sem a raiz do disco: "/" ou "C:\"). */
function segments(path: string): string[] {
  return path.slice(parse(path).root.length).split(/[\\/]+/).filter(Boolean);
}

/** `real` é a própria raiz ou está dentro dela (nunca só startsWith: /a/proj-b não está em /a/proj). */
function within(real: string, root: string): boolean {
  return real === root || real.startsWith(root + sep);
}

/**
 * Raízes válidas: caminho real de cada candidato que existe e é pasta, sem repetir, e nunca "/" nem uma pasta com
 * menos de 2 níveis ("/home", "/tmp", "/habblaud"): sala aberta na raiz do disco não abre o disco inteiro.
 * Um candidato com segmento oculto (hiddenName em qualquer parte do caminho) também fica de fora.
 */
export function resolveRoots(candidates: readonly { path: string; label: string; roomId?: string }[], fs: BrowseFs = realFs): FileRoot[] {
  const out: FileRoot[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c.path || c.path.includes('\0') || !isAbsolute(c.path)) continue;
    try {
      const real = fs.realpath(c.path);
      const segs = segments(real);
      if (segs.length < 2 || segs.some(hiddenName) || seen.has(real) || !fs.stat(real).isDirectory()) continue;
      seen.add(real);
      out.push({ path: real, label: c.label, ...(c.roomId ? { roomId: c.roomId } : {}) });
    } catch {
      // não existe ou sem permissão: não vira raiz
    }
  }
  return out;
}

const OUTSIDE = (): { status: 404; error: string } => ({ status: 404, error: tr('pasta ou arquivo fora da pasta de trabalho') });

/**
 * Caminho real dentro de alguma raiz, ou o motivo. Recusa: vazio, com \0, relativo, com segmento "..";
 * caminho real fora de todas as raízes; qualquer segmento DEPOIS da raiz (no caminho pedido e no real) com
 * hiddenName. Devolve a raiz que contém (a mais longa, se houver aninhadas).
 */
export function locate(
  path: string,
  roots: readonly FileRoot[],
  fs: BrowseFs = realFs,
): { path: string; root: string; isDir: boolean; size: number } | { status: 400 | 404; error: string } {
  if (!path || path.includes('\0') || !isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    return { status: 400, error: tr('caminho inválido') };
  }
  try {
    const real = fs.realpath(path);
    let root: FileRoot | undefined;
    for (const r of roots) if (within(real, r.path) && (!root || r.path.length > root.path.length)) root = r;
    if (!root) return OUTSIDE();
    if (segments(real.slice(root.path.length)).some(hiddenName)) return OUTSIDE();
    // O caminho pedido também: um link visível para uma pasta visível passa, mas ".git/x" pedido direto não.
    const asked = path.startsWith(root.path) ? path.slice(root.path.length) : '';
    if (segments(asked).some(hiddenName)) return OUTSIDE();
    const st = fs.stat(real);
    if (!st.isFile() && !st.isDirectory()) return OUTSIDE();
    return { path: real, root: root.path, isDir: st.isDirectory(), size: st.size };
  } catch {
    return OUTSIDE();
  }
}

/**
 * Lista a pasta (já localizada): sem ocultos; links seguidos só se o alvo real ficar dentro de `root`.
 * shortcut: pasta com mais de FILE_LIST_MAX itens mostra os primeiros por nome, não todas as subpastas; trocar por
 * paginação se alguém reclamar. (Evita `stat` de 100 mil itens; a ordem pastas-antes vale dentro do que voltou.)
 */
export function listDir(dir: string, root: string, fs: BrowseFs = realFs): { entries: FileEntry[]; truncated: boolean } {
  const names = fs
    .readdir(dir)
    .filter((n) => !hiddenName(n))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const entries: FileEntry[] = [];
  let truncated = false;
  for (const name of names) {
    const full = dir.endsWith(sep) ? dir + name : dir + sep + name;
    let entry: FileEntry | undefined;
    try {
      const real = fs.realpath(full);
      if (!within(real, root)) continue;
      const st = fs.stat(real);
      if (st.isDirectory()) entry = { name, type: 'dir', size: 0, mtime: st.mtimeMs };
      else if (st.isFile()) {
        const kind = fileType(name)?.kind;
        entry = { name, type: 'file', size: st.size, mtime: st.mtimeMs, ...(kind ? { kind } : {}) };
      }
    } catch {
      // link quebrado ou sem permissão: pula
    }
    if (!entry) continue;
    if (entries.length >= FILE_LIST_MAX) {
      truncated = true;
      break;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return { entries, truncated };
}
