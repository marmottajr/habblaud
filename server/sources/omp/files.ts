// Arquivos de uma agent dir do omp que a fonte lê: as sessões principais (`sessions/<pasta>/<início>_<uuidv7>.jsonl`) e
// os subagentes de cada uma (`<arquivo sem .jsonl>/<Nome>.jsonl`, pasta irmã). Só leitura: nada é criado; `agent.db`,
// `history.db`, `config.yml`, `models.yml`, blobs e logs nunca são abertos.
//
// Presença (o omp não grava registro de sessões abertas; o lock dele é do sistema operacional e não aparece de fora):
// a sessão está viva se o arquivo mudou nos últimos PRESENT_MS e a última linha NÃO é o `session_exit` (saída limpa).
// Retomar uma sessão acrescenta linhas depois do session_exit, e aí ela volta a valer.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OMP_SESSIONS_DIR } from './accounts';
import { parseOmpHead, type OmpHead } from './parser';

/** Sem `session_exit`, o arquivo parado há mais que isto não é mais uma sessão aberta. */
export const PRESENT_MS = 10 * 60_000;

/** `<AAAA-MM-DDThh-mm-ss-mmmZ>_<uuidv7>.jsonl` */
const MAIN_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Id da sessão pelo nome do arquivo principal; undefined = não é uma sessão do omp. */
export function parseSessionName(name: string): string | undefined {
  return MAIN_FILE.exec(name)?.[2].toLowerCase();
}

export interface OmpFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface OmpSubFile {
  /** Nome do subagente: o `<Nome>` do `<Nome>.jsonl`. */
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** mtime e tamanho de um arquivo comum; undefined se não existe. */
export function statFile(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined;
  } catch {
    return undefined;
  }
}

/** Pastas de projeto de `sessions/` (cada uma guarda as sessões de um cwd). */
export function projectDirs(agentDir: string): string[] {
  const root = join(agentDir, OMP_SESSIONS_DIR);
  const out: string[] = [];
  for (const name of listDir(root)) {
    const p = join(root, name);
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // sumiu
    }
  }
  return out;
}

/** Índice das sessões principais de uma agent dir (varredura completa; o chamador decide a cadência). */
export class OmpIndex {
  private files = new Map<string, OmpFile>();

  constructor(readonly agentDir: string) {}

  /** Varre as pastas de projeto de sessions/ atrás de arquivos com cara de sessão. Devolve os achados. */
  scan(): OmpFile[] {
    const next = new Map<string, OmpFile>();
    for (const dir of projectDirs(this.agentDir)) {
      for (const name of listDir(dir)) {
        const sessionId = parseSessionName(name);
        if (!sessionId) continue;
        const path = join(dir, name);
        const st = statFile(path);
        if (!st) continue;
        const prev = next.get(sessionId);
        if (!prev || st.mtimeMs >= prev.mtimeMs) next.set(sessionId, { sessionId, path, ...st });
      }
    }
    this.files = next;
    return [...next.values()];
  }

  /** Último resultado da varredura. */
  all(): OmpFile[] {
    return [...this.files.values()];
  }

  /** O arquivo de uma sessão (do último scan; o stat é refeito). */
  find(sessionId: string): OmpFile | undefined {
    const f = this.files.get(sessionId.toLowerCase());
    if (!f) return undefined;
    const st = statFile(f.path);
    if (!st) {
      this.files.delete(f.sessionId);
      return undefined;
    }
    f.mtimeMs = st.mtimeMs;
    f.size = st.size;
    return f;
  }

  /** Pastas de projeto atuais (para o fs.watch). */
  dirs(): string[] {
    return projectDirs(this.agentDir);
  }
}

/** Subagentes de uma sessão: `<arquivo sem .jsonl>/<Nome>.jsonl`. */
export function subagentsOf(mainPath: string): OmpSubFile[] {
  const dir = mainPath.replace(/\.jsonl$/i, '');
  if (dir === mainPath) return [];
  const out: OmpSubFile[] = [];
  for (const name of listDir(dir)) {
    if (!/\.jsonl$/i.test(name)) continue;
    const path = join(dir, name);
    const st = statFile(path);
    if (st) out.push({ name: name.slice(0, -'.jsonl'.length), path, ...st });
  }
  return out;
}

// ------------------------------------------------------------------ leitura curta

/** Quanto do começo do arquivo cobre o slot do título e o cabeçalho (o do subagente tem o caminho do pai). */
const HEAD_BYTES = 16 * 1024;
/** Quanto do fim cobre a última linha (o `session_exit` tem ~250 bytes). */
const END_BYTES = 4 * 1024;

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** O começo do arquivo: título do slot e cabeçalho. Arquivo ilegível ou ainda sem as duas linhas = sem cabeçalho. */
export function readOmpHead(path: string): OmpHead {
  try {
    return parseOmpHead(readRange(path, 0, HEAD_BYTES).toString('utf8'));
  } catch {
    return { bytes: 0 };
  }
}

/** A última linha do arquivo é o `session_exit` (saída limpa)? Sem nada gravado depois dele. */
export function endsWithExit(path: string, size: number): boolean {
  try {
    const start = Math.max(0, size - END_BYTES);
    const text = readRange(path, start, size - start).toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last || !last.includes('"session_exit"')) return false;
    const j = JSON.parse(last) as { type?: unknown; customType?: unknown };
    return j.type === 'custom' && j.customType === 'session_exit';
  } catch {
    return false;
  }
}

/**
 * A sessão está viva? Mudou há menos de PRESENT_MS e não terminou com `session_exit`. O resultado do `endsWithExit` é
 * guardado por (caminho, tamanho): o arquivo só é aberto quando cresce.
 */
export class LivenessCache {
  private exits = new Map<string, { size: number; exited: boolean }>();

  isLive(file: { path: string; mtimeMs: number; size: number }, now: number): boolean {
    if (now - file.mtimeMs > PRESENT_MS) return false;
    let hit = this.exits.get(file.path);
    if (!hit || hit.size !== file.size) {
      hit = { size: file.size, exited: endsWithExit(file.path, file.size) };
      this.exits.set(file.path, hit);
    }
    return !hit.exited;
  }

  /** Esquece o que não é mais acompanhado (evita crescer sem fim). */
  retain(paths: ReadonlySet<string>): void {
    for (const p of this.exits.keys()) if (!paths.has(p)) this.exits.delete(p);
  }
}
