// Eventos do hook do Kiro (mod/habblaud-kiro/hook.mjs, registrado por npm run kiro:install): AgentSpawn,
// UserPromptSubmit, PreToolUse, PostToolUse e Stop chegam aqui e vão para a fonte do Kiro (KiroLive), que atualiza o
// agente na hora, sem esperar o transcript. Só observam (a resposta nunca volta para a sessão), mas só valem vindos do
// próprio computador: a trava (Host local e, fora do Docker, conexão pelo loopback) é conferida em http/app.ts. O guard
// (http/guard.ts) já exigiu JSON.
//
//   POST /api/kiro/events   (hook)   {kiroHome?, pids?, platform?, event: {hook_event_name, session_id, ...}}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { kiroHookName, type KiroHookEvent, type KiroHookPayload, type KiroLive } from '../sources/kiro/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

/** Corpo de POST /api/kiro/events. Sem evento conhecido ou sem session_id: 400. */
export function parseKiroEvent(raw: unknown): KiroHookEvent {
  const r = rec(raw);
  const e = rec(r?.event);
  const name = kiroHookName(e?.hook_event_name);
  const sid = str(e?.session_id, 200)?.trim();
  if (!r || !e || !name || !sid || !/^[\w.:-]+$/.test(sid)) {
    throw new HttpError(400, 'esperado {kiroHome?, pids?, event: {hook_event_name, session_id, ...}} (JSON do hook do Kiro)');
  }
  const event: KiroHookPayload = { hook_event_name: name, session_id: sid };
  const cwd = str(e.cwd, 4_096);
  const prompt = str(e.prompt, 64_000);
  const tool = str(e.tool_name, 200);
  const answer = str(e.assistant_response, 64_000);
  if (cwd) event.cwd = cwd;
  if (prompt !== undefined) event.prompt = prompt;
  if (tool) event.tool_name = tool;
  if (e.tool_input !== undefined) event.tool_input = e.tool_input;
  if (e.tool_response !== undefined) event.tool_response = e.tool_response;
  if (answer !== undefined) event.assistant_response = answer;
  const pids = Array.isArray(r.pids) ? r.pids.filter((p): p is number => Number.isInteger(p) && p > 1).slice(0, 16) : [];
  const out: KiroHookEvent = { pids, event };
  const home = str(r.kiroHome, 4_096);
  const platform = str(r.platform, 40);
  if (home) out.kiroHome = home;
  if (platform) out.platform = platform;
  return out;
}

/** O que a rota usa do registro de pedidos de permissão (PermissionRegistry.kiroHookEvent). */
export interface KiroPermissionsLike {
  kiroHookEvent(ev: KiroHookPayload): number;
}

/**
 * Trata POST /api/kiro/events (método e Host já conferidos). `ok` = a fonte do Kiro aproveitou o evento. PostToolUse e
 * Stop também soltam o cartão de aprovação do escritório que ficou para trás (a ferramenta já rodou ou a vez acabou).
 */
export async function handleKiroEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: KiroLive; permissions?: KiroPermissionsLike }): Promise<void> {
  const body = parseKiroEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(body) === true;
    } catch (err) {
      log.warnOnce(`kiro-event:${errMsg(err)}`, tr('Eventos do Kiro: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  try {
    deps.permissions?.kiroHookEvent(body.event);
  } catch (err) {
    log.warnOnce(`kiro-event-perm:${errMsg(err)}`, tr('Eventos do Kiro: falha ao soltar um pedido de permissão ({0}).', [errMsg(err)]));
  }
  sendJson(res, 200, { ok });
}
