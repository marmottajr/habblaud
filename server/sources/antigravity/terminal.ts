// Terminal do Antigravity CLI: converte as linhas de `transcript.jsonl` em `TerminalEntry` (prompts, respostas,
// raciocínio, chamadas de ferramenta com comandos/diffs e resultados), com segredos mascarados e textos truncados
// pelas mesmas regras do terminal do Claude Code (sources/terminal.ts).
import { maskSecrets } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { commandText } from '../codex/rollout';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { cleanPromptText, extractCommandOutput, mcpToolName, unwrapArgs, unwrapValue } from './transcript';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

const SEEN_MAX = 20_000;
const HEADER_BOILERPLATE = /^(?:Created At: [^\n]+\n|Completed At: [^\n]+\n|(?:Command|The command) exited with code -?\d+\.\n|\n)+/;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Limpa o cabeçalho técnico (`Created At:... Completed At:...`) do resultado de uma ferramenta. */
function cleanResultBody(content: string): { text: string; exitCode?: number } {
  const { output, exitCode } = extractCommandOutput(content);
  const body = (output !== content.trim() ? output : content.replace(HEADER_BOILERPLATE, '')).trim();
  if (body === 'No output from the command.') return { text: '', ...(exitCode !== undefined ? { exitCode } : {}) };
  return { text: body, ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** Monta a visão de uma chamada de ferramenta do Antigravity para o terminal (comando, diff de Edit/Write...). */
function antigravityToolView(rawName: string, rawArgs: unknown, cwd?: string): { tool: string; view: { title: string; input?: string; inputKind?: TerminalInputKind } } {
  const args = unwrapArgs(rawArgs);
  switch (rawName) {
    case 'run_command':
    case 'shell_exec':
    case 'Bash': {
      const command = commandText(args.CommandLine ?? args.command ?? args.cmd);
      return { tool: 'Bash', view: toolView('Bash', { command }, cwd) };
    }
    case 'read_file':
    case 'view_file':
    case 'view_code_item':
    case 'read_notebook':
    case 'Read': {
      const filePath = str(args.Path) ?? str(args.AbsolutePath) ?? str(args.File) ?? str(args.file_path) ?? '';
      return { tool: 'Read', view: toolView('Read', { file_path: filePath }, cwd) };
    }
    case 'write_file':
    case 'write_to_file':
    case 'Write': {
      const filePath = str(args.Path) ?? str(args.TargetFile) ?? str(args.file_path) ?? '';
      const content = str(args.Content) ?? str(args.CodeContent) ?? str(args.content) ?? '';
      return { tool: 'Write', view: toolView('Write', { file_path: filePath, content }, cwd) };
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'Edit': {
      const filePath = str(args.Path) ?? str(args.TargetFile) ?? str(args.file_path) ?? '';
      const oldStr = str(args.Target) ?? str(args.TargetContent) ?? str(args.old_string) ?? '';
      const newStr = str(args.Replacement) ?? str(args.ReplacementContent) ?? str(args.new_string) ?? '';
      return { tool: 'Edit', view: toolView('Edit', { file_path: filePath, old_string: oldStr, new_string: newStr }, cwd) };
    }
    case 'list_dir':
    case 'list_directory':
    case 'find_by_name':
    case 'Glob': {
      const path = str(args.DirectoryPath) ?? str(args.SearchDirectory) ?? str(args.Path) ?? str(args.path);
      const pattern = str(args.Pattern) ?? str(args.pattern);
      return { tool: 'Glob', view: toolView('Glob', { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) }, cwd) };
    }
    case 'grep_search':
    case 'code_search':
    case 'Grep': {
      const pattern = str(args.Query) ?? str(args.query) ?? str(args.pattern) ?? '';
      const path = str(args.SearchPath) ?? str(args.Path) ?? str(args.path);
      return { tool: 'Grep', view: toolView('Grep', { pattern, ...(path ? { path } : {}) }, cwd) };
    }
    case 'search_web':
    case 'WebSearch': {
      const query = str(args.query) ?? str(args.Query) ?? '';
      return { tool: 'WebSearch', view: toolView('WebSearch', { query }, cwd) };
    }
    case 'read_url_content':
    case 'WebFetch': {
      const url = str(args.Url) ?? str(args.url) ?? '';
      return { tool: 'WebFetch', view: toolView('WebFetch', { url }, cwd) };
    }
    case 'invoke_subagent':
    case 'Agent': {
      const description = str(args.Role) ?? str(args.description) ?? '';
      const prompt = str(args.Prompt) ?? str(args.prompt);
      const subType = str(args.TypeName) ?? str(args.subagent_type);
      return {
        tool: 'Agent',
        view: toolView('Agent', { ...(description ? { description } : {}), ...(prompt ? { prompt } : {}), ...(subType ? { subagent_type: subType } : {}) }, cwd),
      };
    }
    case 'call_mcp_tool': {
      const name = mcpToolName(args.ServerName, args.ToolName);
      const mcpArgs = typeof args.Arguments === 'string' ? unwrapValue(args.Arguments) : args.Arguments;
      return { tool: name, view: toolView(name, rec(mcpArgs) ?? {}, cwd) };
    }
    default:
      return { tool: rawName, view: toolView(rawName, args, cwd) };
  }
}

class AntigravityTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;
  private readonly pendingToolIds: string[] = [];

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha inválida: segue
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
    const ts = toMs(j.created_at);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const stepIdx = num(j.step_index);
    const key = stepIdx !== undefined ? `s${stepIdx}` : `l${++this.seq}`;
    const source = str(j.source);
    const type = str(j.type);
    const status = str(j.status);
    const content = typeof j.content === 'string' ? j.content : '';

    if (source === 'USER_EXPLICIT' && type === 'USER_INPUT') {
      const clean = cleanPromptText(content);
      if (!clean) return;
      const text = marked(prepare(clean, TEXT_MAX));
      if (text) this.emit({ kind: 'user', id: `${key}:u`, at, text });
      return;
    }

    if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
      const thinking = str(j.thinking);
      if (thinking) {
        const text = marked(prepare(thinking, THINKING_MAX));
        this.emit(text ? { kind: 'thinking', id: `${key}:th`, at, text } : { kind: 'thinking', id: `${key}:th`, at });
      }
      const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      if (calls.length > 0) {
        calls.forEach((rawCall, idx) => {
          const c = rec(rawCall);
          const rawName = str(c?.name) ?? 'ferramenta';
          const args = unwrapArgs(c?.args);
          if (typeof args.Cwd === 'string' && args.Cwd.startsWith('/')) this.cwd ??= args.Cwd;
          const { tool, view } = antigravityToolView(rawName, args, this.cwd);
          const id = calls.length > 1 ? `${key}:t${idx}` : `${key}:t`;
          const e: ToolEntry = { kind: 'tool', id, at, tool, title: maskSecrets(view.title) };
          if (view.input) {
            e.input = view.input;
            e.inputKind = view.inputKind;
          }
          this.emit(e);
          if (!this.pendingToolIds.includes(id)) {
            this.pendingToolIds.push(id);
            if (this.pendingToolIds.length > 256) this.pendingToolIds.shift();
          }
        });
        return;
      }
      if (content.trim()) {
        const text = marked(prepare(content.trim(), TEXT_MAX));
        if (text) this.emit({ kind: 'assistant', id: `${key}:a`, at, text });
      }
      return;
    }

    if (source === 'SYSTEM' && type === 'SYSTEM_MESSAGE') {
      const m = /Task id "([^"]+)" finished with result:\s*([\s\S]*)/.exec(content);
      if (m) {
        const { text } = cleanResultBody(m[2]);
        const sys: SystemEntry = { kind: 'system', id: `${key}:s`, at, text: maskSecrets(tr('Tarefa {0} concluída', [m[1]])), level: 'info' };
        if (text) sys.detail = marked(prepare(text, 4_000));
        this.emit(sys);
      }
      return;
    }

    if (source === 'MODEL' || source === 'SYSTEM') {
      if (status === 'RUNNING') return;
      if (type === 'CHECKPOINT') return;
      if (type === 'ERROR_MESSAGE' && !this.pendingToolIds.length) {
        const msg = oneLine(content || tr('erro desconhecido'), 160);
        this.emit({ kind: 'system', id: `${key}:err`, at, text: maskSecrets(tr('Erro: {0}', [msg])), level: 'error' });
        return;
      }
      const toolId = this.pendingToolIds.shift() ?? `${key}:t`;
      const { text, exitCode } = cleanResultBody(content);
      const failed = status === 'ERROR' || type === 'ERROR_MESSAGE' || (exitCode !== undefined && exitCode !== 0);
      const fullText = failed && exitCode !== undefined && exitCode !== 0 ? tr('Código de saída {0}\n{1}', [exitCode, text]).trim() : text;
      const p = prepare(fullText, RESULT_MAX, RESULT_MAX_LINES);
      const res: ResultEntry = { kind: 'result', id: `${key}:r`, at, toolUseId: toolId, text: p.text || tr('(sem saída)') };
      if (failed) res.error = true;
      if (p.truncated) res.truncated = true;
      this.emit(res);
    }
  }
}

/** Parser com estado do terminal do Antigravity CLI: uma instância por leitura de arquivo. */
export function createAntigravityTerminalParser(): TerminalParser {
  return new AntigravityTerminalParser();
}
