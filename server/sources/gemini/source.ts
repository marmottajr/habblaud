// Fonte de agentes do Gemini CLI (AgentSource 'gemini', ver sources/source.ts).
//
// O Gemini CLI não grava um registro de sessões abertas (como o Claude Code) nem travas (como o Codex): tudo o que o
// escritório sabe dele chega pelos HOOKS (mod/habblaud-gemini/hook.mjs, que `npm run gemini:install` acrescenta em
// ~/.gemini/settings.json) via POST /api/gemini/events. Por isso esta fonte é só "ao vivo", e funciona igual no modo
// Node e no Docker (nenhuma pasta do Gemini é montada no container):
//
// - SessionStart / qualquer evento: a sessão entra no escritório (a sala é o `cwd` do evento);
// - BeforeAgent (o usuário mandou um prompt): trabalhando, com a atividade "Nova tarefa";
// - BeforeTool: trabalhando, com a atividade da ferramenta (ler, editar, rodar comando, buscar na web...);
// - AfterTool / PreCompress: trabalhando;
// - Notification (ToolPermission): esperando você (mão levantada) até a próxima ferramenta ou o fim do turno;
// - AfterAgent: terminou o turno (ocioso);
// - SessionEnd: a sessão sai do escritório.
//
// Presença sem eventos: uma sessão ociosa e sem nenhum evento por IDLE_TTL_MS sai (o Gemini não avisa quando um
// terminal é fechado à força); uma "trabalhando" sem nada por WORKING_QUIET_MS volta a ociosa (turno morto).
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { describeCommand, describePrompt, describeTool, truncate, type ActivityDescription } from '../../../shared/activity';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { tr } from '../../../shared/i18n';

/** Sessão ociosa sem nenhum evento por este tempo: sai do escritório. */
export const IDLE_TTL_MS = 3 * 3600_000;
/** Sessão "trabalhando" sem nenhum evento por este tempo: o turno morreu (Ctrl+C sem AfterAgent, crash). */
export const WORKING_QUIET_MS = 10 * 60_000;
const MAIN_ROLE = tr('Agente principal (Gemini)');
/** Cor da conta do Gemini (azul do Gemini). */
export const GEMINI_COLOR = '#4b8bf5';

export const GEMINI_HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
  'PreCompress',
]);

/** Eventos dos hooks do Gemini que chegam pelo POST /api/gemini/events. */
export interface GeminiLive {
  /** Aplica um evento de hook (o stdin dele). Devolve false para evento desconhecido ou sem sessão. */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}

export interface GeminiSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta do Gemini (~/.gemini) como o usuário a vê (no Docker, a do host): só para exibir. */
  configDir: string;
  /** E-mail da conta Google ativa, quando conhecido (~/.gemini/google_accounts.json). */
  email?: string;
  now?: () => number;
  pollMs?: number;
}

interface GeminiSession {
  key: string;
  sessionId: string;
  cwd?: string;
  status: AgentStatus;
  waitingFor?: string;
  startedAt: number;
  lastAt: number;
  inOffice: boolean;
  title?: string;
  toolCalls: number;
  seq: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Id de sessão aceito (o Gemini usa UUIDs; aceitamos qualquer id curto e sem barras). */
function validSessionId(v: string | undefined): v is string {
  return !!v && v.length <= 128 && /^[\w.-]+$/.test(v);
}

/** Primeira URL de um texto (o web_fetch do Gemini recebe um prompt com as URLs dentro). */
function firstUrl(text: string | undefined): string | undefined {
  return text ? /https?:\/\/[^\s"'<>)]+/i.exec(text)?.[0] : undefined;
}

/** Ferramenta do Gemini CLI → atividade do escritório (usa os textos das ferramentas equivalentes do Claude Code). */
export function describeGeminiTool(name: string, input: Record<string, unknown>): { desc: ActivityDescription; tool: string } {
  const file = str(input.file_path) ?? str(input.absolute_path) ?? str(input.path);
  switch (name) {
    case 'run_shell_command': {
      const command = str(input.command) ?? '';
      return { desc: describeCommand(command, str(input.description)), tool: 'Bash' };
    }
    case 'read_file':
      return { desc: describeTool('Read', { file_path: file }), tool: 'Read' };
    case 'read_many_files': {
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : [];
      const desc = describeTool('Read', { file_path: paths[0] });
      if (paths.length > 1) desc.text = tr('Lendo {0} arquivos', [String(paths.length)]);
      if (paths.length) desc.detail = truncate(paths.join(', '), 300);
      return { desc, tool: 'Read' };
    }
    case 'write_file':
      return { desc: describeTool('Write', { file_path: file }), tool: 'Write' };
    case 'replace':
    case 'edit':
      return { desc: describeTool('Edit', { file_path: file }), tool: 'Edit' };
    case 'glob':
      return { desc: describeTool('Glob', { pattern: input.pattern, path: input.dir_path ?? input.path }), tool: 'Glob' };
    case 'search_file_content':
    case 'grep_search':
    case 'grep':
      return { desc: describeTool('Grep', { pattern: input.pattern, path: input.dir_path ?? input.path }), tool: 'Grep' };
    case 'list_directory':
      return { desc: describeTool('LS', { path: input.dir_path ?? input.path }), tool: 'LS' };
    case 'google_web_search':
    case 'web_search':
      return { desc: describeTool('WebSearch', { query: input.query }), tool: 'WebSearch' };
    case 'web_fetch': {
      const prompt = str(input.prompt);
      return { desc: describeTool('WebFetch', { url: str(input.url) ?? firstUrl(prompt), prompt }), tool: 'WebFetch' };
    }
    case 'write_todos':
      return { desc: { kind: 'plan', icon: '🗒️', text: tr('Atualizando as tarefas') }, tool: name };
    case 'save_memory':
      return { desc: { kind: 'other', icon: '🧠', text: tr('Guardando na memória'), detail: str(input.fact) }, tool: name };
    case 'ask_user':
      return { desc: { kind: 'ask', icon: '❓', text: tr('Fazendo uma pergunta') }, tool: name };
    case 'enter_plan_mode':
    case 'exit_plan_mode':
      return { desc: { kind: 'plan', icon: '🧭', text: tr('Planejando') }, tool: name };
    case 'activate_skill':
      return { desc: describeTool('Skill', { skill: input.name ?? input.skill }), tool: 'Skill' };
    case 'codebase_investigator':
    case 'delegate_to_agent':
    case 'generalist':
    case 'cli_help': {
      const task = str(input.objective) ?? str(input.query) ?? str(input.task) ?? str(input.prompt);
      return { desc: describeTool('Agent', { description: task ? truncate(task, 60) : undefined, subagent_type: name }), tool: 'Agent' };
    }
    default: {
      // MCP: mcp_<servidor>_<ferramenta> (o Claude Code usa mcp__servidor__ferramenta).
      const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
      if (mcp) return { desc: describeTool(`mcp__${mcp[1]}__${mcp[2]}`, input), tool: name };
      return { desc: describeTool(name, input), tool: name };
    }
  }
}

/** Conta do Gemini como o AccountsService espera. */
export function geminiAccount(configDir: string, email?: string): DetectedAccount {
  const acc: DetectedAccount = { id: '.gemini', provider: 'gemini', configDir, short: 'G', name: 'Gemini', color: GEMINI_COLOR };
  if (email) acc.email = email;
  return acc;
}

export class GeminiSource implements AgentSource, GeminiLive {
  readonly provider = 'gemini' as const;
  private entries: readonly AccountEntry[] = [];
  private sessions = new Map<string, GeminiSession>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private lastEventAt = 0;

  constructor(private readonly opts: GeminiSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.entries = opts.accounts.setProviderAccounts('gemini', [{ dir: opts.configDir, detected: geminiAccount(opts.configDir, opts.email) }]);
  }

  /** Conta do Gemini (id final, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  private get accountId(): string {
    return this.entries[0]?.id ?? '.gemini';
  }

  start(): void {
    this.timer = setInterval(() => this.sweep(), this.opts.pollMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const s of this.sessions.values()) if (s.inOffice) sessions++;
    return [{ label: this.accountId, provider: 'gemini', path: this.opts.configDir, sessions, ok: true }];
  }

  /** O Gemini grava a conversa num JSON (não em linhas): o terminal do escritório não o acompanha. */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Recebeu algum evento dos hooks (o /api/health e o gemini:status mostram). */
  lastEvent(): number {
    return this.lastEventAt;
  }

  // ---------------------------------------------------------------- hooks

  applyHookEvent(_account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(input);
    } catch (err) {
      log.warnOnce(`gemini-hook:${errMsg(err)}`, tr('Gemini: evento de hook ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private hookEvent(input: Record<string, unknown>): boolean {
    const event = str(input.hook_event_name);
    if (!event || !GEMINI_HOOK_EVENTS.has(event)) return false;
    const sessionId = str(input.session_id);
    if (!validSessionId(sessionId)) return false;
    const now = this.now();
    this.lastEventAt = now;
    const key = `${this.accountId}:${sessionId}`;
    const office = this.opts.office;

    if (event === 'SessionEnd') {
      const s = this.sessions.get(key);
      if (!s) return false;
      this.close(s);
      return true;
    }

    let s = this.sessions.get(key);
    if (!s) {
      s = { key, sessionId, status: 'idle', startedAt: now, lastAt: now, inOffice: false, toolCalls: 0, seq: 0 };
      this.sessions.set(key, s);
    }
    s.lastAt = now;
    const cwd = str(input.cwd);
    if (cwd) s.cwd ??= cwd;
    if (s.inOffice && !office.has(s.key)) s.inOffice = false;

    switch (event) {
      case 'SessionStart':
        this.setStatus(s, 'idle');
        break;
      case 'BeforeAgent': {
        const prompt = str(input.prompt);
        if (prompt && !s.title) s.title = truncate(prompt.replace(/\s+/g, ' '), 80);
        this.setStatus(s, 'working');
        if (prompt) this.activity(s, describePrompt(prompt), undefined, now);
        break;
      }
      case 'BeforeTool': {
        this.setStatus(s, 'working');
        const name = str(input.tool_name) ?? 'ferramenta';
        const { desc, tool } = describeGeminiTool(name, rec(input.tool_input) ?? {});
        s.toolCalls++;
        this.activity(s, desc, tool, now);
        break;
      }
      case 'AfterTool': {
        this.setStatus(s, 'working');
        const resp = rec(input.tool_response);
        const error = resp && (str(resp.error) ?? str(rec(resp.error)?.message));
        if (error) this.activity(s, { kind: 'error', icon: '⚠️', text: tr('Erro na ferramenta'), detail: truncate(error, 300) }, str(input.tool_name), now, true);
        break;
      }
      case 'PreCompress':
        this.setStatus(s, 'working');
        this.activity(s, { kind: 'compact', icon: '🗜️', text: tr('Compactando o contexto') }, undefined, now);
        break;
      case 'Notification': {
        if (str(input.notification_type) !== 'ToolPermission') break;
        const details = rec(input.details);
        const tool = str(details?.tool_name) ?? str(details?.toolName) ?? str(details?.title);
        this.setStatus(s, 'waiting', tool ? tr('aprovar {0}', [truncate(tool, 40)]) : tr('aprovar uma ação'));
        break;
      }
      case 'AfterAgent':
        this.setStatus(s, 'idle');
        break;
      default:
        break;
    }
    this.enter(s);
    return true;
  }

  // ---------------------------------------------------------------- escritório

  private enter(s: GeminiSession): void {
    if (s.inOffice || !s.cwd) {
      if (s.inOffice) this.summary(s);
      return;
    }
    const office = this.opts.office;
    office.addMain({
      id: s.key,
      provider: 'gemini',
      account: this.accountId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      role: MAIN_ROLE,
      startedAt: s.startedAt,
      status: s.status,
      waitingFor: s.waitingFor,
    });
    s.inOffice = office.has(s.key);
    if (s.inOffice) {
      office.setStatus(s.key, s.status, s.waitingFor);
      this.summary(s);
    }
  }

  private summary(s: GeminiSession): void {
    this.opts.office.applyTranscript(s.key, {
      title: s.title,
      tasks: [],
      stats: { toolCalls: s.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 },
      firstAt: s.startedAt,
      lastAt: s.lastAt,
    });
  }

  private setStatus(s: GeminiSession, status: AgentStatus, waitingFor?: string): void {
    s.status = status;
    s.waitingFor = status === 'waiting' ? waitingFor : undefined;
    if (s.inOffice) this.opts.office.setStatus(s.key, status, s.waitingFor);
  }

  private activity(s: GeminiSession, desc: ActivityDescription, tool: string | undefined, at: number, error = false): void {
    if (!s.cwd) return;
    if (!s.inOffice) this.enter(s);
    if (!s.inOffice) return;
    const act: Activity = { id: `${s.key}#${(++s.seq).toString(36)}`, at, ...desc };
    if (tool) act.tool = tool;
    if (error) act.error = true;
    this.opts.office.addActivity(s.key, act, !error, { feed: true });
  }

  private close(s: GeminiSession): void {
    if (s.inOffice) this.opts.office.closeMain(s.key);
    s.inOffice = false;
    this.sessions.delete(s.key);
  }

  /** Sessões esquecidas (terminal fechado sem SessionEnd) e turnos mortos. */
  sweep(): void {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      const quiet = now - s.lastAt;
      if (s.status === 'working' && quiet > WORKING_QUIET_MS) this.setStatus(s, 'idle');
      if (s.status !== 'working' && quiet > IDLE_TTL_MS) this.close(s);
    }
  }
}
