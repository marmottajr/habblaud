// Terminal do DeepSeek Harness: lê o `session.v4.jsonl.zstd` (vários quadros zstd acrescentados com o tempo, ver
// dsh/source.ts) com o ZstdTail, que tem a mesma interface do FileTail, e converte os eventos em TerminalEntry
// (prompts, respostas, raciocínio, ferramentas com o resultado) pelas mesmas regras de corte e máscara do terminal do
// Claude Code (sources/terminal.ts).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { formatDuration, maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import type { TailRead } from '../tail';
import { decodeFrames } from './source';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

const SEEN_MAX = 20_000;
/** Bytes comprimidos lidos por chamada de read() (o resto fica para a próxima). */
const MAX_CHUNK = 8 * 1024 * 1024;
/** Eventos enormes que o terminal não mostra (o pedido inteiro mandado ao modelo): descartados já na leitura. */
const SKIP_LINE = /^\{"type":"(?:request\/|response\/|usage\/)/;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Leitura incremental do JSONL comprimido do DSH, com a interface do FileTail usada pelo terminal. */
export class ZstdTail {
  /** Próximo byte (comprimido) a ler. */
  offset = 0;
  size = 0;
  private carry = '';
  /** Linhas já descomprimidas pelo seekTail, entregues no próximo read(). */
  private queued: string[] = [];
  private ino: number | undefined;

  constructor(readonly path: string) {}

  private take(text: string): string[] {
    const parts = (this.carry + text).split('\n');
    this.carry = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() && !SKIP_LINE.test(l));
  }

  private chunk(fd: number, from: number, to: number): Buffer {
    const len = Math.max(0, to - from);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  }

  /**
   * Descomprime o arquivo inteiro (não dá para pular para o meio de um quadro zstd) e guarda só as linhas dos
   * últimos `maxBytes` de texto. Devolve > 0 se algo do começo ficou de fora.
   */
  seekTail(maxBytes: number): number {
    this.offset = 0;
    this.carry = '';
    this.queued = [];
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return 0;
    }
    try {
      const st = fstatSync(fd);
      this.ino = st.ino;
      this.size = st.size;
      const { text, used } = decodeFrames(this.chunk(fd, 0, st.size));
      this.offset = used;
      const lines = this.take(text);
      let bytes = 0;
      let i = lines.length;
      while (i > 0 && bytes + lines[i - 1].length <= maxBytes) bytes += lines[--i].length + 1;
      this.queued = lines.slice(i);
      return i;
    } finally {
      closeSync(fd);
    }
  }

  seekEnd(): void {
    this.seekTail(0);
    this.queued = [];
  }

  read(): TailRead {
    if (this.queued.length) {
      const lines = this.queued;
      this.queued = [];
      return { lines, reset: false, missing: false, more: true };
    }
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], reset: false, missing: true, more: false };
      throw err;
    }
    try {
      const st = fstatSync(fd);
      let reset = false;
      if ((this.ino !== undefined && st.ino !== this.ino) || st.size < this.offset) {
        this.offset = 0;
        this.carry = '';
        reset = true;
      }
      this.ino = st.ino;
      this.size = st.size;
      if (st.size <= this.offset) return { lines: [], reset, missing: false, more: false };
      const end = Math.min(st.size, this.offset + MAX_CHUNK);
      const { text, used } = decodeFrames(this.chunk(fd, this.offset, end));
      // Um quadro maior que MAX_CHUNK: tenta com o resto do arquivo.
      if (!used && end < st.size) {
        const all = decodeFrames(this.chunk(fd, this.offset, st.size));
        this.offset += all.used;
        return { lines: this.take(all.text), reset, missing: false, more: false };
      }
      this.offset += used;
      return { lines: this.take(text), reset, missing: false, more: used > 0 && this.offset < st.size };
    } finally {
      closeSync(fd);
    }
  }
}

/** Texto dos itens `{type: 'text', text}` de um conteúdo do DSH. */
function textOf(content: unknown, type = 'text'): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => rec(c))
    .filter((c): c is Rec => !!c && c.type === type && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
}

function parseArgs(raw: unknown): Rec {
  if (typeof raw === 'string') {
    try {
      return rec(JSON.parse(raw)) ?? {};
    } catch {
      return raw.trim() ? { input: raw } : {};
    }
  }
  return rec(raw) ?? {};
}

/** Ferramenta do DSH → nome e argumentos do equivalente do Claude Code que o toolView conhece. */
export function dshToolView(name: string, a: Rec, cwd?: string): { tool: string; title: string; input?: string; inputKind?: TerminalInputKind } {
  const rel = (p: unknown) => {
    if (typeof p !== 'string' || !cwd) return p;
    const base = cwd.replace(/[\\/]+$/, '');
    const low = p.toLowerCase();
    if (low === base.toLowerCase()) return '.';
    return low.startsWith(base.toLowerCase()) && /[\\/]/.test(p.charAt(base.length)) ? p.slice(base.length + 1) : p;
  };
  const as = (tool: string, args: Rec) => ({ tool, ...toolView(tool, args, cwd) });
  switch (name) {
    case 'read':
    case 'read_image':
    case 'modlens_read_image':
      return as('Read', { ...a, file_path: rel(a.file_path ?? a.path), path: undefined });
    case 'write':
      return as('Write', { ...a, file_path: rel(a.file_path) });
    case 'edit':
      return as('Edit', { ...a, file_path: rel(a.file_path) });
    case 'pwsh':
    case 'bash':
    case 'shell':
      return as('Bash', { command: a.command });
    case 'grep':
      return as('Grep', { ...a, path: rel(a.path) });
    case 'glob':
      return as('Glob', { ...a, path: rel(a.path) });
    case 'web_fetch':
      return as('WebFetch', a);
    case 'web_search':
      return as('WebSearch', { query: Array.isArray(a.queries) ? a.queries.join(' | ') : a.query });
    case 'todo_write':
      return as('TodoWrite', a);
    case 'subagent':
    case 'subagent_fork':
      return as('Agent', { description: a.description, prompt: a.prompt, subagent_type: a.name });
    case 'send_message':
      return as('SendMessage', { to: a.agent, message: a.message });
    case 'ask_user_question':
      return as('AskUserQuestion', a);
    case 'skill':
      return as('Skill', { skill: a.name });
    default:
      return { tool: name, ...toolView(name, a, cwd) };
  }
}

class DshTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;
  private turnStartAt?: number;

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha estranha demais: fica o que já tiver saído dela.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const ev = rec(parsed);
    if (!ev) return;
    const type = str(ev.type) ?? '';
    if (type === 'session') {
      this.cwd = str(ev.cwd);
      return;
    }
    const data = rec(ev.data) ?? {};
    const t = num(ev.time);
    if (t !== undefined) this.lastAt = t;
    const at = t ?? this.lastAt ?? Date.now();
    const key = typeof ev.seq === 'number' ? `s${ev.seq}` : `l${++this.seq}`;
    switch (type) {
      case 'turn/start':
        this.turnStartAt = at;
        return;
      case 'turn/end': {
        const reason = rec(data.reason);
        const kind = str(reason?.kind);
        if (kind === 'error') {
          const msg = str(rec(reason?.error)?.message) ?? tr('desconhecido');
          this.sys(key, at, tr('Erro: {0}', [oneLine(msg, 160)]), { level: 'error', detail: msg });
        } else if (kind === 'interrupted' || kind === 'aborted' || kind === 'cancelled') {
          this.sys(key, at, tr('Interrompido pelo usuário'), { level: 'warn' });
        } else if (this.turnStartAt !== undefined) {
          this.sys(key, at, tr('Turno concluído em {0}', [formatDuration(Math.max(0, at - this.turnStartAt))]));
        }
        this.turnStartAt = undefined;
        return;
      }
      case 'user/message': {
        const source = str(rec(data.source)?.kind);
        if (source && source !== 'user') return;
        const text = marked(prepare(textOf(data.content), TEXT_MAX));
        if (text) this.emit({ kind: 'user', id: `${str(data.id) ?? key}:u`, at, text });
        return;
      }
      case 'assistant/message': {
        const message = rec(data.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        content.forEach((c, i) => {
          const item = rec(c);
          if (!item) return;
          const id = `${key}:${i}`;
          if (item.type === 'reasoning') {
            const text = typeof item.text === 'string' && item.text.trim() ? marked(prepare(item.text, THINKING_MAX)) : '';
            this.emit(text ? { kind: 'thinking', id, at, text } : { kind: 'thinking', id, at });
          } else if (item.type === 'text' && typeof item.text === 'string') {
            const text = marked(prepare(item.text, TEXT_MAX));
            if (text) this.emit({ kind: 'assistant', id, at, text });
          } else if (item.type === 'tool-call') {
            this.tool(str(item.id) ?? id, at, str(item.name) ?? 'tool', item.arguments);
          }
        });
        return;
      }
      case 'tool/call':
        this.tool(str(data.callId) ?? key, at, str(data.name) ?? 'tool', data.arguments);
        return;
      case 'tool/result': {
        const message = rec(data.message);
        const id = str(message?.toolCallId);
        if (!message || !id) return;
        const p = prepare(textOf(message.content), RESULT_MAX, RESULT_MAX_LINES);
        const e: ResultEntry = { kind: 'result', id: `${id}:r`, at, toolUseId: id, text: p.text || tr('(sem saída)') };
        if (message.isError === true) e.error = true;
        if (p.truncated) e.truncated = true;
        this.emit(e);
        return;
      }
      case 'compaction/start':
        this.sys(key, at, tr('Conversa compactada'));
        return;
      case 'approval/asked':
        this.sys(key, at, tr('Esperando aprovação: {0}', [str(data.toolName) ?? 'tool']), { level: 'warn' });
        return;
      default:
        return;
    }
  }

  private tool(id: string, at: number, name: string, rawArgs: unknown): void {
    const view = dshToolView(name, parseArgs(rawArgs), this.cwd);
    const e: ToolEntry = { kind: 'tool', id, at, tool: view.tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private sys(id: string, at: number, text: string, o: { level?: SystemEntry['level']; detail?: string } = {}): void {
    const e: SystemEntry = { kind: 'system', id: `${id}:s`, at, text: maskSecrets(text), level: o.level ?? 'info' };
    if (o.detail?.trim()) {
      const detail = marked(prepare(o.detail, 4_000));
      if (detail) e.detail = detail;
    }
    this.emit(e);
  }
}

/** Parser com estado do terminal do DSH: uma instância por leitura de arquivo. */
export function createDshTerminalParser(): TerminalParser {
  return new DshTerminalParser();
}
