// Rotas do bate-papo paralelo. A trava (recurso ligado + Host local ou a feature liberada) já foi conferida em
// http/app.ts; o guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   GET    /api/asides?agentId=<id>              (página) 200 {topics: AsideTopic[]} (sessão atual, mais nova primeiro) | 400 | 404
//   POST   /api/asides {agentId, question, topicId?}
//                                                (página) 201 {topic: AsideTopic} | 400 | 404 | 409 {error} | 429
//   POST   /api/asides/<topicId>/cancel {agentId}
//                                                (página) 200 {ok: true} | 400 | 404 | 409
//   DELETE /api/asides/<topicId>?agentId=<id>    (página) 200 {ok: true} | 400 | 404 | 409 (pergunta em andamento)
//   POST   /api/mod/aside <AsideProgress>        (plugin da sessão) 200 {cancel: boolean} | 400
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN } from '../messages/registry';
import type { AsideStore } from './store';

const ITEM = /^\/api\/asides\/([^/]+)(\/cancel)?$/;
// Uma resposta de 64 KiB com muitas aspas e quebras de linha passa de 256 KiB depois de escapada.
const PROGRESS_BODY_MAX = 1024 * 1024;

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

const unknownAgent = (res: ServerResponse) => sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
const unknownTopic = (res: ServerResponse) => sendJson(res, 404, { error: tr('conversa desconhecida') });

/** Rotas da página: `(req, res, path, url)`. */
export function createAsideRoutes(store: AsideStore): (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => void {
  const ask = async (req: IncomingMessage, res: ServerResponse) => {
    const r = store.ask(await readJson(req));
    if ('topic' in r) return sendJson(res, 201, { topic: r.topic });
    switch (r.error) {
      case 'not-found':
        return unknownAgent(res);
      case 'too-many':
        return sendJson(res, 429, { error: tr('já há {0} mensagens esperando a entrega para este agente: espere a sessão buscar', [MAX_OPEN]) });
      default:
        return sendJson(res, 409, { error: r.reason });
    }
  };

  const cancel = async (req: IncomingMessage, res: ServerResponse, topicId: string) => {
    const r = store.cancel(topicId, await readJson(req));
    if ('ok' in r) return sendJson(res, 200, { ok: true });
    if (r.error === 'idle') return sendJson(res, 409, { error: tr('nenhuma pergunta em andamento nesta conversa') });
    unknownTopic(res);
  };

  return (req, res, path, url) => {
    const method = req.method ?? 'GET';
    if (path === '/api/asides') {
      if (method === 'GET' || method === 'HEAD') {
        const agentId = url.searchParams.get('agentId');
        if (!agentId) return sendJson(res, 400, { error: tr('esperado ?agentId=') });
        const list = store.list(agentId);
        return list ? sendJson(res, 200, list) : unknownAgent(res);
      }
      if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      ask(req, res).catch((err) => fail(res, err));
      return;
    }
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    let topicId: string;
    try {
      topicId = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    if (m[2]) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      cancel(req, res, topicId).catch((err) => fail(res, err));
      return;
    }
    if (method !== 'DELETE') return methodNotAllowed(res, 'DELETE');
    const agentId = url.searchParams.get('agentId');
    if (!agentId) return sendJson(res, 400, { error: tr('esperado ?agentId=') });
    const r = store.remove(topicId, agentId);
    if ('ok' in r) return sendJson(res, 200, { ok: true });
    if (r.error === 'busy') return sendJson(res, 409, { error: tr('a conversa tem uma pergunta em andamento: pare antes de apagar') });
    unknownTopic(res);
  };
}

/** POST /api/mod/aside: a notícia do plugin da sessão (a resposta, ou o sinal de vida enquanto ela não sai); responde se ele deve descartar o resultado. */
export async function handleAsideProgress(req: IncomingMessage, res: ServerResponse, store: AsideStore): Promise<void> {
  try {
    sendJson(res, 200, store.progress(await readJson(req, PROGRESS_BODY_MAX)));
  } catch (err) {
    fail(res, err);
  }
}
