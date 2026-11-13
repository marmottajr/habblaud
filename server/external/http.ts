// Eventos de agentes externos (ferramentas sem suporte próprio, ex.: Grok): um script, hook ou wrapper manda o que a
// sessão está fazendo e a fonte dos agentes externos (sources/external/source.ts) leva ao escritório. Como os eventos
// do Codex, só valem vindos do próprio computador (a trava é conferida em http/app.ts); o guard (http/guard.ts) já
// exigiu JSON. scripts/agent-event.mjs manda estes eventos pela linha de comando.
//
//   POST /api/external/events  {tool, toolLabel?, session, event, cwd?, title?, model?, text?, kind?, detail?,
//                               toolName?, input?}: 200 {ok: true} | 400 {error} | 404 {error} (fonte desligada)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { ActivityKind } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { EXTERNAL_EVENTS, KIND_ICONS, type ExternalEvent, type ExternalEventName, type ExternalLive } from '../sources/external/source';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

/** Slug da ferramenta: vira o id da conta. */
const TOOL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Ferramentas que têm fonte própria: os eventos delas vêm dos hooks e dos arquivos, não daqui. */
const RESERVED_TOOLS = new Set(['claude', 'codex']);

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Texto opcional: aparado, vazio = ausente; mais longo que `max` = 400. */
function optStr(r: Rec, key: string, max: number): string | undefined {
  const v = r[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, tr('{0} precisa ser texto', [key]));
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, tr('{0} passa de {1} caracteres', [key, max]));
  return s || undefined;
}

/** Valida o corpo de POST /api/external/events. */
export function parseExternalEvent(raw: unknown): ExternalEvent {
  const r = rec(raw);
  if (!r) throw new HttpError(400, tr('esperado um objeto JSON com tool, session e event'));
  const tool = optStr(r, 'tool', 32)?.toLowerCase();
  if (!tool || !TOOL_RE.test(tool)) throw new HttpError(400, tr('tool precisa ser um nome curto com letras minúsculas, números e hífen (ex.: grok)'));
  if (RESERVED_TOOLS.has(tool)) throw new HttpError(400, tr('{0} já tem suporte próprio no Habblaud: use o mod ou os hooks dele', [tool]));
  const session = optStr(r, 'session', 200);
  if (!session) throw new HttpError(400, tr('session é obrigatório (um id estável da sessão)'));
  const event = optStr(r, 'event', 20) as ExternalEventName | undefined;
  if (!event || !(EXTERNAL_EVENTS as readonly string[]).includes(event)) throw new HttpError(400, tr('event precisa ser um destes: {0}', [EXTERNAL_EVENTS.join(', ')]));
  const out: ExternalEvent = { tool, session, event };
  const toolLabel = optStr(r, 'toolLabel', 40);
  if (toolLabel) out.toolLabel = toolLabel;
  const cwd = optStr(r, 'cwd', 4_096);
  if (cwd) {
    if (!isAbsolute(cwd) && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new HttpError(400, tr('cwd precisa ser um caminho absoluto'));
    out.cwd = cwd;
  }
  const title = optStr(r, 'title', 500);
  if (title) out.title = title;
  const model = optStr(r, 'model', 100);
  if (model) out.model = model;
  const text = optStr(r, 'text', 4_000);
  if (text) out.text = text;
  const detail = optStr(r, 'detail', 4_000);
  if (detail) out.detail = detail;
  const kind = optStr(r, 'kind', 20);
  if (kind) {
    if (!(kind in KIND_ICONS)) throw new HttpError(400, tr('kind desconhecido: {0}', [kind]));
    out.kind = kind as ActivityKind;
  }
  const toolName = optStr(r, 'toolName', 100);
  if (toolName) {
    out.toolName = toolName;
    if (r.input !== undefined) out.input = r.input;
  }
  return out;
}

/** Trata POST /api/external/events (método e trava já conferidos). */
export async function handleExternalEvent(req: IncomingMessage, res: ServerResponse, live: ExternalLive | undefined): Promise<void> {
  const ev = parseExternalEvent(await readJson(req));
  if (!live) {
    sendJson(res, 404, { error: tr('agentes externos desligados (HABBLAUD_EXTERNAL=0)') });
    return;
  }
  let result;
  try {
    result = live.applyEvent(ev);
  } catch (err) {
    log.warnOnce(`external-event:${errMsg(err)}`, tr('Agentes externos: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    throw err;
  }
  if (result.ok) sendJson(res, 200, { ok: true });
  else sendJson(res, 400, { error: result.error });
}
