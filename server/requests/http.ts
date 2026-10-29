// Rotas de /api/requests (pedidos externos). A trava já foi conferida em http/app.ts: as rotas do serviço só pela porta
// local, com Host local e (fora do Docker) conexão pelo loopback; a da página, como a decisão das permissões. O guard
// (http/guard.ts) já exigiu JSON e Origin local nos POST. Nenhuma rota manda cabeçalhos de CORS.
//
//   POST   /api/requests                (serviço) registra: 201 {id, status, expiresAt} (200 se o par source +
//                                                 externalId já existia, com o resultado dele)
//   GET    /api/requests/:id/wait       (serviço) long-poll (?timeout= em segundos): o resultado quando sair de pending
//   GET    /api/requests/:id            (serviço) o resultado: {status: pending | decided | expired | withdrawn, option?}
//   POST   /api/requests/:id/withdraw   (serviço) retira o pedido pendente (resolvido em outro lugar)
//   POST   /api/requests/:id/decision   (página)  {option}
//
// As rotas do serviço exigem `Authorization: Bearer <HABBLAUD_PEDIDOS_TOKEN>`.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { WAIT_MAX_MS, type RequestRegistry } from './registry';
import { tr } from '../../shared/i18n';

const ITEM = /^\/api\/requests\/([^/]+)(?:\/(wait|withdraw|decision))?$/;

/** Rotas que só o serviço chama (com o token, pela porta local); a decisão é da página. */
export function isRequestServicePath(path: string): boolean {
  return path === '/api/requests' || (path.startsWith('/api/requests/') && !path.endsWith('/decision'));
}

/** O token de Authorization confere com o configurado (comparação em tempo constante). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else sendJson(res, 500, { error: tr('erro interno') });
}

/** Tempo de espera pedido em `?timeout=` (segundos), limitado a WAIT_MAX_MS. */
function waitMs(url: URL): number {
  const raw = Number(url.searchParams.get('timeout'));
  if (!Number.isFinite(raw) || raw <= 0) return WAIT_MAX_MS;
  return Math.min(WAIT_MAX_MS, Math.max(50, raw * 1_000));
}

const UNKNOWN = tr('pedido desconhecido: expirou, foi retirado ou nunca existiu');

export function createRequestRoutes(registry: RequestRegistry, token: string): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const register = async (req: IncomingMessage, res: ServerResponse) => {
    const r = registry.register(await readJson(req));
    if ('error' in r) {
      if (r.error === 'full') return sendJson(res, 429, { error: tr('pedidos pendentes demais: espere alguma escolha ou retire pedidos') });
      return sendJson(res, 400, { error: r.message });
    }
    sendJson(res, r.created ? 201 : 200, r.result);
  };

  const wait = (req: IncomingMessage, res: ServerResponse, id: string) => {
    const w = registry.wait(id, waitMs(new URL(req.url ?? '/', 'http://localhost')));
    if (!w) return sendJson(res, 404, { error: UNKNOWN });
    req.socket.setTimeout(0);
    // Conexão fechada antes da resposta (o serviço desistiu): larga a espera.
    res.on('close', () => {
      if (!res.writableEnded) w.cancel();
    });
    w.result.then(
      (result) => {
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, result);
      },
      (err) => fail(res, err),
    );
  };

  const decide = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const body = (await readJson(req)) as { option?: unknown } | null;
    if (!body || typeof body.option !== 'string') throw new HttpError(400, tr('esperado {option: id de uma das opções do pedido}'));
    switch (registry.decide(id, body.option)) {
      case 'ok':
        return sendJson(res, 200, { ok: true });
      case 'not-found':
        return sendJson(res, 404, { error: UNKNOWN });
      case 'conflict':
        return sendJson(res, 409, { error: tr('este pedido já foi respondido') });
      case 'invalid':
        return sendJson(res, 400, { error: tr('opção desconhecida para este pedido') });
    }
  };

  return (req, res, path) => {
    const method = req.method ?? 'GET';
    const m = path === '/api/requests' ? null : ITEM.exec(path);
    if (path !== '/api/requests' && !m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    if (m?.[2] !== 'decision' && !tokenMatches(req.headers.authorization, token)) {
      req.resume();
      return sendJson(res, 401, { error: tr('token ausente ou errado (Authorization: Bearer <HABBLAUD_PEDIDOS_TOKEN>)') });
    }
    if (!m) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      register(req, res).catch((err) => fail(res, err));
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    if (m[2] === 'wait') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return wait(req, res, id);
    }
    if (m[2] === 'decision') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      decide(req, res, id).catch((err) => fail(res, err));
      return;
    }
    if (m[2] === 'withdraw') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      req.resume();
      switch (registry.withdraw(id)) {
        case 'ok':
          return sendJson(res, 200, { ok: true });
        case 'not-found':
          return sendJson(res, 404, { error: UNKNOWN });
        case 'conflict':
          return sendJson(res, 409, { error: tr('este pedido já foi respondido') });
      }
    }
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    const r = registry.result(id);
    if (r) sendJson(res, 200, r);
    else sendJson(res, 404, { error: UNKNOWN });
  };
}
