// Uso do plano das contas do omp: leitura da saída de `omp usage --json` (ver bin.ts, que roda o comando). Quem consulta
// os provedores (Anthropic, OpenAI, Google…) é o próprio omp, com as credenciais e o cache dele; o Habblaud não lê
// credenciais e só interpreta o JSON. Nunca usa `omp usage invalidate` nem `--force-refresh` (o cache do omp manda).
// Puro: testado em usage.test.ts com a saída real (fixtures/usage.json, já com --redact).
import type { AccountUsage, OmpProviderUsage, OmpUsageLimit, UsageWindow } from '../../../shared/types';
import { toEpochMs } from '../../accounts/usage';

export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;

interface OmpLimit {
  label?: unknown;
  scope?: { shared?: unknown; tier?: unknown };
  window?: { durationMs?: unknown; resetsAt?: unknown };
  amount?: { usedFraction?: unknown };
  status?: unknown;
}

interface OmpReport {
  provider?: unknown;
  fetchedAt?: unknown;
  limits?: unknown;
  notes?: unknown;
  metadata?: { planType?: unknown };
}

/** Percentual 0–100 com uma casa, de uma fração do omp; undefined = sem número. */
function percent(fraction: unknown): number | undefined {
  return typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(100, Math.max(0, Math.round(fraction * 1000) / 10)) : undefined;
}

function reportsOf(raw: string): OmpReport[] | undefined {
  try {
    const reports = (JSON.parse(raw) as { reports?: unknown } | null)?.reports;
    return Array.isArray(reports) ? reports : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Janelas de 5 h e 7 d do provedor `provider` no JSON de `omp usage --json`. Undefined = JSON inválido ou sem report
 * desse provedor. Report sem essas janelas (Ollama, Codex grátis de 30 d) -> AccountUsage sem janelas, com `note`.
 * Só entram limites compartilhados da conta (`scope.shared`, sem `tier`); de cada janela vale o primeiro. `metadata`
 * (e-mails, ids) nunca é copiado.
 */
export function parseOmpUsage(raw: string, provider: string, now: number): AccountUsage | undefined {
  const reports = reportsOf(raw);
  if (!reports) return undefined;
  const report = reports.find((r: OmpReport | null) => r?.provider === provider);
  if (!report) return undefined;

  const fetchedAt = Math.min(now, toEpochMs(report.fetchedAt) ?? now);
  const usage: AccountUsage = { source: 'omp', ompProvider: provider, fetchedAt };
  const limits = Array.isArray(report.limits) ? (report.limits as (OmpLimit | null)[]) : [];
  let noQuota = false;
  for (const l of limits) {
    if (l?.scope?.shared !== true || l.scope.tier !== undefined) continue;
    const d = l.window?.durationMs;
    const key = d === FIVE_HOURS_MS ? 'fiveHour' : d === SEVEN_DAYS_MS ? 'sevenDay' : undefined;
    if (!key || usage[key]) continue;
    const utilization = percent(l.amount?.usedFraction);
    if (utilization === undefined) continue;
    if (l.status !== 'ok' && (l.amount?.usedFraction as number) >= 1) noQuota = true;
    const w: UsageWindow = { utilization };
    const resetsAt = toEpochMs(l.window?.resetsAt);
    if (resetsAt !== undefined) w.resetsAt = resetsAt;
    usage[key] = w;
  }
  if (noQuota) {
    // Igual ao Codex: "sem cota" não é 0% nem 100%; as janelas ficam de fora.
    delete usage.fiveHour;
    delete usage.sevenDay;
    usage.noQuota = true;
  } else if (!usage.fiveHour && !usage.sevenDay) {
    const note = Array.isArray(report.notes) ? String(report.notes[0] ?? '') : '';
    if (note) usage.note = note;
  }
  return usage;
}

/**
 * Todos os provedores (cada credencial) do `omp usage --json`, com todos os limites: os compartilhados e os de um
 * modelo ou grupo (Gemini, "Claude & GPT", Fable…). Limites iguais (mesmo rótulo, janela e números: o Google repete
 * um por modelo do grupo) entram uma vez. Do `metadata` só o plano; e-mails e ids nunca são copiados.
 */
export function parseOmpProviders(raw: string, now: number): OmpProviderUsage[] | undefined {
  const reports = reportsOf(raw);
  if (!reports) return undefined;
  const out: OmpProviderUsage[] = [];
  for (const report of reports) {
    if (!report || typeof report.provider !== 'string' || !report.provider) continue;
    const limits: OmpUsageLimit[] = [];
    const seen = new Set<string>();
    for (const l of Array.isArray(report.limits) ? (report.limits as (OmpLimit | null)[]) : []) {
      if (!l || typeof l.label !== 'string' || !l.label) continue;
      const limit: OmpUsageLimit = { label: l.label };
      const windowMs = l.window?.durationMs;
      if (typeof windowMs === 'number' && windowMs > 0) limit.windowMs = windowMs;
      const utilization = percent(l.amount?.usedFraction);
      if (utilization !== undefined) limit.utilization = utilization;
      const resetsAt = toEpochMs(l.window?.resetsAt);
      if (resetsAt !== undefined) limit.resetsAt = resetsAt;
      if (l.status !== 'ok' && (l.amount?.usedFraction as number) >= 1) limit.exhausted = true;
      const key = JSON.stringify(limit);
      if (seen.has(key)) continue;
      seen.add(key);
      limits.push(limit);
    }
    const entry: OmpProviderUsage = { provider: report.provider, limits, fetchedAt: Math.min(now, toEpochMs(report.fetchedAt) ?? now) };
    const plan = report.metadata?.planType;
    if (typeof plan === 'string' && plan.trim()) entry.plan = plan.trim();
    const note = Array.isArray(report.notes) ? String(report.notes[0] ?? '') : '';
    if (!limits.length && note) entry.note = note;
    out.push(entry);
  }
  return out;
}

/** `anthropic/claude-opus-5-5` -> `anthropic`; sem barra ou vazio -> undefined. */
export function ompProviderOf(model: string | undefined): string | undefined {
  const i = model?.indexOf('/') ?? -1;
  return i > 0 ? model!.slice(0, i) : undefined;
}
