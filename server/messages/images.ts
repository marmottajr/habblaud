// Imagens nas mensagens pelo escritório (anexar, Ctrl+V ou arrastar na caixa de mensagem). A página manda cada imagem
// antes (POST /api/messages/images, JSON base64, como os anexos do Novo agente) e a mensagem leva os ids; na hora de
// mandar, as imagens são gravadas em ~/.habblaud/attachments/<data>-msg<id>/ e o texto ganha os caminhos delas no
// computador (shared/messages.ts, messageWithImages), que o agente abre com a ferramenta de leitura.
// Quem grava é o próprio servidor: no modo Node, direto na pasta; no Docker, na montagem GRAVÁVEL que o docker-up faz
// só desta pasta (`dir`), e o texto leva o caminho dela no host (`hostDir`). Só imagens: o tipo vem dos primeiros bytes,
// não do nome nem do que a página disse.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { tr } from '../../shared/i18n';
import { MESSAGE_IMAGES_MAX } from '../../shared/messages';
import { joinHostPath } from '../../shared/presentation';
import { AttachmentStore, parseAttachment, writeAttachments, type Attachment } from '../spawn/attachments';

/** Teto da memória das imagens esperando a mensagem (todas as caixas juntas). */
const STORE_MAX_BYTES = 80 * 1024 * 1024;

const SIGNATURES: Array<{ type: string; ext: string; test: (b: Buffer) => boolean }> = [
  { type: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  { type: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Tipo da imagem pelos primeiros bytes (PNG, JPEG, GIF ou WebP), ou undefined. */
export function sniffImage(data: Buffer): { type: string; ext: string } | undefined {
  const s = SIGNATURES.find((x) => x.test(data));
  return s ? { type: s.type, ext: s.ext } : undefined;
}

/** Nome com a extensão do tipo de verdade (um "print" colado chega sem nome útil). */
function withExt(name: string, ext: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${base || 'imagem'}.${ext}`;
}

export interface MessageImagesOptions {
  /** Onde o servidor grava (no Docker, a montagem gravável). */
  dir: string;
  /** A mesma pasta no computador do usuário (vai no texto da mensagem). */
  hostDir: string;
  now?: () => number;
}

export class MessageImages {
  private readonly store: AttachmentStore;

  constructor(private readonly opts: MessageImagesOptions) {
    this.store = new AttachmentStore(opts.now ?? Date.now, undefined, STORE_MAX_BYTES);
  }

  /** Uma imagem enviada pela página ({name, type, data base64}): só imagem de verdade. */
  put(raw: unknown): { id: string } | { error: string } {
    const a = parseAttachment(raw);
    if ('error' in a) return a;
    const kind = sniffImage(a.data);
    if (!kind) return { error: tr('só imagens (PNG, JPEG, GIF ou WebP)') };
    return this.store.put({ name: withExt(a.name, kind.ext), type: kind.type, data: a.data });
  }

  /** Tira as imagens de uma mensagem (cada uma serve a uma só). */
  take(ids: unknown): Attachment[] | { error: string } {
    if (Array.isArray(ids) && ids.length > MESSAGE_IMAGES_MAX) return { error: tr('no máximo {0} imagens por mensagem', [MESSAGE_IMAGES_MAX]) };
    return this.store.take(ids);
  }

  /** Grava as imagens numa pasta nova e devolve os caminhos no computador do usuário (e a pasta, para desfazer). */
  write(files: readonly Attachment[], at = new Date(this.opts.now?.() ?? Date.now())): { paths: string[]; folder?: string } {
    try {
      const written = writeAttachments(this.opts.dir, `msg${randomBytes(4).toString('hex')}`, files, at);
      return { paths: written.map((p) => this.hostPath(p)), ...(written[0] ? { folder: dirname(written[0]) } : {}) };
    } finally {
      this.store.release(files.reduce((n, f) => n + f.data.length, 0));
    }
  }

  /** A mensagem não saiu: a pasta gravada sai também. */
  discard(folder: string | undefined): void {
    if (!folder) return;
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      // fica: é a pasta dos seus anexos
    }
  }

  private hostPath(p: string): string {
    const rel = relative(this.opts.dir, p);
    if (!rel || rel.startsWith('..')) return p;
    return joinHostPath(this.opts.hostDir, ...rel.split(sep));
  }
}
