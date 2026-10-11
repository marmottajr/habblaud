// Rotas das mensagens pelo escritório. A trava (recurso ligado + Host local) já foi conferida em http/app.ts; o
// guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   POST /api/messages          (página)  {agentId, text}: 201 OutboxMessage (queued) | 400 | 404 | 409 | 429
//   GET  /api/messages/:id      (página)  situação da mensagem: 200 OutboxMessage | 404
//   POST /api/mod/inbox         (plugin)  {session, account?}: 200 {messages: InboxMessage[]} (e marca a presença)
//   POST /api/mod/inbox/ack     (plugin)  {session, results: [{id, ok, error?}]}: 200 {ok: true}
//   POST /api/codex/bridge/poll (auxiliar do Codex no host, npm run codex:bridge)
//                                         {}: 200 {messages: [{id, account, codexHome, thread, text}]} (marca a presença)
//   POST /api/codex/bridge/ack  (auxiliar) {results: [{id, ok, error?}]}: 200 {ok: true}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';

const ITEM = /^\/api\/messages\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'método não permitido' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: 'erro interno' });
}

export interface MessageRouteOptions {
  /**
   * Confere a chave do escritório na mensagem mandada pela página (server/equipe/pedidos.ts), como
   * na decisão de permissão. 'errada' = recusa com 401; 'desligado' (não há chave criada) = vale como antes, sem chave.
   * As rotas do plugin e do auxiliar do Codex (caixa de entrada e confirmação) não levam chave: só buscam e confirmam.
   */
  conferirChave?: (enviada: string | undefined) => 'ok' | 'desligado' | 'errada';
}

export function createMessageRoutes(registry: MessageRegistry, opts: MessageRouteOptions = {}): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const send = async (req: IncomingMessage, res: ServerResponse) => {
    // Mandar mensagem pelo escritório digita na sessão em seu nome: com a chave criada, só quem a tem manda.
    const chave = req.headers['x-equipe-chave'];
    if (opts.conferirChave?.(typeof chave === 'string' ? chave : undefined) === 'errada') {
      req.resume();
      return sendJson(res, 401, { error: 'chave do escritório ausente ou errada' });
    }
    const r = registry.send(await readJson(req));
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'not-found':
        return sendJson(res, 404, { error: 'agente desconhecido: ele já saiu do escritório?' });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: `já há ${MAX_OPEN} mensagens esperando a entrega para este agente: espere a sessão buscar` });
    }
  };

  const inbox = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.inbox(await readJson(req)) });
  };

  const ack = async (req: IncomingMessage, res: ServerResponse) => {
    registry.ack(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const codexPoll = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.codexPoll(await readJson(req)) });
  };

  const codexAck = async (req: IncomingMessage, res: ServerResponse) => {
    registry.codexAck(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const post = (req: IncomingMessage, res: ServerResponse, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    handler(req, res).catch((err) => fail(res, err));
  };

  return (req, res, path) => {
    if (path === '/api/messages') return post(req, res, send);
    if (path === '/api/mod/inbox') return post(req, res, inbox);
    if (path === '/api/mod/inbox/ack') return post(req, res, ack);
    if (path === '/api/codex/bridge/poll') return post(req, res, codexPoll);
    if (path === '/api/codex/bridge/ack') return post(req, res, codexAck);
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: 'rota desconhecida' });
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: 'id inválido' });
    }
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: 'mensagem desconhecida: ela já foi resolvida há mais de 10 min ou o Habblaud reiniciou' });
  };
}
