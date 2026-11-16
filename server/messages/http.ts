// Rotas das mensagens pelo escritório. A trava (recurso ligado + Host local) já foi conferida em http/app.ts; o
// guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   POST /api/messages          (página)  {agentId, text, images?: id[]}: 201 OutboxMessage (queued) | 400 | 404 | 409 | 429
//                                         (com imagens, o texto pode vir vazio: elas são gravadas e os caminhos vão no fim)
//   POST /api/messages/images   (página)  {name, type, data (base64)}: 201 {id} | 400 | 404 (imagens desligadas)
//   GET  /api/messages/:id      (página)  situação da mensagem: 200 OutboxMessage | 404
//   POST /api/mod/inbox         (plugin)  {session, account?}: 200 {messages: InboxMessage[]} (e marca a presença)
//   POST /api/mod/inbox/ack     (plugin)  {session, results: [{id, ok, error?}]}: 200 {ok: true}
//   POST /api/codex/bridge/poll (auxiliar do Codex no host, npm run codex:bridge)
//                                         {}: 200 {messages: [{id, account, codexHome, thread, text}]} (marca a presença)
//   POST /api/codex/bridge/ack  (auxiliar) {results: [{id, ok, error?}]}: 200 {ok: true}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';
import type { MessageImages } from './images';
import { messageWithImages } from '../../shared/messages';
import { ATTACHMENT_BODY_MAX } from '../spawn/attachments';
import { tr } from '../../shared/i18n';

const ITEM = /^\/api\/messages\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: tr('erro interno') });
}

export function createMessageRoutes(registry: MessageRegistry, images?: MessageImages): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const upload = async (req: IncomingMessage, res: ServerResponse) => {
    if (!images) {
      req.resume();
      return sendJson(res, 404, { error: tr('imagens nas mensagens desligadas') });
    }
    const r = images.put(await readJson(req, ATTACHMENT_BODY_MAX));
    if ('error' in r) return sendJson(res, 400, { error: r.error });
    sendJson(res, 201, r);
  };

  const send = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson(req);
    const ids = body && typeof body === 'object' ? (body as { images?: unknown }).images : undefined;
    let raw = body;
    let count = 0;
    let folder: string | undefined;
    if (ids !== undefined && !(Array.isArray(ids) && ids.length === 0)) {
      // com imagens: grava agora e o texto leva os caminhos (pode vir vazio)
      if (!images) return sendJson(res, 400, { error: tr('imagens nas mensagens desligadas') });
      const files = images.take(ids);
      if ('error' in files) return sendJson(res, 400, { error: files.error });
      const text = typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text : '';
      let written: { paths: string[]; folder?: string };
      try {
        written = images.write(files);
      } catch {
        return sendJson(res, 500, { error: tr('não deu para gravar as imagens no computador') });
      }
      folder = written.folder;
      count = written.paths.length;
      raw = { ...(body as object), text: messageWithImages(text, written.paths) };
    }
    let r: ReturnType<MessageRegistry['send']>;
    try {
      r = registry.send(raw, { images: count });
    } catch (err) {
      images?.discard(folder);
      throw err;
    }
    if (!('message' in r)) images?.discard(folder);
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'not-found':
        return sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: tr('já há {0} mensagens esperando a entrega para este agente: espere a sessão buscar', [MAX_OPEN]) });
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
    if (path === '/api/messages/images') return post(req, res, upload);
    if (path === '/api/mod/inbox') return post(req, res, inbox);
    if (path === '/api/mod/inbox/ack') return post(req, res, ack);
    if (path === '/api/codex/bridge/poll') return post(req, res, codexPoll);
    if (path === '/api/codex/bridge/ack') return post(req, res, codexAck);
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: tr('mensagem desconhecida: ela já foi resolvida há mais de 10 min ou o Habblaud reiniciou') });
  };
}
