// Eventos dos hooks do Antigravity CLI (mod/habblaud-antigravity/hook.mjs, instalado em ~/.gemini/config/hooks.json por
// npm run antigravity:install): SessionStart, PreInvocation, PostInvocation, PreToolUse, PostToolUse e Stop chegam aqui
// com a conta e vão para a fonte do Antigravity (AntigravityLive), que atualiza o agente na hora.
//
//   POST /api/antigravity/events   (hook)   {account?, antigravityHome?, event: <stdin do hook>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { tr } from '../../shared/i18n';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { AntigravityLive } from '../sources/antigravity/live';

type Rec = Record<string, unknown>;

export interface AntigravityHookEvent {
  account?: string;
  antigravityHome?: string;
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

export function parseAntigravityEvent(raw: unknown): AntigravityHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  const name = event?.hookEventName ?? event?.hook_event_name;
  if (!r || !event || typeof name !== 'string') {
    throw new HttpError(400, 'esperado {account?, antigravityHome?, event: <JSON do hook do Antigravity>}');
  }
  const out: AntigravityHookEvent = { event };
  const account = shortStr(r.account, 200);
  const antigravityHome = shortStr(r.antigravityHome, 4_096);
  if (account) out.account = account;
  if (antigravityHome) out.antigravityHome = antigravityHome;
  return out;
}

export function antigravityAccountOf(entries: readonly AccountEntry[], account: string | undefined, antigravityHome: string | undefined): string | undefined {
  if (antigravityHome && isAbsolute(antigravityHome)) {
    const abs = resolve(antigravityHome);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

export async function handleAntigravityEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: AntigravityLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseAntigravityEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(antigravityAccountOf(deps.entries(), body.account, body.antigravityHome), body.event) === true;
    } catch (err) {
      log.warnOnce(`agy-event:${errMsg(err)}`, tr('Eventos do Antigravity: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
