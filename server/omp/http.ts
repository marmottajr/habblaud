// Eventos da extensão do Habblaud no omp (mod/habblaud-omp/habblaud.ts): session_start, agent_start/agent_end,
// tool_start/tool_end, approval_requested/approval_resolved, heartbeat e session_shutdown chegam aqui e vão para a fonte
// do omp (OmpLive), que atualiza o agente na hora, sem esperar a conversa chegar ao arquivo. Os eventos só observam (a
// resposta nunca volta para a sessão), mas só valem vindos do próprio computador: a trava (Host local e, fora do Docker,
// conexão pelo loopback) é conferida em http/app.ts, a mesma de /api/codex/events. O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/omp/events   (extensão)   <OmpEvent, ver shared/omp-events.ts>: 200 {ok}; corpo fora do formato: 400
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { OmpLive } from '../sources/omp/live';
import { parseOmpEvent } from '../../shared/omp-events';
import { tr } from '../../shared/i18n';

/** Trata POST /api/omp/events (método e Host já conferidos). `ok` = a fonte do omp aproveitou o evento. */
export async function handleOmpEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: OmpLive }): Promise<void> {
  const event = parseOmpEvent(await readJson(req));
  if (!event) throw new HttpError(400, tr('esperado um evento da extensão do omp ({event, sessionId, at, ...})'));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyEvent(event) === true;
    } catch (err) {
      log.warnOnce(`omp-event:${errMsg(err)}`, tr('Eventos do omp: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
