// Arquivos de uma sessão do Kiro CLI 3.x: <kiroDir>/sessions/<hash da pasta de trabalho>/<sessionId>/
//   messages.jsonl  (o transcript: uma linha {id, timestamp, payload:{type, ...}} por evento)
//   session.json    (título, agente, modelo, pastas de trabalho, criação e última mudança)
// e a trava da sessão aberta em <kiroDir>/session-leases/<sessionId>.lease ({pid, parentPid, acquiredAt, ...}).
// O <hash> não é recalculado aqui: procura em cada pasta de sessions/, menos a cli/ do 2.x.
import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Id de sessão que pode virar nome de pasta (3.x: cli_<uuid>_<sufixo>, sess_<uuid>): sem barra nem "..". */
const V3_SESSION_ID = /^[A-Za-z0-9][\w.-]{0,199}$/;

export function isKiroV3SessionId(sessionId: string): boolean {
  return V3_SESSION_ID.test(sessionId) && !sessionId.includes('..');
}

/** Pasta da sessão do 3.x (a que tem o messages.jsonl), ou undefined. `cache` guarda o achado. */
export function kiroV3SessionDir(kiroDir: string, sessionId: string, cache?: Map<string, string>): string | undefined {
  if (!isKiroV3SessionId(sessionId)) return undefined;
  const key = `${kiroDir}\0${sessionId}`;
  const known = cache?.get(key);
  if (known && existsSync(join(known, 'messages.jsonl'))) return known;
  const root = join(kiroDir, 'sessions');
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'cli')
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const dir = join(root, d, sessionId);
    if (existsSync(join(dir, 'messages.jsonl'))) {
      cache?.set(key, dir);
      return dir;
    }
  }
  return undefined;
}

/** Transcript (messages.jsonl) da sessão do 3.x, ou undefined. */
export function kiroV3TranscriptPath(kiroDir: string, sessionId: string, cache?: Map<string, string>): string | undefined {
  const dir = kiroV3SessionDir(kiroDir, sessionId, cache);
  return dir ? join(dir, 'messages.jsonl') : undefined;
}

/** Id do personagem de um subagente do 3.x: "<sessionId>:<subSessionId>". */
export function kiroV3SubAgentId(sessionId: string, subSessionId: string): string {
  return `${sessionId}:${subSessionId}`;
}

/** Separa "<sessionId>:<subSessionId>" (os dois sem barra nem ".."), ou undefined. */
export function parseKiroV3SubAgentId(agentId: string): { sessionId: string; subSessionId: string } | undefined {
  const i = agentId.indexOf(':');
  if (i <= 0) return undefined;
  const sessionId = agentId.slice(0, i);
  const subSessionId = agentId.slice(i + 1);
  return isKiroV3SessionId(sessionId) && isKiroV3SessionId(subSessionId) ? { sessionId, subSessionId } : undefined;
}

/** Transcript de um subagente: <pasta da sessão>/sub-executions/<subSessionId>.jsonl (mesmo formato do messages.jsonl). */
export function kiroV3SubTranscriptFile(sessionDir: string, subSessionId: string): string | undefined {
  return isKiroV3SessionId(subSessionId) ? join(sessionDir, 'sub-executions', `${subSessionId}.jsonl`) : undefined;
}

/** Transcript do subagente pelo id do personagem ("<sessionId>:<subSessionId>"), se o arquivo existir. */
export function kiroV3SubTranscriptPath(kiroDir: string, agentId: string, cache?: Map<string, string>): string | undefined {
  const ref = parseKiroV3SubAgentId(agentId);
  if (!ref) return undefined;
  const dir = kiroV3SessionDir(kiroDir, ref.sessionId, cache);
  const file = dir ? kiroV3SubTranscriptFile(dir, ref.subSessionId) : undefined;
  return file && existsSync(file) ? file : undefined;
}

/** Trava da sessão aberta (3.x). */
export function kiroV3LeasePath(kiroDir: string, sessionId: string): string | undefined {
  return isKiroV3SessionId(sessionId) ? join(kiroDir, 'session-leases', `${sessionId}.lease`) : undefined;
}

export interface KiroV3SessionRef {
  sessionId: string;
  /** Pasta da sessão (<kiroDir>/sessions/<hash>/<sessionId>). */
  dir: string;
}

/** Todas as sessões do 3.x de um <kiroDir> (pastas com messages.jsonl), para o histórico. */
export async function listKiroV3Sessions(kiroDir: string): Promise<KiroV3SessionRef[]> {
  const root = join(kiroDir, 'sessions');
  let hashes: string[];
  try {
    hashes = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'cli').map((d) => d.name);
  } catch {
    return [];
  }
  const out: KiroV3SessionRef[] = [];
  for (const h of hashes) {
    let names: string[];
    try {
      names = (await readdir(join(root, h), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const sessionId of names) {
      if (!isKiroV3SessionId(sessionId)) continue;
      const dir = join(root, h, sessionId);
      if (existsSync(join(dir, 'messages.jsonl'))) out.push({ sessionId, dir });
    }
  }
  return out;
}
