// Agentes externos: ferramentas sem suporte próprio no Habblaud (ex.: o Grok, que não grava as conversas no
// computador nem tem hooks como os do Claude Code e do Codex) entram no escritório mandando eventos para
// POST /api/external/events (server/external/http.ts), de um script, de um hook ou de um wrapper
// (scripts/agent-event.mjs faz isso pela linha de comando).
//
// Cada ferramenta vira uma conta (provider 'external', id = o slug da ferramenta: "grok") e cada sessão, um
// personagem na sala do projeto (`cwd`). Não há arquivo de conversa: o que aparece é só o que os eventos contam.
//
// Eventos (campo `event`):
//   start     a sessão abriu (o personagem chega ocioso)
//   prompt    nova instrução (`text`): fica trabalhando
//   activity  o que está fazendo agora: `kind` + `text` (+ `detail`), ou `toolName` + `input` no formato do Claude
//             Code (Bash, Read, Edit...), descrito como as atividades do Claude Code
//   waiting   precisa de você (`text` = o motivo): levanta a mão
//   idle      terminou o turno
//   end       a sessão fechou (o personagem vai embora)
// O primeiro evento de uma sessão precisa do `cwd` (a pasta do projeto, que define a sala). Uma sessão sem eventos
// por HABBLAUD_EXTERNAL_TTL minutos (padrão 30) sai sozinha: o script que a acompanhava pode ter morrido sem `end`.
import type { Activity, ActivityKind, AgentStats, AgentStatus, SourceInfo } from '../../../shared/types';
import { describePrompt, describeTool, maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

export const EXTERNAL_EVENTS = ['start', 'prompt', 'activity', 'waiting', 'idle', 'end'] as const;
export type ExternalEventName = (typeof EXTERNAL_EVENTS)[number];

/** Um evento de agente externo, já validado (parseExternalEvent em server/external/http.ts). */
export interface ExternalEvent {
  /** Ferramenta, como slug: letras minúsculas, números e hífen (ex.: "grok"). Vira o id da conta. */
  tool: string;
  /** Nome exibido da ferramenta (ex.: "Grok"); ausente = o slug com a primeira letra maiúscula. */
  toolLabel?: string;
  /** Id estável da sessão, dado por quem manda os eventos. */
  session: string;
  event: ExternalEventName;
  /** Pasta do projeto (absoluta). Obrigatória no primeiro evento da sessão. */
  cwd?: string;
  /** Título da sessão. */
  title?: string;
  /** Modelo em uso. */
  model?: string;
  /** prompt: a instrução; activity: a descrição; waiting: o motivo. */
  text?: string;
  /** activity: o tipo da atividade (padrão 'other'). */
  kind?: ActivityKind;
  /** activity: detalhe (comando, caminho...). */
  detail?: string;
  /** activity: nome de ferramenta no formato do Claude Code (Bash, Read, Edit...), descrita a partir de `input`. */
  toolName?: string;
  input?: unknown;
}

export type ExternalApplyResult = { ok: true } | { ok: false; error: string };

/** O que a rota precisa da fonte: aplicar um evento. */
export interface ExternalLive {
  applyEvent(ev: ExternalEvent): ExternalApplyResult;
}

export const DEFAULT_TTL_MIN = 30;
const SWEEP_MS = 30_000;
const MAX_TEXT = 46;
const MAX_DETAIL = 300;
const MAIN_ROLE = tr('Agente externo');
/** Cores das contas externas (distintas das do Claude Code e do Codex), na ordem em que as ferramentas aparecem. */
const EXTERNAL_COLORS = ['#e8c547', '#38c6c6', '#c77dff', '#ff8c69', '#9acd32'] as const;

export const KIND_ICONS: Record<ActivityKind, string> = {
  prompt: '📨',
  think: '💭',
  respond: '💬',
  read: '📖',
  search: '🔎',
  edit: '✏️',
  write: '📝',
  run: '💻',
  test: '🧪',
  git: '🌿',
  web: '🌐',
  browser: '🧭',
  plan: '🗒️',
  delegate: '👥',
  communicate: '📣',
  ask: '❓',
  mcp: '🔌',
  skill: '🧰',
  wait: '⏳',
  error: '⚠️',
  compact: '🧹',
  done: '✅',
  other: '🛠️',
};

/** Nome exibido de uma ferramenta: o dado ou o slug com a primeira letra maiúscula ("grok" -> "Grok"). */
export function toolDisplayName(tool: string, label?: string): string {
  return label?.trim() || tool.charAt(0).toUpperCase() + tool.slice(1);
}

interface ToolState {
  tool: string;
  label: string;
  /** Id da conta (o slug ou, se outra conta já o usa, "<slug>~2"...). */
  account: string;
}

interface SessionState {
  key: string;
  tool: string;
  session: string;
  cwd: string;
  status: AgentStatus;
  title?: string;
  model?: string;
  startedAt: number;
  lastAt: number;
  seq: number;
  /** Eventos `activity` recebidos (o "ferramentas usadas" do agente). */
  toolCalls: number;
}

export interface ExternalSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Minutos sem eventos até a sessão sair sozinha (padrão DEFAULT_TTL_MIN). */
  ttlMin?: number;
  now?: () => number;
  /** Varredura das sessões esquecidas (desligada nos testes, que chamam sweep()). */
  sweep?: boolean;
}

/** Os eventos não contam tokens nem custo: só as atividades (toolCalls). */
function statsOf(s: SessionState): AgentStats {
  return { toolCalls: s.toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

/** Atividade de um evento `activity`: a descrita pela ferramenta do Claude Code ou a montada de kind/text/detail. */
export function externalActivity(ev: ExternalEvent, id: string, at: number): Activity | undefined {
  if (ev.toolName) {
    const d = describeTool(ev.toolName, ev.input ?? {});
    return { id, at, ...d, tool: ev.toolName };
  }
  const text = ev.text?.trim();
  if (!text) return undefined;
  const kind = ev.kind ?? 'other';
  const a: Activity = { id, at, kind, icon: KIND_ICONS[kind], text: truncate(maskSecrets(text), MAX_TEXT) };
  const detail = ev.detail?.trim();
  if (detail) a.detail = truncate(maskSecrets(detail), MAX_DETAIL);
  return a;
}

export class ExternalSource implements AgentSource, ExternalLive {
  readonly provider = 'external' as const;
  private readonly tools = new Map<string, ToolState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ExternalSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = Math.max(1, opts.ttlMin ?? DEFAULT_TTL_MIN) * 60_000;
  }

  start(): void {
    if (this.opts.sweep === false || this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    return [...this.tools.values()].map((t) => ({
      label: t.account,
      provider: 'external' as const,
      path: `external:${t.tool}`,
      sessions: [...this.sessions.values()].filter((s) => s.tool === t.tool).length,
      ok: true,
    }));
  }

  /** Não há arquivo de conversa: o terminal e o histórico não mostram agentes externos. */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /** Tira as sessões sem eventos há mais de HABBLAUD_EXTERNAL_TTL minutos. */
  sweep(): void {
    const limit = this.now() - this.ttlMs;
    for (const s of [...this.sessions.values()]) if (s.lastAt < limit) this.close(s);
  }

  applyEvent(ev: ExternalEvent): ExternalApplyResult {
    const now = this.now();
    const tool = this.toolOf(ev);
    const key = `${tool.account}:${ev.session}`;
    let s = this.sessions.get(key);
    if (!s) {
      // Fim de uma sessão que nunca entrou (ou que já saiu pelo prazo): nada a fazer.
      if (ev.event === 'end') return { ok: true };
      if (!ev.cwd) return { ok: false, error: tr('o primeiro evento de uma sessão precisa do cwd (a pasta do projeto)') };
      s = { key, tool: tool.tool, session: ev.session, cwd: ev.cwd, status: 'idle', startedAt: now, lastAt: now, seq: 0, toolCalls: 0 };
      this.sessions.set(key, s);
    }
    s.lastAt = now;
    const office = this.opts.office;
    if (!office.has(key)) {
      if (ev.event === 'end') {
        this.sessions.delete(key);
        return { ok: true };
      }
      office.addMain({
        id: key,
        provider: 'external',
        account: tool.account,
        sessionId: ev.session,
        cwd: s.cwd,
        role: MAIN_ROLE,
        startedAt: s.startedAt,
        status: s.status,
      });
    }
    if (ev.title?.trim()) s.title = truncate(maskSecrets(ev.title), 120);
    if (ev.model?.trim()) s.model = ev.model.trim();

    switch (ev.event) {
      case 'start':
        break;
      case 'prompt': {
        const text = ev.text?.trim();
        if (text) office.addActivity(key, { id: this.activityId(s, now), at: now, ...describePrompt(maskSecrets(text)) }, true);
        this.setStatus(s, 'working');
        break;
      }
      case 'activity': {
        const act = externalActivity(ev, this.activityId(s, now), now);
        if (!act) return { ok: false, error: tr('activity precisa de text (ou de toolName)') };
        s.toolCalls++;
        this.setStatus(s, 'working');
        office.addActivity(key, act, true);
        break;
      }
      case 'waiting': {
        const reason = ev.text?.trim() ? truncate(maskSecrets(ev.text), MAX_TEXT) : tr('responder no {0}', [tool.label]);
        this.setStatus(s, 'waiting', reason);
        break;
      }
      case 'idle':
        this.setStatus(s, 'idle');
        break;
      case 'end':
        this.close(s);
        return { ok: true };
    }
    office.applyTranscript(key, { title: s.title, model: s.model, tasks: [], stats: statsOf(s), lastAt: now });
    return { ok: true };
  }

  private setStatus(s: SessionState, status: AgentStatus, waitingFor?: string): void {
    s.status = status;
    this.opts.office.setStatus(s.key, status, waitingFor);
  }

  private close(s: SessionState): void {
    this.sessions.delete(s.key);
    this.opts.office.closeMain(s.key);
  }

  private activityId(s: SessionState, now: number): string {
    return `${s.key}#${now.toString(36)}-${(s.seq++).toString(36)}`;
  }

  /** A ferramenta do evento, registrada como conta na primeira vez (e quando o nome exibido muda). */
  private toolOf(ev: ExternalEvent): ToolState {
    const label = toolDisplayName(ev.tool, ev.toolLabel);
    const known = this.tools.get(ev.tool);
    if (known && (known.label === label || !ev.toolLabel)) return known;
    this.tools.set(ev.tool, { tool: ev.tool, label, account: known?.account ?? ev.tool });
    this.register();
    return this.tools.get(ev.tool)!;
  }

  /** Registra (de novo) as contas no AccountsService, sempre na mesma ordem: os ids não mudam. */
  private register(): void {
    const list = [...this.tools.values()];
    const entries = this.opts.accounts.setProviderAccounts(
      'external',
      list.map((t, i) => ({
        dir: `external:${t.tool}`,
        detected: {
          id: t.tool,
          configDir: `external:${t.tool}`,
          short: t.label.charAt(0).toUpperCase(),
          name: t.label,
          color: EXTERNAL_COLORS[i % EXTERNAL_COLORS.length],
        },
      })),
    );
    entries.forEach((e, i) => {
      list[i].account = e.id;
    });
  }
}
