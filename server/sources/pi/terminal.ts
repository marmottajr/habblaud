// Terminal do Pi: converte as linhas JSONL da sessão do Pi em TerminalEntry (prompts, respostas, raciocínio,
// chamadas de ferramenta e seus resultados, compactações, erros), com segredos mascarados e textos truncados
// pelas mesmas regras do terminal do Claude Code (sources/terminal.ts).
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { formatDuration, maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { normalizePiTool, piContentText, toMs } from './session';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

const SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

class PiTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha estranha: mantém o que já saiu e segue lendo.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private user(id: string, at: number, raw: string, images = 0): void {
    const pics = images ? Array.from({ length: Math.min(images, 10) }, () => tr('[imagem]')).join(' ') : '';
    const text = marked(prepare([raw, pics].filter(Boolean).join('\n'), TEXT_MAX));
    if (text) this.emit({ kind: 'user', id: `${id}:u`, at, text });
  }

  private assistant(id: string, at: number, raw: string): void {
    const text = marked(prepare(raw, TEXT_MAX));
    if (text) this.emit({ kind: 'assistant', id, at, text });
  }

  private thinking(id: string, at: number, raw: string): void {
    const text = raw.trim() ? marked(prepare(raw, THINKING_MAX)) : '';
    this.emit(text ? { kind: 'thinking', id, at, text } : { kind: 'thinking', id, at });
  }

  private tool(id: string, at: number, tool: string, view: { title: string; input?: string; inputKind?: TerminalInputKind }): void {
    const e: ToolEntry = { kind: 'tool', id, at, tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private result(toolId: string, at: number, raw: string, error: boolean): void {
    const p = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${toolId}:r`, at, toolUseId: toolId, text: p.text || tr('(sem saída)') };
    if (error) e.error = true;
    if (p.truncated) e.truncated = true;
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

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    if (!j || typeof j.type !== 'string') return;
    const ts = toMs(j.timestamp) ?? toMs(rec(j.message)?.timestamp);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const key = str(j.id) ?? `l${++this.seq}`;

    switch (j.type) {
      case 'session':
        this.cwd = str(j.cwd);
        return;

      case 'compaction': {
        const summary = str(j.summary);
        this.sys(key, at, tr('Conversa compactada'), summary ? { detail: summary } : {});
        return;
      }

      case 'branch_summary': {
        const summary = str(j.summary);
        if (summary) this.sys(key, at, tr('Resumo do ramo'), { detail: summary });
        return;
      }

      case 'message': {
        const msg = rec(j.message);
        if (!msg || typeof msg.role !== 'string') return;
        if (msg.role === 'user') {
          const { text, images } = piContentText(msg.content);
          this.user(key, at, text, images);
          return;
        }
        if (msg.role === 'assistant') {
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (let i = 0; i < blocks.length; i++) {
            const b = rec(blocks[i]);
            if (!b) continue;
            if (b.type === 'thinking') {
              this.thinking(`${key}:th:${i}`, at, typeof b.thinking === 'string' ? b.thinking : '');
            } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              this.assistant(`${key}:t:${i}`, at, b.text);
            } else if (b.type === 'toolCall') {
              const callId = str(b.id) ?? `${key}:c:${i}`;
              const rawName = str(b.name) ?? 'tool';
              const { tool, input } = normalizePiTool(rawName, b.arguments);
              this.tool(callId, at, tool, toolView(tool, input, this.cwd));
            }
          }
          const stop = str(msg.stopReason);
          if (stop === 'aborted') {
            this.sys(`${key}:abort`, at, tr('Interrompido pelo usuário'), { level: 'warn' });
          } else if (stop === 'error') {
            const errMsg = str(msg.errorMessage);
            this.sys(`${key}:err`, at, tr('Erro: {0}', [oneLine(errMsg ?? tr('desconhecido'), 160)]), { level: 'error' });
          } else if (stop === 'stop') {
            const ms = num(msg.durationMs);
            if (ms !== undefined && ms >= 0) this.sys(`${key}:done`, at, tr('Turno concluído em {0}', [formatDuration(ms)]));
          }
          return;
        }
        if (msg.role === 'toolResult') {
          const callId = str(msg.toolCallId);
          if (!callId) return;
          const { text } = piContentText(msg.content);
          this.result(callId, at, text, msg.isError === true);
          return;
        }
        if (msg.role === 'bashExecution') {
          const cmd = str(msg.command);
          if (!cmd) return;
          const id = `${key}:bash`;
          this.tool(id, at, 'Bash', toolView('Bash', { command: cmd }, this.cwd));
          const output = typeof msg.output === 'string' ? msg.output : '';
          const exitCode = num(msg.exitCode);
          const failed = (exitCode !== undefined && exitCode !== 0) || msg.cancelled === true;
          const text = failed && exitCode !== undefined && exitCode !== 0 ? tr('Código de saída {0}\n{1}', [exitCode, output]) : output;
          this.result(id, at, text, failed);
          return;
        }
        return;
      }

      default:
        return;
    }
  }
}

/** Parser com estado do terminal do Pi: uma instância por leitura de arquivo. */
export function createPiTerminalParser(): TerminalParser {
  return new PiTerminalParser();
}
