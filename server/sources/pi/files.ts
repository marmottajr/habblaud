// Arquivos de sessão do Pi (`<piDir>/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`).
// Somente leitura.
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePiHeaderLine, type PiMeta } from './session';

export const PI_SESSIONS_DIR = 'sessions';

/** `<AAAA-MM-DDThh-mm-ss-SSSZ>_<sessionId>.jsonl` ou `<sessionId>.jsonl`. */
const TIMESTAMPED_SESSION = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z_([0-9a-zA-Z_-]{6,80})\.jsonl$/;
const PLAIN_SESSION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const VALID_SESSION_ID = /^[0-9a-zA-Z_-]{6,80}$/;

/** Id de sessão válido (sem path traversal). */
export function isPiSessionId(id: string): boolean {
  return VALID_SESSION_ID.test(id);
}

/** Extrai o sessionId do nome do arquivo .jsonl do Pi; undefined = não é um arquivo de sessão. */
export function parsePiSessionName(name: string): { sessionId: string } | undefined {
  const m = TIMESTAMPED_SESSION.exec(name) ?? PLAIN_SESSION.exec(name);
  return m ? { sessionId: m[1] } : undefined;
}

/** Subpastas de projeto dentro de `<piDir>/sessions/`. */
export function piSessionDirs(agentDir: string): string[] {
  const root = join(agentDir, PI_SESSIONS_DIR);
  const out: string[] = [];
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() || ent.isSymbolicLink()) out.push(join(root, ent.name));
    }
  } catch {
    // pasta ainda não existe
  }
  return out;
}

/** Lê a primeira linha do arquivo de sessão do Pi (cabeçalho `type: "session"`). */
export function readPiHeader(path: string, maxBytes = 64 * 1024): PiMeta | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    if (bytes <= 0) return undefined;
    const text = buf.toString('utf8', 0, bytes);
    const nl = text.indexOf('\n');
    const first = nl === -1 ? text : text.slice(0, nl);
    return parsePiHeaderLine(first);
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignora
    }
  }
}

export interface RecentPiFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Índice em memória dos arquivos de sessão de uma pasta do Pi (sessionId → caminho). */
export class PiSessionIndex {
  private readonly byId = new Map<string, string>();
  private scannedAt = 0;

  constructor(private readonly agentDir: string) {}

  /** Caminho conhecido (ou procura no disco se não estiver em cache). */
  find(sessionId: string, now: number): string | undefined {
    const cached = this.byId.get(sessionId);
    if (cached) {
      try {
        if (statSync(cached).isFile()) return cached;
      } catch {
        this.byId.delete(sessionId);
      }
    }
    if (now - this.scannedAt >= 2_000) this.scan(now);
    return this.byId.get(sessionId);
  }

  /** Registra explicitamente o arquivo de uma sessão (ex.: vindo de um evento ao vivo da extensão). */
  remember(sessionId: string, path: string): void {
    this.byId.set(sessionId, path);
  }

  /** Varre `<agentDir>/sessions/<projeto>/*.jsonl` e devolve os modificados dentro de `maxAgeMs`. */
  listRecent(now: number, maxAgeMs: number): RecentPiFile[] {
    this.scannedAt = now;
    const best = new Map<string, RecentPiFile>();
    for (const dir of piSessionDirs(this.agentDir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const parsed = parsePiSessionName(name);
        if (!parsed) continue;
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (!st.isFile()) continue;
          const prevPath = this.byId.get(parsed.sessionId);
          if (!prevPath) this.byId.set(parsed.sessionId, path);
          if (now - st.mtimeMs > maxAgeMs) continue;
          const prev = best.get(parsed.sessionId);
          if (!prev || st.mtimeMs > prev.mtimeMs) {
            best.set(parsed.sessionId, { sessionId: parsed.sessionId, path, mtimeMs: st.mtimeMs, size: st.size });
            this.byId.set(parsed.sessionId, path);
          }
        } catch {
          // arquivo sumiu durante a varredura
        }
      }
    }
    return [...best.values()];
  }

  private scan(now: number): void {
    this.scannedAt = now;
    for (const dir of piSessionDirs(this.agentDir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const parsed = parsePiSessionName(name);
        if (!parsed) continue;
        this.byId.set(parsed.sessionId, join(dir, name));
      }
    }
  }
}
