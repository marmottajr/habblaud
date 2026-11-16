import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageWithImages } from '../../shared/messages';
import { MessageImages, sniffImage } from './images';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(16)]);
const b64 = (b: Buffer) => b.toString('base64');

describe('imagens nas mensagens', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-msgimg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sniffImage: o tipo vem dos primeiros bytes, não do nome', () => {
    expect(sniffImage(PNG)).toEqual({ type: 'image/png', ext: 'png' });
    expect(sniffImage(JPEG)).toEqual({ type: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(Buffer.from('GIF89a........'))).toMatchObject({ type: 'image/gif' });
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toMatchObject({ type: 'image/webp' });
    expect(sniffImage(Buffer.from('<svg></svg>'))).toBeUndefined();
  });

  it('só aceita imagem de verdade, com a extensão do tipo real; até 6 por mensagem', () => {
    const imgs = new MessageImages({ dir, hostDir: dir });
    expect(imgs.put({ name: 'x.png', type: 'image/png', data: b64(Buffer.from('não é imagem')) })).toMatchObject({ error: expect.stringMatching(/só imagens/) });
    expect(imgs.put({ name: 'foto.png', type: 'image/png', data: b64(JPEG) })).toHaveProperty('id');
    expect(imgs.take(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toMatchObject({ error: expect.stringMatching(/6 imagens/) });
  });

  it('grava numa pasta nova e devolve os caminhos no computador do usuário (Docker: a pasta do host)', () => {
    const imgs = new MessageImages({ dir, hostDir: 'C:\\Users\\ana\\.habblaud\\attachments' });
    const a = imgs.put({ name: 'print.png', type: 'image/png', data: b64(PNG) });
    const b = imgs.put({ name: 'print.png', type: 'image/png', data: b64(PNG) });
    const files = imgs.take([(a as { id: string }).id, (b as { id: string }).id]);
    expect(Array.isArray(files)).toBe(true);
    const out = imgs.write(files as never);
    expect(out.paths).toHaveLength(2);
    expect(out.paths[0]).toMatch(/^C:\\Users\\ana\\\.habblaud\\attachments\\\d{8}-\d{6}-msg[0-9a-f]+\\print\.png$/);
    expect(out.paths[1]).toMatch(/print-2\.png$/);
    const folder = readdirSync(dir)[0]!;
    expect(readFileSync(join(dir, folder, 'print.png'))).toEqual(PNG);
    // um id só serve uma vez
    expect(imgs.take([(a as { id: string }).id])).toMatchObject({ error: expect.any(String) });
    imgs.discard(out.folder);
    expect(existsSync(join(dir, folder))).toBe(false);
  });

  it('o texto leva os caminhos no fim, com o pedido para abrir; sem texto, só o pedido', () => {
    expect(messageWithImages('Olha esse erro', ['/h/a.png'])).toBe('Olha esse erro\n\n[Imagem anexada pelo Habblaud: abra com a ferramenta de leitura para ver]\n- /h/a.png');
    const empty = messageWithImages('  ', ['/h/a.png', '/h/b.png']);
    expect(empty.startsWith('Veja as imagens que mandei.')).toBe(true);
    expect(empty).toContain('[2 imagens anexadas pelo Habblaud');
    expect(messageWithImages('só texto', [])).toBe('só texto');
  });
});
