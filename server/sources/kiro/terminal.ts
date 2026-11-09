// Terminal do Kiro: converte as linhas do streaming JSONL (~/.kiro/sessions/cli/<sessionId>.jsonl)
// em TerminalEntry (prompts, respostas, pensamentos e chamadas de ferramentas).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { cleanKiroPrompt } from './parser';

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
