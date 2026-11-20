// Eventos da extensão do Habblaud no omp (mod/habblaud-omp/habblaud.ts) para POST /api/omp/events. Módulo
// compartilhado: a extensão monta o corpo com estes tipos e o servidor (server/omp/http.ts) o valida com
// parseOmpEvent. JavaScript puro de dependências: a extensão roda no Bun do omp, fora do projeto.

export const OMP_EVENT_KINDS = [
  'session_start',
  'agent_start',
  'agent_end',
  'tool_start',
  'tool_end',
  'approval_requested',
  'approval_resolved',
  'heartbeat',
  'session_shutdown',
] as const;

export type OmpEventKind = (typeof OMP_EVENT_KINDS)[number];

/** Intervalo do batimento da extensão. */
export const OMP_HEARTBEAT_MS = 10_000;
/** Sem batimento por este tempo, a sessão que tinha extensão é dada como encerrada (crash, kill). */
export const OMP_HEARTBEAT_LOST_MS = 30_000;

export interface OmpEvent {
  event: OmpEventKind;
  /** Id da sessão do omp (uuidv7 do cabeçalho do arquivo). */
  sessionId: string;
  /** Caminho do arquivo .jsonl da sessão (ausente com --no-session). */
  sessionFile?: string;
  cwd?: string;
  /** Quando aconteceu, em ms desde 1970, no relógio de quem mandou. */
  at: number;
  toolName?: string;
  toolCallId?: string;
  /** approval_resolved: aprovado ou não. */
  approved?: boolean;
  /** session_start e heartbeat: modelos autenticados do omp (`provedor/id`), para o seletor da gaveta. */
  models?: string[];
}

const ID_MAX = 200;
const PATH_MAX = 4_096;
const MODELS_MAX = 200;

type Rec = Record<string, unknown>;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

function isKind(v: unknown): v is OmpEventKind {
  return typeof v === 'string' && (OMP_EVENT_KINDS as readonly string[]).includes(v);
}

/** Valida o corpo de POST /api/omp/events; fora do formato = undefined. */
export function parseOmpEvent(raw: unknown): OmpEvent | undefined {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Rec) : undefined;
  const sessionId = str(r?.sessionId, ID_MAX);
  if (!r || !sessionId || !isKind(r.event) || typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  const out: OmpEvent = { event: r.event, sessionId, at: r.at };
  const sessionFile = str(r.sessionFile, PATH_MAX);
  const cwd = str(r.cwd, PATH_MAX);
  const toolName = str(r.toolName, ID_MAX);
  const toolCallId = str(r.toolCallId, ID_MAX);
  if (sessionFile) out.sessionFile = sessionFile;
  if (cwd) out.cwd = cwd;
  if (toolName) out.toolName = toolName;
  if (toolCallId) out.toolCallId = toolCallId;
  if (typeof r.approved === 'boolean') out.approved = r.approved;
  if ((r.event === 'session_start' || r.event === 'heartbeat') && Array.isArray(r.models)) {
    const models = r.models.slice(0, MODELS_MAX).flatMap((m) => str(m, ID_MAX) ?? []);
    if (models.length) out.models = models;
  }
  return out;
}
