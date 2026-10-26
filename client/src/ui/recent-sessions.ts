// Validação da resposta de /api/sessions/recent (e dos retratos guardados no navegador): pura, sem DOM.
import type { RecentSession } from '../../../shared/types';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Sessões válidas da resposta de /api/sessions/recent (o resto é ignorado), da mais recente para a mais antiga. */
export function parseRecentSessions(raw: unknown): RecentSession[] {
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined;
  if (!Array.isArray(list)) return [];
  const out: RecentSession[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const account = str(o.account);
    const sessionId = str(o.sessionId);
    const lastAt = num(o.lastAt);
    if (!account || !sessionId || lastAt === undefined) continue;
    const s: RecentSession = { account, sessionId, projectDir: str(o.projectDir) ?? '', lastAt, size: num(o.size) ?? 0, open: o.open === true };
    const project = str(o.project);
    const title = str(o.title);
    const firstAt = num(o.firstAt);
    const agentId = str(o.agentId);
    // Ausente = Claude Code (nunca grava 'claude').
    if (o.provider === 'codex') s.provider = 'codex';
    if (project) s.project = project;
    if (title) s.title = title;
    if (firstAt !== undefined) s.firstAt = firstAt;
    if (s.open && agentId) s.agentId = agentId;
    out.push(s);
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}
