// Eventos ao vivo da extensão do Pi (mod/habblaud-pi/habblaud.ts):
//   POST /api/pi/events   {account?, piDir?, event: {type, sessionId, ...}}: 200 {ok}
// Mesma trava local de POST /api/codex/events (Host local + loopback fora do Docker).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { PiLive } from '../sources/pi/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

export interface PiHookEvent {
  account?: string;
  piDir?: string;
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Corpo de POST /api/pi/events. Sem `event` (objeto com type e sessionId): 400. */
export function parsePiEvent(raw: unknown): PiHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.type !== 'string' || typeof event.sessionId !== 'string') {
    throw new HttpError(400, 'esperado {account?, piDir?, event: {type, sessionId, ...}}');
  }
  const out: PiHookEvent = { event };
  const account = shortStr(r.account, 200);
  const piDir = shortStr(r.piDir, 4_096);
  if (account) out.account = account;
  if (piDir) out.piDir = piDir;
  return out;
}

/** Conta do Pi a partir do `piDir` informado (ou do `account`). */
export function piAccountOf(entries: readonly AccountEntry[], account: string | undefined, piDir: string | undefined): string | undefined {
  if (piDir && isAbsolute(piDir)) {
    const abs = resolve(piDir);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

/** Trata POST /api/pi/events (método e Host já conferidos). */
export async function handlePiEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: PiLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parsePiEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      const payload = body.piDir && body.event.piDir === undefined ? { ...body.event, piDir: body.piDir } : body.event;
      ok = deps.live.applyLiveEvent(piAccountOf(deps.entries(), body.account, body.piDir), payload) === true;
    } catch (err) {
      log.warnOnce(`pi-event:${errMsg(err)}`, tr('Eventos do Pi: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
