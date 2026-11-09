// Parser das linhas do transcript do Kiro CLI (~/.kiro/sessions/cli/<uuid>.jsonl).
// Cada linha é uma mensagem inteira: Prompt (o pedido, com meta.timestamp em segundos), AssistantMessage (thinking +
// texto + zero ou mais toolUse), ToolResults (os resultados), Compaction e Clear. Uma AssistantMessage sem toolUse é a
// última do turno (o Kiro só volta a escrever com um pedido novo), mesmo que só tenha thinking.
// As descrições reaproveitam as do Claude Code (shared/activity.ts): mesmo texto, mesmo ícone e segredos mascarados.
import type { Activity, AgentStatus } from '../../../shared/types';
import {
  basename,
  describeCommand,
  describePrompt,
  describeTool,
  maskSecrets,
  SPECIAL,
  truncate,
  type ActivityDescription,
} from '../../../shared/activity';
import { tr } from '../../../shared/i18n';

type Part = { kind?: unknown; data?: unknown };
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Ferramentas de shell (nomes do Kiro CLI 2.x/3.x e os antigos do Amazon Q). */
export const KIRO_SHELL_TOOLS: ReadonlySet<string> = new Set(['shell', 'execute_bash', 'execute_cmd', 'execute_pwsh', 'bash', 'execute']);

/** Mesma ferramenta com nomes diferentes (2.x no transcript e no hook, 3.x no hook). */
export function sameKiroTool(a: string, b: string): boolean {
  if (a === b) return true;
  if (KIRO_SHELL_TOOLS.has(a) && KIRO_SHELL_TOOLS.has(b)) return true;
  const group = (n: string) => (/^(read|fs_read|read_file)$/.test(n) ? 'read' : /^(write|fs_write|write_file)$/.test(n) ? 'write' : n);
  return group(a) === group(b);
}
const GITHUB_TOOL = /pull_request|issue|repositor|branch|commit|push_files|file_contents|create_or_update_file|search_code|gist|workflow|release/;

export interface KiroToolUse {
  /** toolUseId (liga o toolUse ao ToolResults). */
  id: string;
  name: string;
  /** Texto curto da atividade. */
  label: string;
}

export interface KiroParsedLine {
  /** `kind` da linha (Prompt, AssistantMessage, ToolResults, Compaction, Clear). */
  kind: string;
  messageId?: string;
  activities: Activity[];
  /** A última atividade da linha (atalho para quem só quer uma). */
  activity?: Activity;
  status?: AgentStatus;
  waitingFor?: string;
  /** toolUse desta mensagem: ficam pendentes até o ToolResults. */
  tools?: KiroToolUse[];
  /** ToolResults: os toolUseIds respondidos (error = status de erro). */
  results?: Array<{ id: string; error: boolean }>;
  /** Fechou o turno (resposta final ou /clear). */
  turnEnd?: boolean;
  /** Prompt: quando foi enviado (ms) e o texto sem o contexto injetado. */
  promptAt?: number;
  promptText?: string;
  command?: string;
}

export interface KiroParseOptions {
  /** Prefixo dos ids das atividades (o id da sessão): ids únicos no feed entre sessões. */
  idPrefix?: string;
  /** Ferramenta MCP -> servidor (das permissões da sessão), para "GitHub: …" em vez de "Usando …". */
  mcpServers?: ReadonlyMap<string, string>;
}

// ------------------------------------------------------------------ prompt

const CREW_REQUEST = /\[CURRENT USER REQUEST[^\]\n]*\]/;
const REPLY_RULES = '[REPLY FORMAT RULES]';
const INJECTED_BLOCKS: RegExp[] = [
  /\[AGENT SYSTEM PROMPT\][\s\S]*?\[END AGENT SYSTEM PROMPT\]/g,
  /\[SESSION CONTEXT[^\]\n]*\][\s\S]*?\[END OF SESSION CONTEXT\]/g,
  /<EnvironmentContext>[\s\S]*?<\/EnvironmentContext>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
];

/**
 * O pedido de verdade dentro de um Prompt. Quem abre o Kiro por ACP (ex.: Kiro Crew) manda junto o prompt do agente,
 * regras e contexto ("[AGENT SYSTEM PROMPT] … [REPLY FORMAT RULES] (…) <pedido>"): sem isso o título e o balão
 * mostravam "[AGENT SYSTEM PROMPT]". Texto sem esses marcadores volta igual (só sem espaços nas pontas).
 */
export function cleanKiroPrompt(text: string): string {
  let t = text;
  let injected = false;
  const req = CREW_REQUEST.exec(t);
  if (req) {
    t = t.slice(req.index + req[0].length);
    injected = true;
  } else {
    const rules = t.lastIndexOf(REPLY_RULES);
    if (rules >= 0) {
      // Depois das regras de formato vêm parágrafos "(…)" de instrução e, por fim, o pedido.
      const lines = t.slice(rules + REPLY_RULES.length).split('\n');
      let i = 0;
      while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith('('))) i++;
      t = lines.slice(i).join('\n');
      injected = true;
    }
  }
  for (const re of INJECTED_BLOCKS) {
    const next = t.replace(re, ' ');
    if (next !== t) injected = true;
    t = next;
  }
  // Linhas de contexto soltas no começo ("[RUNTIME] …", "[PROJECT] …"), só quando o prompt veio montado.
  if (injected) t = t.replace(/^(?:\s*\[[A-Z][A-Za-z0-9 _-]{2,40}\][^\n]*(?:\n|$))+/, '');
  return t.trim();
}

/** Título do .json da sessão sem o contexto injetado (o Kiro usa o começo do primeiro prompt). */
export function cleanKiroTitle(t: string | undefined): string | undefined {
  if (!t?.trim()) return undefined;
  if (!t.trimStart().startsWith('[')) return t.trim();
  const c = cleanKiroPrompt(t);
  return c && !c.startsWith('[') ? truncate(c, 90) : undefined;
}

// ------------------------------------------------------------------ ferramentas

function mk(kind: ActivityDescription['kind'], icon: string, text: string, detail?: string): ActivityDescription {
  return {
    kind,
    icon,
    text: truncate(maskSecrets(text.slice(0, 400)), 46),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, 1200)), 300) } : {}),
  };
}

function humanize(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

/** Junta o "para quê" (__tool_use_purpose) ao detalhe, que é onde o Claude Code põe a descrição em inglês. */
function withPurpose(d: ActivityDescription, purpose: string): ActivityDescription {
  if (!purpose || d.detail?.includes(purpose)) return d;
  return { ...d, detail: truncate(maskSecrets(d.detail ? `${purpose} — ${d.detail}` : purpose), 300) };
}

function describeRead(input: Obj): ActivityDescription {
  const ops = Array.isArray(input.operations) ? input.operations.map(obj) : [input];
  const first = ops[0] ?? {};
  const path = str(first.path) || str(input.path) || str(input.file);
  if (ops.length > 1) {
    const paths = ops.map((o) => str(o.path)).filter(Boolean);
    return mk('read', '📖', tr('Lendo {0} arquivos', [ops.length]), paths.join(', '));
  }
  const mode = str(first.mode).toLowerCase();
  if (mode === 'directory') return describeTool('LS', { path });
  if (mode === 'search') return describeTool('Grep', { pattern: str(first.pattern) });
  if (mode === 'image') {
    const img = Array.isArray(first.image_paths) ? str(first.image_paths[0]) : path;
    return describeTool('Read', { file_path: img || 'imagem.png' });
  }
  return describeTool('Read', { file_path: path });
}

/** Servidor MCP de uma ferramenta: o das permissões da sessão, "@servidor/ferramenta" ou o GitHub pelo nome. */
function mcpServerOf(name: string, input: Obj, servers?: ReadonlyMap<string, string>): { server: string; tool: string } | undefined {
  const known = servers?.get(name);
  if (known) return { server: known, tool: name };
  const at = /^@?([\w.-]+)\/(.+)$/.exec(name);
  if (at) return { server: at[1], tool: at[2] };
  if (GITHUB_TOOL.test(name) && (input.owner !== undefined || input.repo !== undefined || input.q !== undefined || input.query !== undefined)) {
    return { server: 'github', tool: name };
  }
  return undefined;
}

/** Descreve uma chamada de ferramenta do Kiro CLI em português (texto curto, ícone e detalhe mascarado). */
export function describeKiroTool(name: string, rawInput: unknown = {}, mcpServers?: ReadonlyMap<string, string>): ActivityDescription {
  const input = obj(rawInput);
  const purpose = str(input.__tool_use_purpose).trim();

  if (KIRO_SHELL_TOOLS.has(name)) {
    const command = str(input.command);
    return withPurpose(command.trim() ? describeCommand(command, purpose || undefined) : describeCommand('', undefined), purpose);
  }

  let d: ActivityDescription;
  switch (name) {
    case 'read':
    case 'fs_read':
    case 'read_file':
    case 'view_file':
    case 'cat':
      d = describeRead(input);
      break;
    case 'write':
    case 'fs_write':
    case 'write_file':
    case 'edit':
    case 'str_replace':
    case 'fs_append':
    case 'replace_file_content': {
      const file_path = str(input.path) || str(input.file);
      // 3.x: fs_write cria (path + text); 2.x: write com command create|strReplace.
      const create = str(input.command) === 'create' || name === 'write_file' || (name === 'fs_write' && !input.command && input.text !== undefined);
      d = describeTool(create ? 'Write' : 'Edit', { file_path });
      break;
    }
    case 'delete_file': {
      const file = str(input.path);
      d = mk('edit', '🗑️', file ? tr('Apagando {0}', [basename(file)]) : tr('Apagando um arquivo'), file);
      break;
    }
    case 'list_directory':
      d = describeTool('LS', { path: str(input.path) });
      break;
    case 'glob':
    case 'file_search':
      d = describeTool('Glob', { pattern: str(input.pattern) || str(input.query) });
      break;
    case 'grep':
    case 'grep_search':
    case 'search':
    case 'find':
      d = describeTool('Grep', { pattern: str(input.pattern) || str(input.query) });
      break;
    case 'web_fetch':
      d = describeTool('WebFetch', { url: str(input.url) });
      break;
    case 'web_search':
    case 'remote_web_search':
      d = describeTool('WebSearch', { query: str(input.query) });
      break;
    case 'todo_list':
    case 'todo':
      d = mk('plan', '🗒️', tr('Atualizando a lista de tarefas'));
      break;
    case 'subagent':
    case 'use_subagent':
    case 'delegate':
      d = describeTool('Task', { description: purpose || truncate(str(input.task), 40), prompt: str(input.task) });
      break;
    case 'summary':
      d = describeTool('StructuredOutput', {});
      break;
    case 'use_aws': {
      const service = str(input.service_name);
      const op = humanize(str(input.operation_name));
      const where = [str(input.label), str(input.profile_name), str(input.region)].filter(Boolean).join(' · ');
      d = mk('run', '☁️', service ? `AWS: ${service} ${op}`.trim() : tr('Rodando um comando no terminal'), where);
      break;
    }
    case 'introspect':
      d = mk('read', '📚', tr('Consultando a documentação do Kiro'), str(input.query));
      break;
    case 'knowledge':
      d = mk('search', '🧠', tr('Consultando a base de conhecimento'), str(input.query) || str(input.command));
      break;
    case 'thinking':
      d = SPECIAL.think();
      break;
    case 'ask':
    case 'ask_question':
      d = mk('ask', '❓', tr('Fazendo uma pergunta a você'), str(input.question) || str(input.command));
      break;
    default: {
      const mcp = mcpServerOf(name, input, mcpServers);
      d = mcp ? describeTool(`mcp__${mcp.server}__${mcp.tool}`, input) : describeTool(name, input);
    }
  }
  return withPurpose(d, purpose);
}

// ------------------------------------------------------------------ linhas

/**
 * Converte uma linha do transcript. `now` vira o horário das atividades sem horário próprio (só o Prompt tem
 * meta.timestamp): quem relê o arquivo inteiro passa o horário do turno (ver watcher.ts).
 */
export function parseKiroJsonlLine(line: string, index: number, now: number = Date.now(), opts: KiroParseOptions = {}): KiroParsedLine | undefined {
  if (!line || !line.trim()) return undefined;
  let parsed: Obj;
  try {
    parsed = obj(JSON.parse(line));
  } catch {
    return undefined;
  }

  const kind = str(parsed.kind);
  const data = obj(parsed.data);
  const messageId = str(data.message_id) || undefined;
  const parts: Part[] = Array.isArray(data.content) ? data.content.map((p) => obj(p) as Part) : [];
  const prefix = opts.idPrefix ? `${opts.idPrefix}#` : '';
  const base = `${prefix}${messageId ?? `l${index}`}`;
  const texts = () =>
    parts
      .filter((p) => p.kind === 'text' && typeof p.data === 'string')
      .map((p) => p.data as string)
      .join('\n');
  const done = (r: KiroParsedLine): KiroParsedLine => (r.activities.length ? { ...r, activity: r.activities[r.activities.length - 1] } : r);

  if (kind === 'Prompt') {
    const text = cleanKiroPrompt(texts());
    const ts = obj(data.meta).timestamp;
    const at = typeof ts === 'number' && ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : now;
    const d = text ? describePrompt(text) : mk('prompt', '📨', tr('Recebeu um pedido'));
    return done({ kind, messageId, activities: [{ id: `${base}:p`, at, ...d }], status: 'working', promptAt: at, ...(text ? { promptText: text } : {}) });
  }

  if (kind === 'AssistantMessage') {
    const uses = parts.filter((p) => p.kind === 'toolUse').map((p) => obj(p.data));
    if (uses.length) {
      const activities: Activity[] = [];
      const tools: KiroToolUse[] = [];
      let ask = false;
      let command: string | undefined;
      uses.forEach((u, i) => {
        const name = str(u.name) || 'tool';
        const input = obj(u.input);
        const d = describeKiroTool(name, input, opts.mcpServers);
        const id = str(u.toolUseId) || `${base}:t${i}`;
        activities.push({ id: `${prefix}${id}`, at: now, ...d, tool: name });
        tools.push({ id, name, label: d.text });
        if (d.kind === 'ask') ask = true;
        if (command === undefined && KIRO_SHELL_TOOLS.has(name) && typeof input.command === 'string') command = input.command;
      });
      return done({
        kind,
        messageId,
        activities,
        tools,
        status: ask ? 'waiting' : 'working',
        ...(ask ? { waitingFor: tr('responder uma pergunta') } : {}),
        ...(command !== undefined ? { command } : {}),
      });
    }
    // Sem toolUse: resposta final do turno (com texto, só thinking ou vazia depois de um ToolResults).
    const text = texts().trim();
    const activities: Activity[] = text ? [{ id: `${base}:r`, at: now, ...SPECIAL.respond(text) }] : [];
    return done({ kind, messageId, activities, status: 'idle', turnEnd: true });
  }

  if (kind === 'ToolResults') {
    const results = parts
      .filter((p) => p.kind === 'toolResult')
      .map((p) => {
        const r = obj(p.data);
        return { id: str(r.toolUseId), error: /^err/i.test(str(r.status)) };
      })
      .filter((r) => r.id);
    return { kind, messageId, activities: [], results, status: 'working' };
  }

  if (kind === 'Compaction') return done({ kind, messageId, activities: [{ id: `${base}:c`, at: now, ...SPECIAL.compact() }] });
  if (kind === 'Clear') return done({ kind, messageId, activities: [{ id: `${base}:x`, at: now, ...SPECIAL.cleared() }], status: 'idle', turnEnd: true });

  return undefined;
}
