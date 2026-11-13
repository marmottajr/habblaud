// Eventos dos hooks do Gemini CLI (mod/habblaud-gemini/hook.mjs, que npm run gemini:install acrescenta em
// ~/.gemini/settings.json): SessionStart, BeforeAgent, BeforeTool, AfterTool, Notification, PreCompress, AfterAgent e
// SessionEnd chegam aqui e vão para a fonte do Gemini (GeminiLive). Os eventos só observam (a resposta nunca volta
// para a sessão) e só valem vindos do próprio computador: a trava é conferida em http/app.ts, como a do Codex.
//
//   POST /api/gemini/events   (hook)   {account?, geminiHome?, event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { GeminiLive } from '../sources/gemini/source';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Corpo de POST /api/gemini/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseGeminiEvent(raw: unknown): { account?: string; event: Rec } {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'esperado {account?, geminiHome?, event: <JSON do hook do Gemini>}');
  const account = typeof r.account === 'string' && r.account.length <= 200 ? r.account : undefined;
  return account ? { account, event } : { event };
}

/** Trata POST /api/gemini/events (método e Host já conferidos). `ok` = a fonte do Gemini aproveitou o evento. */
export async function handleGeminiEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: GeminiLive }): Promise<void> {
  const body = parseGeminiEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(body.account, body.event) === true;
    } catch (err) {
      log.warnOnce(`gemini-event:${errMsg(err)}`, tr('Eventos do Gemini: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
