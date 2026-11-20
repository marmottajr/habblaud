// Terminal do omp: converte as linhas do transcript (sources/omp/parser.ts descreve o formato) em TerminalEntry: prompts,
// texto e raciocínio do assistente, chamadas de ferramenta (no estilo "Bash(npm test)", como o terminal do Claude Code) e
// resultados (erro marcado), com segredos mascarados e textos truncados pelas mesmas regras de sources/terminal.ts.
// Uma instância por leitura de arquivo, alimentada na ordem do arquivo; só `message` e `compaction` geram entradas (as
// linhas de bastidor do omp, como credential_pin, mode_change e tool_execution_start, ficam de fora).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';

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

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Texto de um conteúdo do omp: string ou blocos {type:"text", text}; imagem vira "[imagem]". */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const b = rec(raw);
    if (!b) continue;
    if (typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push(tr('[imagem]'));
  }
  return parts.join('\n');
}

/** Tira o seletor de linhas do `read` do omp (`arquivo.ts:50-80`, `arquivo.ts:raw`). */
function pathOf(v: unknown): string {
  return (str(v) ?? '').replace(/:(?:raw|\d[\d,+-]*)(?::raw)?$/, '');
}

/** Arquivos de um `edit` do omp: o `input` abre cada seção com `[caminho#TAG]`. */
function editFiles(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/^\[([^\]\r\n]+?)(?:#[0-9A-Za-z]{2,8})?\]\s*$/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

interface View {
  tool: string;
  title: string;
  input?: string;
  inputKind?: ToolEntry['inputKind'];
}

/** Chamada de ferramenta do omp no vocabulário do terminal do Claude Code (nome e argumentos). */
export function ompToolView(name: string, args: Rec, cwd?: string): View {
  const via = (tool: string, input: Rec): View => ({ tool, ...toolView(tool, input, cwd) });
  switch (name) {
    case 'bash':
      return via('Bash', { command: str(args.command) });
    case 'read':
      return via('Read', { file_path: pathOf(args.path) });
    case 'ls':
      return via('LS', { path: pathOf(args.path) });
    case 'write':
      return via('Write', { file_path: pathOf(args.path), content: args.content });
    case 'ast_edit':
      return via('Edit', { file_path: pathOf(args.path) });
    case 'edit': {
      const raw = str(args.input) ?? '';
      const files = editFiles(raw);
      const arg = files.length > 2 ? tr('{0} e mais {1}', [files[0], files.length - 1]) : files.join(', ');
      const input = raw.trim() ? marked(prepare(raw, 2_000, Infinity, false)) : '';
      return { tool: 'Edit', title: maskSecrets(arg ? `Edit(${arg})` : 'Edit'), ...(input ? { input, inputKind: 'text' as const } : {}) };
    }
    case 'grep':
      return via('Grep', { pattern: args.pattern });
    case 'glob':
      // No omp o `path` do glob é o próprio padrão.
      return via('Glob', { pattern: args.path ?? args.pattern });
    case 'web_search':
      return via('WebSearch', { query: args.query });
    case 'fetch':
      return via('WebFetch', { url: args.url });
    case 'task': {
      const tasks = Array.isArray(args.tasks) ? args.tasks.map(rec).filter((t): t is Rec => !!t) : [];
      const names = tasks.map((t) => str(t.name)).filter((n): n is string => !!n);
      const prompt = tasks.map((t) => `${str(t.name) ?? '?'}: ${str(t.task) ?? ''}`).join('\n\n');
      return via('Agent', { description: str(args.i), subagent_type: names.join(', ') || undefined, prompt });
    }
    case 'ask':
      return via('AskUserQuestion', { questions: Array.isArray(args.questions) ? args.questions : args.question !== undefined ? [{ question: args.question }] : [] });
    case 'eval':
      return { tool: 'eval', ...toolView('eval', { title: args.title ?? args.i, language: args.language, code: args.code }, cwd) };
    default:
      return { tool: name, ...toolView(name, args, cwd) };
  }
}

class OmpTerminalParser implements TerminalParser {
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
      // Linha estranha demais: fica o que já tiver saído dela; a leitura segue.
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
    const j = rec(parsed);
    if (!j) return;
    const ts = toMs(j.timestamp);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const id = str(j.id) ?? `l${++this.seq}`;
    switch (j.type) {
      case 'session':
        this.cwd = str(j.cwd) ?? this.cwd;
        return;
      case 'compaction':
        return this.sys(`${id}:c`, at, tr('Conversa compactada'));
      case 'message':
        return this.message(rec(j.message), id, at);
      default:
        return;
    }
  }

  private sys(id: string, at: number, text: string, level: SystemEntry['level'] = 'info'): void {
    this.emit({ kind: 'system', id, at, text: maskSecrets(text), level });
  }

  private message(m: Rec | undefined, id: string, at: number): void {
    if (!m) return;
    switch (m.role) {
      case 'user': {
        // `attribution: "agent"` é texto injetado pelo próprio omp (lembretes, resultados de subagentes), não instrução sua.
        if (m.attribution === 'agent') return;
        const text = marked(prepare(textOf(m.content), TEXT_MAX));
        if (text) this.emit({ kind: 'user', id: `${id}:u`, at, text });
        return;
      }
      case 'assistant':
        return this.assistant(m, id, at);
      case 'toolResult':
        return this.result(m, id, at);
      default:
        return;
    }
  }

  private assistant(m: Rec, id: string, at: number): void {
    const blocks = Array.isArray(m.content) ? m.content : [];
    blocks.forEach((raw, i) => {
      const b = rec(raw);
      if (!b) return;
      if (b.type === 'text') {
        const text = marked(prepare(textOf([b]), TEXT_MAX));
        if (text) this.emit({ kind: 'assistant', id: `${id}:t${i}`, at, text });
      } else if (b.type === 'thinking') {
        const t = str(b.thinking);
        const text = t ? marked(prepare(t, THINKING_MAX)) : '';
        this.emit(text ? { kind: 'thinking', id: `${id}:k${i}`, at, text } : { kind: 'thinking', id: `${id}:k${i}`, at });
      } else if (b.type === 'toolCall') {
        const callId = str(b.id) ?? `${id}:c${i}`;
        const v = ompToolView(str(b.name) ?? 'ferramenta', rec(b.arguments) ?? {}, this.cwd);
        const e: ToolEntry = { kind: 'tool', id: callId, at, tool: v.tool, title: maskSecrets(v.title) };
        if (v.input) {
          e.input = v.input;
          e.inputKind = v.inputKind;
        }
        this.emit(e);
      }
    });
    if (m.stopReason === 'error') {
      const msg = str(m.errorMessage);
      this.sys(`${id}:err`, at, tr('Erro: {0}', [oneLine(msg ?? tr('desconhecido'), 160)]), 'error');
    } else if (m.stopReason === 'aborted') this.sys(`${id}:int`, at, tr('Interrompido pelo usuário'), 'warn');
  }

  private result(m: Rec, id: string, at: number): void {
    const toolId = str(m.toolCallId) ?? id;
    const p = prepare(textOf(m.content), RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${toolId}:r`, at, toolUseId: toolId, text: p.text || tr('(sem saída)') };
    if (m.isError === true) e.error = true;
    if (p.truncated) e.truncated = true;
    this.emit(e);
  }
}

/** Parser com estado do terminal do omp: uma instância por leitura de arquivo, alimentada na ordem do arquivo. */
export function createOmpTerminalParser(): TerminalParser {
  return new OmpTerminalParser();
}
