// Parser das linhas JSONL de sessão do Pi coding agent (versão 3+).
//
// Estrutura do arquivo de sessão do Pi:
// - primeira linha: { type: "session", version, id, timestamp, cwd, parentSession? }
// - metadados: `model_change` ({ provider, modelId }), `thinking_level_change`, `session_info` ({ name }),
//   `compaction` ({ summary, tokensBefore, usage? }), `usage` ({ provider, model, usage })
// - conversa: `type: "message"` com `message.role`:
//   - "user": content (string ou blocos `{type: "text", text}` / `{type: "image"}`)
//   - "assistant": content (`thinking`, `text`, `toolCall`), `model`, `usage` ({ input, output, cacheRead, cacheWrite, cost: { total } }),
//     `stopReason` ("toolUse" | "stop" | "aborted" | "error"), `durationMs`, `errorMessage`
//   - "toolResult": `toolCallId`, `toolName`, `content`, `isError`, `durationMs`
//   - "bashExecution": comando executado com `!` pelo usuário
import type { Activity, AgentStats, AgentStatus, ShellJob } from '../../../shared/types';
import {
  describePrompt,
  describeShellJob,
  describeTool,
  maskSecrets,
  SPECIAL,
  truncate,
  type ActivityDescription,
} from '../../../shared/activity';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

const MAX_TITLE = 80;
const SEEN_IDS_MAX = 4_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export interface PiMeta {
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  parentSession?: string;
}

/** Interpreta a primeira linha `type: "session"` do arquivo do Pi. */
export function parsePiHeaderLine(raw: string): PiMeta | undefined {
  if (!raw || raw.length < 2) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const j = rec(parsed);
  if (!j || j.type !== 'session') return undefined;
  const meta: PiMeta = {};
  const id = str(j.id);
  const cwd = str(j.cwd);
  const startedAt = toMs(j.timestamp);
  const parentSession = str(j.parentSession);
  if (id) meta.sessionId = id;
  if (cwd) meta.cwd = cwd;
  if (startedAt !== undefined) meta.startedAt = startedAt;
  if (parentSession) meta.parentSession = parentSession;
  return meta;
}

/** Extrai o texto de `content` do Pi (string ou array de blocos `{type: 'text', text}`). */
export function piContentText(raw: unknown): { text: string; images: number } {
  if (typeof raw === 'string') return { text: raw, images: 0 };
  if (!Array.isArray(raw)) return { text: '', images: 0 };
  const parts: string[] = [];
  let images = 0;
  for (const b of raw) {
    const o = rec(b);
    if (!o) continue;
    if (o.type === 'text' && typeof o.text === 'string' && o.text) parts.push(o.text);
    else if (o.type === 'image') images++;
  }
  return { text: parts.join('\n'), images };
}

/** Normaliza nome + argumentos de uma ferramenta do Pi para o formato do `describeTool` / `toolView`. */
export function normalizePiTool(name: string, rawArgs: unknown): { tool: string; input: Rec } {
  const args = rec(rawArgs) ?? {};
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower === 'powershell' || lower === 'shell') {
    return { tool: 'Bash', input: { command: args.command ?? args.cmd ?? '', description: args.description } };
  }
  if (lower === 'read') {
    return { tool: 'Read', input: { file_path: args.path ?? args.file_path ?? args.file ?? '' } };
  }
  if (lower === 'edit' || lower === 'replace' || lower === 'replace_match' || lower === 'str_replace') {
    return {
      tool: 'Edit',
      input: {
        file_path: args.path ?? args.file_path ?? args.file ?? '',
        old_string: args.oldText ?? args.old_string ?? args.old ?? args.search,
        new_string: args.newText ?? args.new_string ?? args.new ?? args.replace,
      },
    };
  }
  if (lower === 'write') {
    return { tool: 'Write', input: { file_path: args.path ?? args.file_path ?? args.file ?? '', content: args.content } };
  }
  if (lower === 'grep') {
    return { tool: 'Grep', input: { pattern: args.pattern ?? args.query ?? '', path: args.path } };
  }
  if (lower === 'find' || lower === 'fffind' || lower === 'glob' || lower === 'ls') {
    return { tool: 'Glob', input: { pattern: args.pattern ?? args.query ?? args.path ?? '*' } };
  }
  if (lower === 'web_fetch' || lower === 'webfetch' || lower === 'fetch') {
    return { tool: 'WebFetch', input: { url: args.url ?? '' } };
  }
  if (lower === 'web_search' || lower === 'websearch') {
    return { tool: 'WebSearch', input: { query: args.query ?? '' } };
  }
  return { tool: name, input: args };
}

/** Descreve uma ferramenta do Pi como ActivityDescription legível (PT-BR). */
export function describePiTool(name: string, rawArgs: unknown): ActivityDescription {
  const { tool, input } = normalizePiTool(name, rawArgs);
  return describeTool(tool, input);
}

/** Título limpo a partir de um prompt do usuário. */
export function piTitleFromPrompt(raw: string): string | undefined {
  const line = raw.replace(/\r/g, '').split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return undefined;
  return truncate(maskSecrets(line.slice(0, MAX_TITLE * 4)), MAX_TITLE);
}

export interface PiState {
  meta: PiMeta;
  /** Título escolhido pelo usuário (`session_info`), tem prioridade sobre o primeiro prompt. */
  explicitTitle?: string;
  /** Título efetivo (`explicitTitle` > primeiro prompt). */
  title?: string;
  model?: string;
  stats: AgentStats;
  firstAt?: number;
  lastAt?: number;
  /** Último status deduzido do arquivo. */
  lastStatus?: AgentStatus;
  /** Comandos Bash em primeiro plano ainda sem `toolResult`. */
  shells: Map<string, ShellJob>;
  /** Entradas já contabilizadas (evita duplicar estatísticas/atividades em releituras). */
  seenEntries: Set<string>;
}

export function createPiState(meta: PiMeta = {}): PiState {
  return {
    meta: { ...meta },
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    firstAt: meta.startedAt,
    shells: new Map(),
    seenEntries: new Set(),
  };
}

export interface PiParseContext {
  idPrefix: string;
  now: number;
  /** false = só metadados/título/horários (usado pelo histórico). */
  activities?: boolean;
}

export interface PiLineResult {
  activities: Activity[];
  status?: AgentStatus;
  statusAt?: number;
  summaryChanged: boolean;
  shellsChanged: boolean;
}

function addUsage(stats: AgentStats, raw: unknown): boolean {
  const u = rec(raw);
  if (!u) return false;
  const input = Math.max(0, num(u.input) ?? 0);
  const cacheRead = Math.max(0, num(u.cacheRead) ?? 0);
  const cacheWrite = Math.max(0, num(u.cacheWrite) ?? 0);
  const output = Math.max(0, num(u.output) ?? 0);
  const addIn = input + cacheRead + cacheWrite;
  let changed = false;
  if (addIn > 0) {
    stats.tokensIn += addIn;
    changed = true;
  }
  if (output > 0) {
    stats.tokensOut += output;
    changed = true;
  }
  const cost = rec(u.cost);
  const totalCost = num(cost?.total);
  if (totalCost !== undefined && totalCost > 0) {
    stats.costUSD = (stats.costUSD ?? 0) + totalCost;
    changed = true;
  }
  return changed;
}

function trackSeen(set: Set<string>, id: string): boolean {
  if (set.has(id)) return false;
  set.add(id);
  if (set.size > SEEN_IDS_MAX) set.delete(set.values().next().value as string);
  return true;
}

/** Interpreta uma linha JSONL do Pi, atualiza `state` e devolve atividades e mudanças de status. */
export function parsePiLine(state: PiState, raw: string, ctx: PiParseContext): PiLineResult {
  const res: PiLineResult = { activities: [], summaryChanged: false, shellsChanged: false };
  if (!raw || raw.length < 2) return res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return res;
  }
  const j = rec(parsed);
  if (!j || typeof j.type !== 'string') return res;

  const at = toMs(j.timestamp) ?? toMs(rec(j.message)?.timestamp) ?? state.lastAt ?? ctx.now;
  if (toMs(j.timestamp) !== undefined || toMs(rec(j.message)?.timestamp) !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }

  const entryId = str(j.id);
  const emitAct = ctx.activities !== false;
  const pushAct = (id: string, desc: ActivityDescription, extra: Partial<Activity> = {}) => {
    if (!emitAct) return;
    res.activities.push({ id, ...desc, at, ...extra });
  };

  switch (j.type) {
    case 'session': {
      const id = str(j.id);
      const cwd = str(j.cwd);
      const startedAt = toMs(j.timestamp);
      if (id) state.meta.sessionId = id;
      if (cwd) state.meta.cwd = cwd;
      if (startedAt !== undefined) {
        state.meta.startedAt = startedAt;
        if (state.firstAt === undefined || startedAt < state.firstAt) state.firstAt = startedAt;
      }
      res.summaryChanged = true;
      return res;
    }

    case 'model_change': {
      const modelId = str(j.modelId);
      if (modelId && modelId !== state.model) {
        state.model = modelId;
        res.summaryChanged = true;
      }
      return res;
    }

    case 'session_info': {
      const name = str(j.name);
      if (name) {
        state.explicitTitle = truncate(maskSecrets(name.slice(0, MAX_TITLE * 4)), MAX_TITLE);
        state.title = state.explicitTitle;
        res.summaryChanged = true;
      }
      return res;
    }

    case 'compaction': {
      if (entryId && !trackSeen(state.seenEntries, `compact:${entryId}`)) return res;
      if (addUsage(state.stats, j.usage)) res.summaryChanged = true;
      pushAct(`${ctx.idPrefix}:compact:${entryId ?? at}`, SPECIAL.compact(), { tool: 'Compact' });
      return res;
    }

    case 'usage': {
      if (entryId && !trackSeen(state.seenEntries, `usage:${entryId}`)) return res;
      const model = str(j.model);
      if (model && model !== state.model) {
        state.model = model;
        res.summaryChanged = true;
      }
      if (addUsage(state.stats, j.usage)) res.summaryChanged = true;
      return res;
    }

    case 'message': {
      const msg = rec(j.message);
      if (!msg || typeof msg.role !== 'string') return res;
      const key = entryId ?? `${at}`;

      if (msg.role === 'user') {
        if (entryId && !trackSeen(state.seenEntries, `msg:${entryId}`)) return res;
        const { text } = piContentText(msg.content);
        if (text.trim()) {
          if (!state.explicitTitle && !state.title) {
            state.title = piTitleFromPrompt(text);
            if (state.title) res.summaryChanged = true;
          }
          pushAct(`${ctx.idPrefix}:u:${key}`, describePrompt(text));
        }
        res.status = 'working';
        res.statusAt = at;
        state.lastStatus = 'working';
        return res;
      }

      if (msg.role === 'assistant') {
        if (entryId && !trackSeen(state.seenEntries, `msg:${entryId}`)) return res;
        const model = str(msg.model);
        if (model && model !== state.model) {
          state.model = model;
          res.summaryChanged = true;
        }
        if (addUsage(state.stats, msg.usage)) res.summaryChanged = true;

        const blocks = Array.isArray(msg.content) ? msg.content : [];
        let hasToolCalls = false;
        let lastText = '';
        let hasThinking = false;

        for (let i = 0; i < blocks.length; i++) {
          const b = rec(blocks[i]);
          if (!b) continue;
          if (b.type === 'thinking') {
            hasThinking = true;
          } else if (b.type === 'toolCall') {
            hasToolCalls = true;
            const callId = str(b.id) ?? `${key}:${i}`;
            const toolName = str(b.name) ?? 'tool';
            const args = rec(b.arguments) ?? {};
            state.stats.toolCalls += 1;
            res.summaryChanged = true;
            pushAct(`${ctx.idPrefix}:tool:${callId}`, describePiTool(toolName, args), { tool: toolName });
            const lower = toolName.toLowerCase();
            if (lower === 'bash' || lower === 'powershell' || lower === 'shell') {
              const info = describeShellJob('Bash', { command: args.command ?? args.cmd ?? '', description: args.description });
              state.shells.set(callId, {
                id: callId,
                label: info.label,
                ...(info.command ? { command: info.command } : {}),
                startedAt: at,
                background: false,
                kind: 'shell',
              });
              res.shellsChanged = true;
            }
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            lastText = b.text;
          }
        }

        if (hasThinking && !hasToolCalls && !lastText) {
          pushAct(`${ctx.idPrefix}:th:${key}`, SPECIAL.think());
        }
        if (lastText) {
          pushAct(`${ctx.idPrefix}:txt:${key}`, SPECIAL.respond(lastText));
        }

        const stopReason = str(msg.stopReason);
        const durationMs = num(msg.durationMs);
        if (stopReason === 'toolUse' || hasToolCalls) {
          res.status = 'working';
          res.statusAt = at;
          state.lastStatus = 'working';
        } else if (stopReason === 'aborted') {
          if (state.shells.size) {
            state.shells.clear();
            res.shellsChanged = true;
          }
          pushAct(`${ctx.idPrefix}:abort:${key}`, SPECIAL.interrupted());
          res.status = 'idle';
          res.statusAt = at;
          state.lastStatus = 'idle';
        } else if (stopReason === 'error') {
          if (state.shells.size) {
            state.shells.clear();
            res.shellsChanged = true;
          }
          const errText = str(msg.errorMessage);
          pushAct(`${ctx.idPrefix}:err:${key}`, SPECIAL.error(undefined, errText), { error: true });
          res.status = 'idle';
          res.statusAt = at;
          state.lastStatus = 'idle';
        } else if (stopReason === 'stop') {
          if (state.shells.size) {
            state.shells.clear();
            res.shellsChanged = true;
          }
          pushAct(`${ctx.idPrefix}:done:${key}`, SPECIAL.turnDone(durationMs), durationMs !== undefined ? { durationMs } : {});
          res.status = 'idle';
          res.statusAt = at;
          state.lastStatus = 'idle';
        }
        return res;
      }

      if (msg.role === 'toolResult') {
        if (entryId && !trackSeen(state.seenEntries, `msg:${entryId}`)) return res;
        const callId = str(msg.toolCallId);
        if (callId && state.shells.delete(callId)) res.shellsChanged = true;
        if (msg.isError === true) {
          const toolName = str(msg.toolName);
          const { text } = piContentText(msg.content);
          pushAct(`${ctx.idPrefix}:terr:${callId ?? key}`, SPECIAL.error(toolName, text || tr('falhou')), { error: true, tool: toolName });
        }
        res.status = 'working';
        res.statusAt = at;
        state.lastStatus = 'working';
        return res;
      }

      if (msg.role === 'bashExecution') {
        if (entryId && !trackSeen(state.seenEntries, `msg:${entryId}`)) return res;
        const cmd = str(msg.command);
        if (cmd) {
          pushAct(`${ctx.idPrefix}:ubash:${key}`, describeTool('Bash', { command: cmd }), { tool: 'Bash' });
        }
        return res;
      }

      return res;
    }

    default:
      return res;
  }
}
