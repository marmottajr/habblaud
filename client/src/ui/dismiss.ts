// Dispensar um personagem: a sessão continua aberta no Claude Code, mas o agente sai do escritório e dos painéis
// desta página até fazer algo novo. É só o que VOCÊ vê — o servidor continua contando a sessão, e o que sobe para o
// Habblaud World não muda (ver shared/world/README.md).
// A dispensa fica em prefs.dismissedAgents (localStorage) com a hora do clique e caduca sozinha quando a sessão
// registra qualquer coisa nova (AgentInfo.lastEventAt passa da hora da dispensa) ou quando ela sai do escritório.
import type { AgentInfo } from '../../../shared/types';

export interface Dismissal {
  /** AgentInfo.id do agente principal dispensado. */
  id: string;
  /** Epoch ms (relógio do servidor) do clique. */
  at: number;
}

/**
 * As dispensas que ainda valem. Cai fora a de quem não está mais no snapshot (sessão encerrada: não há o que
 * esconder) e a de quem registrou algo depois do clique — você voltou a trabalhar naquela sessão, então o
 * personagem volta ao escritório sozinho.
 */
export function activeDismissals(list: readonly Dismissal[], agents: readonly AgentInfo[]): Dismissal[] {
  if (!list.length) return [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return list.filter((d) => {
    const a = byId.get(d.id);
    return !!a && a.status !== 'offline' && a.lastEventAt <= d.at;
  });
}

/** O principal dispensado leva junto os subagentes dele (e os subagentes deles). */
export function expandDismissed(list: readonly Dismissal[], agents: readonly AgentInfo[]): Set<string> {
  const out = new Set(list.map((d) => d.id));
  if (!out.size) return out;
  // Uma volta por nível de subagente; sem nada novo numa volta, acabou.
  for (let i = 0; i < 4; i++) {
    let grew = false;
    for (const a of agents) {
      if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return out;
}

/** Dá para dispensar este agente: principal, no escritório e ainda não dispensado. */
export function canDismiss(agent: AgentInfo | undefined, dismissed: ReadonlySet<string>): boolean {
  return !!agent && agent.kind === 'main' && agent.status !== 'offline' && !dismissed.has(agent.id);
}
