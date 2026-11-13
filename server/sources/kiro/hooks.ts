// Sessões do Kiro conhecidas só pelo hook (mod/habblaud-kiro): o Kiro CLI 3.x grava as conversas em
// ~/.kiro/sessions/<hash>/sess_<id>/ (sem trava com PID), que o watcher não lê; e no Docker sem a pasta montada nada
// chega por arquivo. Aqui o personagem nasce e trabalha só com os eventos: pedido (UserPromptSubmit), cada ferramenta
// (PreToolUse; no 3.x ele vem depois da aprovação), fim da ferramenta (PostToolUse) e do turno (Stop).
// O Kiro não avisa quando a sessão fecha: com os PIDs do Kiro (o hook manda, só no Linux) a sessão sai quando eles
// morrem; sem eles, sai depois de um tempo sem eventos (HOOK_IDLE_MS ocioso, HOOK_WORKING_MS trabalhando).
import type { Activity, AgentStats } from '../../../shared/types';
import { describePrompt, SPECIAL } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { Office } from '../../model/office';
import type { KiroHookEvent } from './live';
import { pidAlive } from './liveness';
import { cleanKiroPrompt, describeKiroTool } from './parser';

/** Sem PIDs: ocioso sem eventos por 30 min = sessão fechada. */
export const HOOK_IDLE_MS = 30 * 60_000;
/** Sem PIDs: trabalhando sem eventos por 3 h (um comando longo não manda nada até terminar). */
export const HOOK_WORKING_MS = 3 * 3600_000;
const SUBAGENT_TOOLS = new Set(['subagent', 'use_subagent', 'delegate']);

interface HookSession {
  id: string;
  account: string;
  pids: number[];
  lastAt: number;
  working: boolean;
  seq: number;
  title?: string;
  stats: AgentStats;
}

export interface KiroHookSessionsDeps {
  office: Office;
  now?: () => number;
  /** O PID está vivo? (padrão: process.kill(pid, 0)). */
  alive?: (pid: number) => boolean;
  /** Os PIDs do hook são deste sistema (falso no Docker): só então valem para saber se o Kiro fechou. */
  samePidSpace?: boolean;
}

/** Resposta de ferramenta que diz que falhou ({error}, {isError: true}, {status: "error"}, exit_status != 0). */
export function hookToolFailed(r: unknown): boolean {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  if (o.isError === true || (typeof o.error === 'string' && o.error.trim()) || /^(error|failed)$/i.test(String(o.status ?? ''))) return true;
  const exit = String(o.exit_status ?? o.exitStatus ?? '');
  return /\d/.test(exit) && !/^(0|exit status: 0)$/.test(exit.trim());
}

export class KiroHookSessions {
  private readonly office: Office;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly samePidSpace: boolean;
  private sessions = new Map<string, HookSession>();

  constructor(deps: KiroHookSessionsDeps) {
    this.office = deps.office;
    this.now = deps.now ?? Date.now;
    this.alive = deps.alive ?? pidAlive;
    this.samePidSpace = deps.samePidSpace ?? true;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  size(): number {
    return this.sessions.size;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** O watcher passou a acompanhar a sessão pelos arquivos: sai daqui sem tirar o personagem. */
  handOver(id: string): void {
    this.sessions.delete(id);
  }

  apply(account: string, e: KiroHookEvent): boolean {
    const ev = e.event;
    const now = this.now();
    let s = this.sessions.get(ev.session_id);
    if (!s) {
      if (!ev.cwd) return false;
      s = { id: ev.session_id, account, pids: [], lastAt: now, working: false, seq: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 } };
      this.sessions.set(s.id, s);
      this.office.addMain({ id: s.id, provider: 'kiro', account, sessionId: s.id, cwd: ev.cwd, role: tr('Agente do Kiro'), startedAt: now, status: 'idle' });
    }
    s.lastAt = now;
    if (e.pids.length && this.samePidSpace) s.pids = e.pids;
    const act = (a: Omit<Activity, 'id' | 'at'>) => this.office.addActivity(s.id, { id: `${s.id}#h${++s.seq}`, at: now, ...a }, true);
    switch (ev.hook_event_name) {
      case 'AgentSpawn':
        break;
      case 'UserPromptSubmit': {
        const text = cleanKiroPrompt(ev.prompt ?? '');
        if (text && !s.title) {
          s.title = text.slice(0, 90);
          this.publish(s);
        }
        act(text ? describePrompt(text) : { kind: 'prompt', icon: '📨', text: tr('Recebeu um pedido') });
        this.setWorking(s, true);
        break;
      }
      case 'PreToolUse': {
        const name = ev.tool_name || 'tool';
        act({ ...describeKiroTool(name, ev.tool_input), tool: name });
        s.stats.toolCalls++;
        if (SUBAGENT_TOOLS.has(name)) s.stats.subagents++;
        this.publish(s);
        this.setWorking(s, true);
        break;
      }
      case 'PostToolUse':
        if (hookToolFailed(ev.tool_response)) act({ ...SPECIAL.error(ev.tool_name), error: true });
        this.setWorking(s, true);
        break;
      case 'Stop':
        if (ev.assistant_response?.trim()) act(SPECIAL.respond(ev.assistant_response));
        this.setWorking(s, false);
        break;
    }
    return true;
  }

  /** Tira as sessões que fecharam: PIDs do Kiro mortos ou, sem eles, tempo demais sem eventos. */
  sweep(): void {
    const now = this.now();
    for (const s of [...this.sessions.values()]) {
      const gone = s.pids.length ? !s.pids.some((p) => this.alive(p)) : now - s.lastAt > (s.working ? HOOK_WORKING_MS : HOOK_IDLE_MS);
      if (!gone) continue;
      this.sessions.delete(s.id);
      this.office.closeMain(s.id);
    }
  }

  clear(): void {
    this.sessions.clear();
  }

  private setWorking(s: HookSession, working: boolean): void {
    s.working = working;
    this.office.setStatus(s.id, working ? 'working' : 'idle');
  }

  private publish(s: HookSession): void {
    this.office.applyTranscript(s.id, { ...(s.title ? { title: s.title } : {}), tasks: [], stats: { ...s.stats } });
  }
}
