// Terminal do Kiro: converte as linhas do transcript em TerminalEntry (prompts, respostas, pensamentos e
// chamadas de ferramentas). Dois formatos, detectados por linha:
// - 2.x (~/.kiro/sessions/cli/<sessionId>.jsonl): {kind: Prompt|AssistantMessage|ToolResults, data};
// - 3.x (~/.kiro/sessions/<hash>/<sessionId>/messages.jsonl): {id, timestamp (ISO), payload: {type, ...}}.
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import { prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { cleanKiroPrompt, KIRO_SHELL_TOOLS } from './parser';

type Rec = Record<string, unknown>;

export class KiroTerminalParser implements TerminalParser {
  private count = 0;

  push(line: string): TerminalEntry[] {
    if (!line || !line.trim()) return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    if (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)) {
      return this.pushV3(parsed.payload as Rec, parsed.timestamp);
    }

    const kind = parsed.kind as string;
    const data = (parsed.data as Record<string, unknown>) || {};
    const now = Date.now();
    const entries: TerminalEntry[] = [];

    if (kind === 'Prompt') {
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];
      const textPart = contents.find((c) => c.kind === 'text');
      // Sem o contexto que o Kiro Crew injeta no prompt (o pedido de verdade vem no fim).
      const text = cleanKiroPrompt(typeof textPart?.data === 'string' ? textPart.data : '');
      const ts = (data.meta as { timestamp?: unknown } | undefined)?.timestamp;
      const at = typeof ts === 'number' && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : now;
      if (text) {
        this.count++;
        const prep = prepare(text, TEXT_MAX);
        entries.push({
          id: `kiro-term-prompt-${this.count}`,
          kind: 'user',
          text: prep.text,
          at,
        });
      }
    } else if (kind === 'AssistantMessage') {
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];

      for (const part of contents) {
        if (part.kind === 'thinking' && part.data && typeof part.data === 'object') {
          const thinkText = typeof (part.data as { text?: unknown }).text === 'string'
            ? (part.data as { text: string }).text
            : '';
          if (thinkText.trim()) {
            this.count++;
            const prep = prepare(thinkText, THINKING_MAX);
            entries.push({
              id: `kiro-term-think-${this.count}`,
              kind: 'thinking',
              text: prep.text,
              at: now,
            });
          }
        } else if (part.kind === 'toolUse' && part.data && typeof part.data === 'object') {
          const toolData = part.data as { toolUseId?: string; name?: string; input?: Record<string, unknown> };
          const toolName = toolData.name || 'tool';
          const input = toolData.input || {};
          const view = toolView(toolName, input);

          this.count++;
          entries.push({
            id: toolData.toolUseId || `kiro-term-tool-${this.count}`,
            kind: 'tool',
            tool: toolName,
            title: view.title,
            ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}),
            at: now,
          });
        } else if (part.kind === 'text') {
          const text = typeof part.data === 'string' ? part.data : '';
          if (text.trim()) {
            this.count++;
            const prep = prepare(text, TEXT_MAX);
            entries.push({
              id: `kiro-term-resp-${this.count}`,
              kind: 'assistant',
              text: prep.text,
              at: now,
            });
          }
        }
      }
    } else if (kind === 'ToolResults') {
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];
      // Formato do Kiro CLI: um toolResult por ferramenta ({toolUseId, content: [{kind, data}], status}).
      const results = contents.filter((c) => c.kind === 'toolResult' && c.data && typeof c.data === 'object');
      if (results.length) {
        for (const r of results) {
          const d = r.data as { toolUseId?: unknown; content?: unknown; status?: unknown };
          const toolUseId = typeof d.toolUseId === 'string' ? d.toolUseId : `tool-${this.count}`;
          entries.push(this.result(toolUseId, resultText(d.content), typeof d.status === 'string' && /^err/i.test(d.status), now));
        }
      } else {
        const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : `tool-${this.count}`;
        const textPart = contents.find((c) => c.kind === 'text');
        const rawText = typeof textPart?.data === 'string' ? textPart.data : (typeof data.output === 'string' ? data.output : '');
        entries.push(this.result(toolUseId, rawText, Boolean(data.isError), now));
      }
    }

    return entries;
  }

  /** Uma linha do 3.x ({id, timestamp, payload}). `at` = horário da linha. */
  private pushV3(p: Rec, timestamp: unknown): TerminalEntry[] {
    const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    const at = Number.isNaN(ms) ? Date.now() : ms;
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');

    switch (p.type) {
      case 'user': {
        const text = cleanKiroPrompt(s('content'));
        if (!text) return [];
        this.count++;
        return [{ id: `kiro-term-prompt-${this.count}`, kind: 'user', text: prepare(text, TEXT_MAX).text, at }];
      }
      case 'assistant': {
        const text = s('content');
        if (!text.trim()) return [];
        this.count++;
        if (p.operationType === 'Reasoning') {
          return [{ id: `kiro-term-think-${this.count}`, kind: 'thinking', text: prepare(text, THINKING_MAX).text, at }];
        }
        return [{ id: `kiro-term-resp-${this.count}`, kind: 'assistant', text: prepare(text, TEXT_MAX).text, at }];
      }
      case 'tool_call': {
        const toolName = s('toolName') || 'tool';
        const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? (p.args as Rec) : {};
        const view = kiroV3ToolView(toolName, args);
        this.count++;
        return [{
          id: s('toolCallId') || `kiro-term-tool-${this.count}`,
          kind: 'tool',
          tool: toolName,
          title: view.title,
          ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}),
          at,
        }];
      }
      case 'tool_result': {
        const content = typeof p.content === 'string' ? p.content : p.content === undefined ? '' : JSON.stringify(p.content).slice(0, 4_000);
        return [this.result(s('toolCallId') || `tool-${this.count}`, content, p.success === false, at)];
      }
      case 'pending_interaction': {
        if (p.interactionType !== 'tool_approval') return [];
        this.count++;
        const q = s('question');
        return [{
          id: `kiro-term-wait-${this.count}`,
          kind: 'system',
          text: tr('Esperando aprovação'),
          ...(q ? { detail: maskSecrets(q).slice(0, 500) } : {}),
          level: 'warn',
          at,
        }];
      }
      // Subagente: vira um Agent(...) com o resultado (a resposta) ligado pelo subSessionId.
      case 'sub_agent_start': {
        const sub = s('subSessionId');
        const view = toolView('Agent', { subagent_type: s('subAgentName'), description: s('explanation'), prompt: s('prompt') });
        this.count++;
        return [{
          id: sub ? `kiro-sub-${sub}` : `kiro-term-tool-${this.count}`,
          kind: 'tool',
          tool: 'Agent',
          title: view.title,
          ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}),
          at,
        }];
      }
      case 'sub_agent_complete': {
        const sub = s('subSessionId');
        const text = s('response') || s('errorMessage');
        return [this.result(sub ? `kiro-sub-${sub}` : `tool-${this.count}`, text, s('status') === 'error', at)];
      }
      default:
        // session_metadata, turn_start/turn_end, usage_summary, session_event, steering_inclusion, hooks...
        return [];
    }
  }

  private result(toolUseId: string, rawText: string, isError: boolean, at: number): TerminalEntry {
    this.count++;
    const masked = maskSecrets(rawText);
    const lines = masked.split('\n');
    const truncated = masked.length > RESULT_MAX || lines.length > RESULT_MAX_LINES;
    const text = lines.slice(0, RESULT_MAX_LINES).join('\n').slice(0, RESULT_MAX);
    return {
      id: `kiro-term-res-${this.count}`,
      kind: 'result',
      toolUseId,
      text,
      error: isError || undefined,
      truncated: truncated || undefined,
      at,
    };
  }
}

/** Texto de um resultado: string, saída de shell ({stdout, stderr, exit_status}) ou blocos {content: [{text}]}. */
function resultText(content: unknown): string {
  const out: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    const d = (c as { data?: unknown })?.data;
    if (typeof d === 'string') out.push(d);
    else if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>;
      if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
        if (typeof o.stdout === 'string' && o.stdout) out.push(o.stdout);
        if (typeof o.stderr === 'string' && o.stderr) out.push(o.stderr);
        if (typeof o.exit_status === 'string' && !/^0$|exit status: 0\b/.test(o.exit_status)) out.push(o.exit_status);
      } else if (Array.isArray(o.content)) {
        for (const x of o.content) if (typeof (x as { text?: unknown })?.text === 'string') out.push((x as { text: string }).text);
      } else {
        out.push(JSON.stringify(o).slice(0, 4_000));
      }
    }
  }
  return out.join('\n');
}

function strArg(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Título e prévia de um tool_call do 3.x pelo equivalente do Claude Code (mesmo toolView), como em
 * server/permissions/kiro.ts. Os argumentos do 3.x: str_replace usa {path, oldStr, newStr} (o hook manda
 * old_str/new_str), fs_write/fs_append {path, text}, read_file/readFile {path}. O resto: visão genérica.
 */
export function kiroV3ToolView(tool: string, args: Rec): ReturnType<typeof toolView> {
  const path = strArg(args.path) ?? strArg(args.file_path);
  if (KIRO_SHELL_TOOLS.has(tool)) return toolView('Bash', { command: strArg(args.command) ?? '' });
  if (tool === 'fs_write' || tool === 'write' || tool === 'write_file') {
    return toolView('Write', { file_path: path, content: strArg(args.text) ?? strArg(args.file_text) ?? strArg(args.content) ?? '' });
  }
  // Acréscimo no fim do arquivo: diff só com linhas novas.
  if (tool === 'fs_append') return toolView('Edit', { file_path: path, old_string: '', new_string: strArg(args.text) ?? '' });
  if (tool === 'str_replace') {
    return toolView('Edit', {
      file_path: path,
      old_string: strArg(args.oldStr) ?? strArg(args.old_str) ?? '',
      new_string: strArg(args.newStr) ?? strArg(args.new_str) ?? '',
    });
  }
  if (/^(read|fs_read|read_file|readFile)$/.test(tool) && path) {
    const { path: _p, ...rest } = args;
    void _p;
    return toolView('Read', { file_path: path, ...rest });
  }
  return toolView(tool, args);
}
