// Rotas /api/push/*. Nenhuma lê `req.headers.host`: a trava da porta chega pronta em `allowed`, calculada por
// http/app.ts com a mesma regra das outras rotas (Host local na porta local; na remota, o login que o gate conferiu).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { pushReason } from './sender';
import type { PushService } from './service';

/** Corpo de uma inscrição é pequeno: endpoint, duas chaves e um rótulo. */
const BODY_MAX = 4 * 1024;

interface Body {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  label?: unknown;
  types?: unknown;
}

/**
 * O endpoint do corpo, validado. Duas condições, e as duas são de segurança:
 *
 * - forma de URL conferida com `new URL`, dentro de um `try`. A expressão regular que aqui estava aceitava
 *   `https://[`, que ficava gravado no ficheiro e derrubava o processo no primeiro envio, a cada reinício
 *  ;
 * - anfitrião na lista dos serviços de push conhecidos, senão a inscrição é um canal de saída e uma sonda da rede
 *   interna.
 */
function endpointOf(body: Body, push: PushService): string {
  const e = body.endpoint;
  if (typeof e !== 'string' || !push.accepts(e)) throw new HttpError(400, tr('esperado {endpoint: https://… de um serviço de push conhecido}'));
  return e;
}

function keysOf(body: Body): { p256dh: string; auth: string } {
  const k = body.keys;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') throw new HttpError(400, tr('esperado {keys: {p256dh, auth}}'));
  return { p256dh: k.p256dh, auth: k.auth };
}

function typesOf(body: Body): Record<string, boolean> | undefined {
  if (!body.types || typeof body.types !== 'object') return undefined;
  const out: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(body.types as Record<string, unknown>)) if (typeof on === 'boolean') out[id] = on;
  return out;
}

/**
 * Trata /api/push/*; devolve true quando respondeu. Rota desconhecida dentro do prefixo também responde (404), para
 * nenhuma chamada de push cair no 404 genérico da API por outro caminho.
 */
export function createPushRoutes(push: PushService): (req: IncomingMessage, res: ServerResponse, url: URL, allowed: boolean) => boolean {
  return (req, res, url, allowed) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (!allowed) {
      req.resume();
      sendJson(res, 403, { error: tr('notificações push só pela própria página do Habblaud') });
      return true;
    }
    const fail = (err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: tr('erro interno') });
    };

    if (path === '/api/push/status') {
      req.resume();
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET');
        sendJson(res, 405, { error: tr('método não permitido') });
      } else sendJson(res, 200, { ...push.status(), testReadyIn: Math.ceil(push.testReadyIn() / 1000) });
      return true;
    }

    if (path === '/api/push/state' || path === '/api/push/subscribe' || path === '/api/push/unsubscribe' || path === '/api/push/prefs' || path === '/api/push/test') {
      if (method !== 'POST') {
        req.resume();
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: tr('método não permitido') });
        return true;
      }
      void (async () => {
        try {
          const body = ((await readJson(req, BODY_MAX)) ?? {}) as Body;
          const endpoint = endpointOf(body, push);
          /**
           * Estado DESTE aparelho: os tipos como estão guardados para ele, e não os valores de omissão do registo.
           * É POST porque o endpoint não entra na barra de endereços (ia para registos de acesso), e é leitura, logo
           * não gasta o teto das escritas. Sem isto a página desenhava os interruptores com os valores de omissão e
           * o primeiro toque num tipo desligado voltava a mandar «desligado».
           */
          if (path === '/api/push/state') return sendJson(res, 200, push.status(endpoint));
          // Teto de ritmo das escritas, no molde do /test. O /test tem o seu, mais apertado.
          if (path !== '/api/push/test') {
            const wait = push.takeWrite();
            if (wait > 0) {
              res.setHeader('Retry-After', String(wait));
              throw new HttpError(429, tr('demasiados pedidos de inscrição: espere {0} s', [wait]));
            }
          }
          if (path === '/api/push/subscribe') {
            // Teto de aparelhos: sem ele o ficheiro cresce sem fim e cada aviso passa a ser N chamadas de rede.
            if (push.isFull(endpoint)) throw new HttpError(409, tr('já há aparelhos inscritos que cheguem: desligue um antes de ligar outro'));
            const label = typeof body.label === 'string' ? body.label : undefined;
            push.subscribe({ endpoint, keys: keysOf(body), label });
            return sendJson(res, 200, push.status(endpoint));
          }
          if (path === '/api/push/unsubscribe') {
            return sendJson(res, 200, { ok: push.unsubscribe(endpoint) });
          }
          if (path === '/api/push/prefs') {
            const types = typesOf(body);
            if (!types) throw new HttpError(400, tr('esperado {types: {id: booleano}}'));
            if (!push.setTypes(endpoint, types)) throw new HttpError(404, tr('este aparelho não está inscrito'));
            return sendJson(res, 200, push.status(endpoint));
          }
          // /api/push/test: molde fixo, sem nada de dentro do escritório.
          const wait = Math.ceil(push.testReadyIn() / 1000);
          if (wait > 0) {
            res.setHeader('Retry-After', String(wait));
            throw new HttpError(429, tr('espere {0} s antes de outro teste', [wait]));
          }
          const r = await push.test(endpoint, { title: 'Habblaud', body: tr('Teste de notificação.') });
          if (r.status === 404) throw new HttpError(404, tr('este aparelho não está inscrito'));
          // `r.error` traz até 300 octetos do corpo da resposta do servidor de push, que é texto de terceiros: o
          // mesmo crivo do log (`pushReason`, lista branca) vale aqui, porque o destino é uma tela nossa. O corpo
          // completo fica no log do servidor, onde serve para depurar.
          sendJson(res, r.sent ? 200 : 502, r.sent ? { ok: true } : { ok: false, status: r.status, error: pushReason(r.error) });
        } catch (err) {
          fail(err);
        }
      })();
      return true;
    }

    req.resume();
    sendJson(res, 404, { error: tr('rota desconhecida') });
    return true;
  };
}
