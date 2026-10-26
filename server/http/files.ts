// Rotas do navegador de arquivos (/api/files*): só leitura, pelas raízes de server/files/browse.ts.
//   GET /api/files                         -> {roots}
//   GET /api/files/list?path=<absoluto>    -> FileListing
//   GET /api/files/raw?path=<absoluto>     -> o arquivo para ver (só tipos de fileType) ou, com &download=1, qualquer um
// A trava (terminal) e o método (GET/HEAD) já foram conferidos em app.ts. Todo caminho passa por locate().
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { pipeline } from 'node:stream';
import { tr } from '../../shared/i18n';
import { DELIVERY_FILE_MAX_BYTES, fileType } from '../deliveries/files';
import { listDir, locate, resolveRoots } from '../files/browse';
import { sendJson, viewHeaders } from './app';

export interface BrowseDeps {
  /** Candidatos a raiz agora (salas reais + ~/projetos); browse.ts filtra. */
  roots: () => readonly { path: string; label: string; roomId?: string }[];
}

/** Trata /api/files* (a trava e o método já foram conferidos em app.ts). */
export function handleFilesRoute(req: IncomingMessage, res: ServerResponse, url: URL, deps: BrowseDeps): void {
  const roots = resolveRoots(deps.roots());
  const path = url.pathname;
  if (path === '/api/files') {
    sendJson(res, 200, { roots });
    return;
  }
  if (path !== '/api/files/list' && path !== '/api/files/raw') {
    sendJson(res, 404, { error: tr('rota desconhecida') });
    return;
  }
  const found = locate(url.searchParams.get('path') ?? '', roots);
  if ('error' in found) {
    sendJson(res, found.status, { error: found.error });
    return;
  }
  if (path === '/api/files/list') {
    if (!found.isDir) sendJson(res, 400, { error: tr('não é uma pasta') });
    else sendJson(res, 200, { path: found.path, root: found.root, ...listDir(found.path, found.root) });
    return;
  }
  if (found.isDir) {
    sendJson(res, 400, { error: tr('não é um arquivo') });
    return;
  }
  const name = basename(found.path);
  let headers: Record<string, string | number>;
  if (url.searchParams.get('download') === '1') {
    headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Length': found.size,
    };
  } else {
    const type = fileType(found.path);
    if (!type) {
      sendJson(res, 415, { error: tr('tipo de arquivo que não se mostra aqui: baixe') });
      return;
    }
    if (found.size > DELIVERY_FILE_MAX_BYTES) {
      sendJson(res, 413, { error: tr('arquivo grande demais para ver aqui: baixe') });
      return;
    }
    headers = viewHeaders(type.type, name, found.size);
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD' || found.size === 0) {
    res.end();
    return;
  }
  const done = (err: NodeJS.ErrnoException | null) => {
    if (err && !res.writableEnded) res.destroy();
  };
  // Só até o tamanho visto agora: um arquivo que ainda está sendo escrito não quebra o Content-Length.
  pipeline(createReadStream(found.path, { start: 0, end: found.size - 1 }), res, done);
}
