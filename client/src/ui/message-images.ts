// Imagens da caixa de mensagem (anexar, Ctrl+V ou arrastar): prepara cada uma no navegador antes de mandar.
// Imagens com mais de MESSAGE_IMAGE_SIDE px no lado maior são reduzidas (PNG continua PNG; foto e WebP viram JPEG de
// boa qualidade); GIF vai como está (pode ser animado). Depois sobem uma a uma (POST /api/messages/images) e a mensagem
// leva os ids. Só a matemática do tamanho é pura (testável); o resto usa o canvas do navegador.
import { MESSAGE_IMAGE_SIDE, MESSAGE_IMAGE_TYPES } from '../../../shared/messages';
import { tr } from '../../../shared/i18n';

/** Teto de cada imagem depois de preparada (o servidor aceita até 15 MB; reduzida, fica bem abaixo). */
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export interface PreparedImage {
  name: string;
  type: string;
  /** Conteúdo em base64 (o que vai no POST). */
  data: string;
  bytes: number;
}

/** Tamanho final: o lado maior em `max` no máximo, mantendo a proporção (nunca aumenta). */
export function fitSize(w: number, h: number, max = MESSAGE_IMAGE_SIDE): { w: number; h: number; scaled: boolean } {
  const side = Math.max(w, h);
  if (side <= max || side <= 0) return { w, h, scaled: false };
  const k = max / side;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/** É imagem que a mensagem aceita (PNG, JPEG, GIF ou WebP)? */
export function acceptedImage(f: Pick<File, 'type'>): boolean {
  return MESSAGE_IMAGE_TYPES.includes(f.type);
}

/** Imagens de uma colagem ou de um arrastar (só os arquivos de imagem aceitos). */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f && acceptedImage(f)) out.push(f);
  }
  if (!out.length) for (const f of Array.from(dt.files ?? [])) if (acceptedImage(f)) out.push(f);
  return out;
}

/** Nome para a imagem: o do arquivo ou, num print colado, "print-<hora>". */
export function imageName(f: Pick<File, 'name' | 'type'>, at = new Date()): string {
  const name = f.name && f.name !== 'image.png' ? f.name : '';
  if (name) return name;
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = f.type === 'image/jpeg' ? 'jpg' : (f.type.split('/')[1] ?? 'png');
  return `print-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.${ext}`;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('read'));
    r.readAsDataURL(blob);
  });
}

/** Prepara uma imagem para mandar: reduz se for grande e devolve em base64. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const name = imageName(file);
  let blob: Blob = file;
  let type = file.type;
  if (file.type !== 'image/gif') {
    const bmp = await createImageBitmap(file);
    const size = fitSize(bmp.width, bmp.height);
    if (size.scaled) {
      const canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      const g = canvas.getContext('2d');
      if (!g) throw new Error(tr('não deu para reduzir a imagem'));
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, size.w, size.h);
      type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(tr('não deu para reduzir a imagem')))), type, 0.9));
    }
    bmp.close();
  }
  if (blob.size > IMAGE_MAX_BYTES) throw new Error(tr('a imagem passa de {0} MB', [IMAGE_MAX_BYTES / 1024 / 1024]));
  const finalName = type === file.type ? name : name.replace(/\.[A-Za-z0-9]{1,5}$/, '') + (type === 'image/png' ? '.png' : '.jpg');
  return { name: finalName, type, data: await toBase64(blob), bytes: blob.size };
}

/** Sobe uma imagem preparada; devolve o id (ou lança com a mensagem do servidor). */
export async function uploadImage(img: PreparedImage): Promise<string> {
  const res = await fetch('/api/messages/images', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: img.name, type: img.type, data: img.data }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (res.status !== 201 || !body.id) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body.id;
}
