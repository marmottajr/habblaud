// Arquivos de uma pasta do Antigravity CLI (~/.gemini/antigravity-cli) que a fonte lê:
// - `conversations/<id>.db-wal` / `.db-shm`: existem somente enquanto o `agy` mantém a conversa aberta;
// - `jetbox_summaries_proto.pb`: resumos das conversas (título, status, workspace, pai de subagente, waiting_steps,
//   not_fully_idle, killed), lidos direto em protobuf puro sem abrir bancos SQLite;
// - `annotations/<id>.pbtxt`: título gerado para a conversa (`title:"..."`);
// - `history.jsonl`: histórico curto de entradas do TUI (`workspace`, `conversationId`, `display`);
// - `brain/<id>/.system_generated/logs/transcript.jsonl` (ou `transcript_full.jsonl`): passos da conversa.
// Só leitura: nada é criado e nenhum token ou credencial é aberto.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import { pathFromUri } from '../codex/rollout';
import { cleanPromptText } from './transcript';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WAL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db-(?:wal|shm)$/i;
const PBTXT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pbtxt$/i;

export const CONVERSATIONS_DIR = 'conversations';
export const BRAIN_DIR = 'brain';
export const ANNOTATIONS_DIR = 'annotations';
export const SUMMARIES_PROTO = 'jetbox_summaries_proto.pb';
export const HISTORY_FILE = 'history.jsonl';
export const TRANSCRIPT_REL = join('.system_generated', 'logs', 'transcript.jsonl');
export const TRANSCRIPT_FULL_REL = join('.system_generated', 'logs', 'transcript_full.jsonl');

const TITLE_MAX = 90;
const HISTORY_TAIL_BYTES = 256 * 1024;
const HEAD_SCAN_BYTES = 128 * 1024;

export function isConversationId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export interface WalInfo {
  conversationId: string;
  createdAt: number;
  mtimeMs: number;
}

/**
 * Conversas abertas agora pelos arquivos `.db-wal`/`.db-shm` em `conversations/` (o SQLite em modo WAL os cria ao
 * abrir a conversa e os apaga ao fechar); `null` = a pasta `conversations/` não existe.
 */
export function readOpenWals(home: string): Map<string, WalInfo> | null {
  const dir = join(home, CONVERSATIONS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const out = new Map<string, WalInfo>();
  for (const name of names) {
    const m = WAL_FILE.exec(name);
    if (!m) continue;
    const id = m[1].toLowerCase();
    try {
      const st = statSync(join(dir, name));
      const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
      const prev = out.get(id);
      if (!prev) out.set(id, { conversationId: id, createdAt: born, mtimeMs: st.mtimeMs });
      else {
        prev.createdAt = Math.min(prev.createdAt, born);
        prev.mtimeMs = Math.max(prev.mtimeMs, st.mtimeMs);
      }
    } catch {
      // sumiu entre a listagem e o stat
    }
  }
  return out;
}

// ------------------------------------------------------------------ jetbox_summaries_proto.pb + annotations + history

export type SummaryRunStatus = 'unspecified' | 'idle' | 'running' | 'busy' | 'canceling';

export interface ConversationSummary {
  conversationId: string;
  title?: string;
  stepCount?: number;
  cwd?: string;
  status?: SummaryRunStatus;
  waiting?: boolean;
  notFullyIdle?: boolean;
  killed?: boolean;
  parentConversationId?: string;
  rootConversationId?: string;
  agentRole?: string;
  createdAt?: number;
  lastModifiedAt?: number;
}

interface WireField {
  field: number;
  wire: number;
  varint?: bigint;
  bytes?: Buffer;
}

function decodeWire(buf: Buffer): WireField[] {
  const out: WireField[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0n;
    let shift = 0n;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
      if (shift > 63n) return out;
    }
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field <= 0) break;
    if (wire === 0) {
      let val = 0n;
      let s = 0n;
      while (i < buf.length) {
        const b = buf[i++];
        val |= BigInt(b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7n;
        if (s > 63n) return out;
      }
      out.push({ field, wire, varint: val });
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 28) return out;
      }
      if (len < 0 || i + len > buf.length) break;
      out.push({ field, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

function decodeTimestampMs(buf: Buffer | undefined): number | undefined {
  if (!buf) return undefined;
  let sec = 0;
  let nanos = 0;
  for (const f of decodeWire(buf)) {
    if (f.field === 1 && f.varint !== undefined) sec = Number(f.varint);
    else if (f.field === 2 && f.varint !== undefined) nanos = Number(f.varint);
  }
  return sec > 0 ? sec * 1_000 + Math.floor(nanos / 1_000_000) : undefined;
}

function firstStringField(buf: Buffer | undefined, fieldNo = 1): string | undefined {
  if (!buf) return undefined;
  for (const f of decodeWire(buf)) {
    if (f.field === fieldNo && f.bytes) {
      const s = f.bytes.toString('utf8').trim();
      if (s) return s;
    }
  }
  return undefined;
}

const RUN_STATUS_MAP: Record<number, SummaryRunStatus> = {
  0: 'unspecified',
  1: 'idle',
  2: 'running',
  3: 'busy',
  4: 'canceling',
};

function decodeSummaryEntry(buf: Buffer): ConversationSummary | undefined {
  let id: string | undefined;
  let summaryBytes: Buffer | undefined;
  for (const f of decodeWire(buf)) {
    if (f.field === 1 && f.bytes) id = f.bytes.toString('utf8').trim().toLowerCase();
    else if (f.field === 2 && f.bytes) summaryBytes = f.bytes;
  }
  if (!isConversationId(id) || !summaryBytes) return undefined;
  const out: ConversationSummary = { conversationId: id };
  for (const f of decodeWire(summaryBytes)) {
    switch (f.field) {
      case 1: {
        const t = f.bytes?.toString('utf8').trim();
        if (t) out.title = truncate(maskSecrets(t), TITLE_MAX);
        break;
      }
      case 2:
        if (f.varint !== undefined) out.stepCount = Number(f.varint);
        break;
      case 3: {
        const ts = decodeTimestampMs(f.bytes);
        if (ts !== undefined) out.lastModifiedAt = ts;
        break;
      }
      case 5:
        if (f.varint !== undefined) out.status = RUN_STATUS_MAP[Number(f.varint)] ?? 'unspecified';
        break;
      case 7: {
        const ts = decodeTimestampMs(f.bytes);
        if (ts !== undefined) out.createdAt = ts;
        break;
      }
      case 8:
        if (f.bytes && f.bytes.length > 0) out.waiting = true;
        break;
      case 9: {
        const uri = firstStringField(f.bytes, 1);
        const p = uri ? pathFromUri(uri) : undefined;
        if (p) out.cwd ??= p;
        break;
      }
      case 15: {
        const t = firstStringField(f.bytes, 1);
        if (t && !out.title) out.title = truncate(maskSecrets(t), TITLE_MAX);
        break;
      }
      case 17: {
        if (!f.bytes) break;
        for (const mf of decodeWire(f.bytes)) {
          if (mf.field === 1) {
            const uri = firstStringField(mf.bytes, 1);
            const p = uri ? pathFromUri(uri) : undefined;
            if (p) out.cwd ??= p;
          } else if (mf.field === 2 && out.createdAt === undefined) {
            const ts = decodeTimestampMs(mf.bytes);
            if (ts !== undefined) out.createdAt = ts;
          } else if (mf.field === 5 && mf.bytes) {
            const parent = mf.bytes.toString('utf8').trim().toLowerCase();
            if (isConversationId(parent) && parent !== id) out.parentConversationId = parent;
          } else if (mf.field === 6 && mf.bytes) {
            const root = mf.bytes.toString('utf8').trim().toLowerCase();
            if (isConversationId(root)) out.rootConversationId = root;
          } else if (mf.field === 7 && mf.bytes) {
            const p = pathFromUri(mf.bytes.toString('utf8').trim());
            if (p) out.cwd ??= p;
          } else if (mf.field === 8 && mf.bytes) {
            const role = firstStringField(mf.bytes, 2) ?? firstStringField(mf.bytes, 1);
            if (role) out.agentRole = truncate(role, 40);
          }
        }
        break;
      }
      case 21:
        if (f.varint !== undefined && f.varint !== 0n) out.notFullyIdle = true;
        break;
      case 23:
        if (f.varint !== undefined && f.varint !== 0n) out.killed = true;
        break;
      case 24: {
        const fork = f.bytes?.toString('utf8').trim().toLowerCase();
        if (isConversationId(fork) && fork !== id) out.parentConversationId ??= fork;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Decodifica um buffer `jetbox_summaries_proto.pb`. */
export function parseSummariesProto(buf: Buffer): Map<string, ConversationSummary> {
  const out = new Map<string, ConversationSummary>();
  for (const f of decodeWire(buf)) {
    if (f.field !== 1 || !f.bytes) continue;
    const s = decodeSummaryEntry(f.bytes);
    if (s) out.set(s.conversationId, s);
  }
  return out;
}

/** Extrai o `title` de um arquivo `annotations/<id>.pbtxt` (`title:"..."`). */
export function parseAnnotationPbtxt(text: string): string | undefined {
  const m = /\btitle:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(`"${m[1]}"`) as string;
    return parsed.trim() ? truncate(maskSecrets(parsed.trim()), TITLE_MAX) : undefined;
  } catch {
    return m[1].trim() ? truncate(maskSecrets(m[1].trim()), TITLE_MAX) : undefined;
  }
}

function readTailText(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - maxBytes);
    const len = Math.max(0, st.size - start);
    const buf = Buffer.alloc(len);
    const n = len > 0 ? readSync(fd, buf, 0, len, start) : 0;
    const text = buf.subarray(0, n).toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Lê os resumos das conversas de uma pasta do Antigravity CLI (`jetbox_summaries_proto.pb`, `annotations/*.pbtxt` e o
 * fim de `history.jsonl`), com cache por mtime.
 */
export class SummariesCache {
  private protoMtime = -1;
  private protoMap = new Map<string, ConversationSummary>();
  private historyMtime = -1;
  private historyMap = new Map<string, { cwd?: string; title?: string; lastAt?: number }>();
  private annotations = new Map<string, { mtimeMs: number; title?: string }>();

  constructor(readonly home: string) {}

  read(): Map<string, ConversationSummary> {
    this.refreshProto();
    this.refreshHistory();
    this.refreshAnnotations();
    const out = new Map<string, ConversationSummary>();
    for (const [id, s] of this.protoMap) out.set(id, { ...s });
    for (const [id, a] of this.annotations) {
      if (!a.title) continue;
      const cur = out.get(id) ?? { conversationId: id };
      cur.title ??= a.title;
      out.set(id, cur);
    }
    for (const [id, h] of this.historyMap) {
      const cur = out.get(id) ?? { conversationId: id };
      if (h.cwd && !cur.cwd) cur.cwd = h.cwd;
      if (h.title && !cur.title) cur.title = h.title;
      if (h.lastAt !== undefined && (cur.lastModifiedAt === undefined || h.lastAt > cur.lastModifiedAt)) cur.lastModifiedAt = h.lastAt;
      out.set(id, cur);
    }
    return out;
  }

  private refreshProto(): void {
    const p = join(this.home, SUMMARIES_PROTO);
    try {
      const st = statSync(p);
      if (st.mtimeMs === this.protoMtime) return;
      this.protoMtime = st.mtimeMs;
      this.protoMap = parseSummariesProto(readFileSync(p));
    } catch {
      this.protoMtime = -1;
      this.protoMap.clear();
    }
  }

  private refreshHistory(): void {
    const p = join(this.home, HISTORY_FILE);
    try {
      const st = statSync(p);
      if (st.mtimeMs === this.historyMtime) return;
      this.historyMtime = st.mtimeMs;
      const next = new Map<string, { cwd?: string; title?: string; lastAt?: number }>();
      let lastWorkspace: string | undefined;
      for (const line of readTailText(p, HISTORY_TAIL_BYTES).split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { conversationId?: unknown; workspace?: unknown; display?: unknown; type?: unknown; timestamp?: unknown };
          const ws = typeof j.workspace === 'string' && j.workspace.trim() ? j.workspace.trim() : undefined;
          if (ws) lastWorkspace = ws;
          const id = typeof j.conversationId === 'string' ? j.conversationId.trim().toLowerCase() : undefined;
          if (!isConversationId(id)) continue;
          const cur = next.get(id) ?? {};
          if (ws ?? lastWorkspace) cur.cwd ??= ws ?? lastWorkspace;
          if (j.type !== 'slash_command' && typeof j.display === 'string' && j.display.trim() && !j.display.trim().startsWith('/')) {
            cur.title ??= truncate(maskSecrets(j.display.trim()), TITLE_MAX);
          }
          if (typeof j.timestamp === 'number' && Number.isFinite(j.timestamp)) cur.lastAt = j.timestamp;
          next.set(id, cur);
        } catch {
          // linha inválida
        }
      }
      this.historyMap = next;
    } catch {
      this.historyMtime = -1;
      this.historyMap.clear();
    }
  }

  private refreshAnnotations(): void {
    const dir = join(this.home, ANNOTATIONS_DIR);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      this.annotations.clear();
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      const m = PBTXT_FILE.exec(name);
      if (!m) continue;
      const id = m[1].toLowerCase();
      seen.add(id);
      const path = join(dir, name);
      try {
        const st = statSync(path);
        const prev = this.annotations.get(id);
        if (prev && prev.mtimeMs === st.mtimeMs) continue;
        const title = parseAnnotationPbtxt(readFileSync(path, 'utf8'));
        this.annotations.set(id, { mtimeMs: st.mtimeMs, title });
      } catch {
        // sumiu
      }
    }
    for (const id of this.annotations.keys()) if (!seen.has(id)) this.annotations.delete(id);
  }
}

/** Caminho do transcript de uma conversa dentro de `<home>/brain/<id>/`, se existir. */
export function findTranscriptPath(home: string, conversationId: string): string | undefined {
  if (!isConversationId(conversationId)) return undefined;
  const base = join(home, BRAIN_DIR, conversationId.toLowerCase());
  for (const rel of [TRANSCRIPT_REL, TRANSCRIPT_FULL_REL]) {
    const p = join(base, rel);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Conversas cujos transcripts em `brain/` foram modificados nos últimos `maxAgeMs`. */
export function recentlyModifiedTranscripts(home: string, maxAgeMs: number, now: number = Date.now()): Array<{ conversationId: string; path: string; mtimeMs: number; size: number }> {
  const dir = join(home, BRAIN_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ conversationId: string; path: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!isConversationId(name)) continue;
    const id = name.toLowerCase();
    const path = findTranscriptPath(home, id);
    if (!path) continue;
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs > maxAgeMs) continue;
      out.push({ conversationId: id, path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // sumiu
    }
  }
  return out;
}

export interface TranscriptHead {
  title?: string;
  cwd?: string;
  firstAt?: number;
}

/** Lê o início de um `transcript.jsonl`: primeiro prompt (`title`), `firstAt` e algum `Cwd` inicial se houver. */
export function readTranscriptHead(path: string): TranscriptHead {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return {};
  }
  try {
    const buf = Buffer.alloc(HEAD_SCAN_BYTES);
    const n = readSync(fd, buf, 0, HEAD_SCAN_BYTES, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (n === HEAD_SCAN_BYTES) lines.pop();
    const head: TranscriptHead = {};
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (typeof j.created_at === 'string') {
          const ms = Date.parse(j.created_at);
          if (!Number.isNaN(ms) && (head.firstAt === undefined || ms < head.firstAt)) head.firstAt = ms;
        }
        if (head.title === undefined && j.source === 'USER_EXPLICIT' && j.type === 'USER_INPUT' && typeof j.content === 'string') {
          const clean = cleanPromptText(j.content);
          if (clean) head.title = truncate(maskSecrets(clean.slice(0, 1_000)), TITLE_MAX);
        }
        if (head.cwd === undefined && Array.isArray(j.tool_calls)) {
          for (const tc of j.tool_calls) {
            const args = tc && typeof tc === 'object' ? (tc as { args?: Record<string, unknown> }).args : undefined;
            const rawCwd = args?.Cwd ?? args?.cwd;
            if (typeof rawCwd === 'string') {
              const unquoted = rawCwd.startsWith('"') && rawCwd.endsWith('"') ? rawCwd.slice(1, -1) : rawCwd;
              if (unquoted.startsWith('/')) {
                head.cwd = unquoted;
                break;
              }
            }
          }
        }
        if (head.title !== undefined && head.firstAt !== undefined && head.cwd !== undefined) break;
      } catch {
        // linha cortada ou inválida
      }
    }
    return head;
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
}
