// Apresentações na TV das salas: o agente principal de uma sala grava uma apresentação em slides (Markdown) em
// ~/.habblaud/apresentacoes/<pasta da sala>/<data>-<título>/slides.md e o escritório a mostra quando você clica na TV
// daquela sala. Código puro, usado pelo servidor (server/presentations/, que acha os arquivos, e o pedido feito pela
// TV) e pela página (client/src/ui/tv.ts, que desenha os slides):
// - a pasta de cada sala (nome legível + hash do id, estável enquanto o projeto não mudar de lugar);
// - o texto do pedido que a TV manda ao agente (roteiro padrão e as regras do formato);
// - os slides: separados por uma linha só com "---" (fora dos blocos de código);
// - um Markdown pequeno e SEGURO, em blocos e trechos: a página monta o DOM com textContent, nunca com innerHTML, e só
//   abre links http(s)/mailto. Nada de HTML do agente na página.
import { hash32 } from './hash';
import { tr } from './i18n';

/** Nome do arquivo dos slides dentro da pasta de cada apresentação. */
export const SLIDES_FILE = 'slides.md';
/** Tamanho máximo do slides.md lido (o resto é ignorado). */
export const PRESENTATION_MAX_BYTES = 512 * 1024;
/** Slides demais numa apresentação: os que passarem disso ficam de fora. */
export const PRESENTATION_MAX_SLIDES = 80;
/** Nome aceito para a pasta de uma sala ou de uma apresentação (sem caminhos, sem pontos no começo). */
export const FOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;

/** Estado da TV de uma sala, no snapshot (RoomInfo.tv). */
export type TvState = 'off' | 'preparing' | 'new' | 'ready';

export interface RoomTv {
  /** off = sem apresentação; preparing = pedida e ainda não gravada; new = a mais recente ainda não foi vista; ready. */
  state: TvState;
  /** Título da mais recente. */
  title?: string;
  /** Quantas apresentações a sala tem. */
  count: number;
}

/** Uma apresentação na lista da TV (GET /api/presentations?room=). */
export interface PresentationSummary {
  /** Id opaco (o navegador nunca vê caminhos). */
  id: string;
  roomId: string;
  title: string;
  /** Última gravação do slides.md (epoch ms). */
  at: number;
  slides: number;
  seen: boolean;
}

/** Uma apresentação com o texto (GET /api/presentations/:id). */
export interface PresentationContent extends PresentationSummary {
  markdown: string;
}

// ------------------------------------------------------------------ pastas

/** Trecho de nome de pasta: sem acentos, minúsculo, só letras, números e hífens. */
export function folderSlug(s: string, max = 40): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug;
}

/**
 * Pasta de uma sala dentro de ~/.habblaud/apresentacoes: o nome da pasta do projeto (legível) e o hash do id da sala
 * (dois projetos com o mesmo nome não se misturam). Ex.: "habblaud-1x9k2a".
 */
export function roomFolder(roomId: string): string {
  const base = roomId.split(/[\\/]+/).filter(Boolean).pop() ?? '';
  return `${folderSlug(base) || 'sala'}-${hash32(roomId).toString(36).padStart(6, '0').slice(-6)}`;
}

/** Começo do nome da pasta de uma apresentação: a data e a hora do pedido ("2026-11-16-1432"). */
export function presentationStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Junta partes de um caminho do computador do usuário com o separador dele (\ no Windows, / no resto). */
export function joinHostPath(base: string, ...parts: string[]): string {
  const sep = /^[a-z]:\\|\\/i.test(base) && !base.startsWith('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

// ------------------------------------------------------------------ pedido

/**
 * Texto que a TV manda ao agente principal (pelo plugin de mensagens, como se você tivesse digitado): o roteiro
 * padrão sobre a última tarefa concluída e as regras do formato. `folder` = pasta da sala no computador do usuário
 * (caminho absoluto); `at` = hora do pedido (vira o começo do nome da pasta da apresentação).
 */
export function presentationRequestText(folder: string, at: number): string {
  const dir = joinHostPath(folder, `${presentationStamp(at)}-<${tr('titulo-curto')}>`);
  const file = joinHostPath(dir, SLIDES_FILE);
  return [
    tr('Crie uma apresentação em slides sobre a última tarefa que você concluiu nesta sessão, para eu assistir na TV da sala no Habblaud.'),
    '',
    tr('Roteiro:'),
    tr('1. Título e o que foi pedido.'),
    tr('2. O que foi feito.'),
    tr('3. Antes e depois.'),
    tr('4. Decisões tomadas e por quê.'),
    tr('5. Riscos e pendências.'),
    tr('6. Próximos passos.'),
    '',
    tr('Formato (Markdown, sem HTML):'),
    tr('- Um único arquivo, com os slides separados por uma linha só com ---.'),
    tr('- O primeiro slide começa com "# " e o título da apresentação; cada slide seguinte começa com "## " e o título dele.'),
    tr('- Até uns 6 tópicos curtos por slide. Pode usar **negrito**, `código`, blocos de código curtos e tabelas.'),
    tr('- Imagens: ![legenda](caminho absoluto de uma imagem do projeto: png, jpg, gif, webp ou svg).'),
    '',
    tr('Grave o arquivo em {0} (troque <{1}> por poucas palavras, em minúsculas e com hífens; crie a pasta). Não grave nada fora dessa pasta e não altere o projeto. No fim, responda só com o título da apresentação.', [file, tr('titulo-curto')]),
  ].join('\n');
}

// ------------------------------------------------------------------ slides e Markdown

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'img'; src: string; alt: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: { level: number; c: Inline[] }[] }
  | { t: 'code'; lang?: string; v: string }
  | { t: 'quote'; c: Inline[] }
  | { t: 'table'; align: Array<'left' | 'center' | 'right' | undefined>; head: Inline[][]; rows: Inline[][][] }
  | { t: 'img'; src: string; alt: string };

export interface Slide {
  blocks: Block[];
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;

/** Divide o texto em slides: uma linha só com "---" (fora dos blocos de código) separa um slide do outro. */
export function splitSlides(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[][] = [[]];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence && !f[2]) fence = null;
    } else if (!fence && /^\s*-{3,}\s*$/.test(line)) {
      out.push([]);
      continue;
    }
    out[out.length - 1].push(line);
  }
  return out.map((l) => l.join('\n').trim()).filter(Boolean).slice(0, PRESENTATION_MAX_SLIDES);
}

/** Link que a página pode abrir (em outra aba): só http(s) e mailto. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : undefined;
}

// `código` | ![alt](src) | [texto](href) | **negrito** | __negrito__ | *itálico* | _itálico_
const TARGET = String.raw`\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)`;
const INLINE_RE = new RegExp(
  String.raw`\x60([^\x60]+)\x60|!\[([^\]]*)\]${TARGET}|\[([^\]]+)\]${TARGET}|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|\*(?=[^\s*])(.+?)\*|(?<![\w])_(?=\S)(.+?)_(?![\w])`,
  'g',
);

/** Trechos de uma linha (negrito, itálico, código, links e imagens). */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const text = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };
  let at = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    text(s.slice(at, m.index));
    at = m.index! + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'img', alt: m[2], src: (m[3] ?? m[4] ?? '').trim() });
    else if (m[5] !== undefined) {
      const href = safeHref(m[6] ?? m[7] ?? '');
      const c = parseInline(m[5]);
      if (href) out.push({ t: 'link', href, c });
      else for (const x of c) x.t === 'text' ? text(x.v) : out.push(x);
    } else if (m[8] !== undefined || m[9] !== undefined) out.push({ t: 'b', c: parseInline(m[8] ?? m[9]) });
    else out.push({ t: 'i', c: parseInline(m[10] ?? m[11]) });
  }
  text(s.slice(at));
  return out;
}

const LIST_RE = /^(\s*)([-*+]|(\d{1,4})[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMAGE_ONLY = new RegExp(String.raw`^!\[([^\]]*)\]${TARGET}$`);

function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Blocos de um slide. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = FENCE.exec(lines[i]);
        if (close && close[1][0] === fence[1][0] && !close[2]) break;
        body.push(lines[i]);
      }
      blocks.push({ t: 'code', ...(fence[2] ? { lang: fence[2] } : {}), v: body.join('\n') });
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (h) {
      flush();
      blocks.push({ t: 'h', level: Math.min(3, h[1].length) as 1 | 2 | 3, c: parseInline(h[2]) });
      continue;
    }
    const img = IMAGE_ONLY.exec(trimmed);
    if (img) {
      flush();
      blocks.push({ t: 'img', alt: img[1], src: (img[2] ?? img[3] ?? '').trim() });
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && lines[i].trim().startsWith('>'); i++) quote.push(lines[i].trim().replace(/^>\s?/, ''));
      i--;
      blocks.push({ t: 'quote', c: parseInline(quote.join(' ')) });
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim().includes('|'); i++) rows.push(tableCells(lines[i]).map(parseInline));
      i--;
      blocks.push({ t: 'table', align, head: head.map(parseInline), rows });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      flush();
      const ordered = li[3] !== undefined;
      const items: { level: number; c: Inline[] }[] = [];
      const base = li[1].length;
      for (; i < lines.length; i++) {
        const m = LIST_RE.exec(lines[i]);
        const deeper = !!m && m[1].length > base + 1;
        if (m && (deeper || (m[3] !== undefined) === ordered)) items.push({ level: deeper ? 1 : 0, c: parseInline(m[4]) });
        else if (m) break; // outro tipo de lista no mesmo nível: começa uma lista nova
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // continuação do item anterior (linha recuada)
          items[items.length - 1].c.push({ t: 'text', v: ' ' }, ...parseInline(lines[i].trim()));
        } else break;
      }
      i--;
      blocks.push({ t: 'list', ordered, start: ordered ? Number(li[3]) : 1, items });
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return blocks;
}

/** Os slides de uma apresentação, já em blocos. */
export function parseSlides(markdown: string): Slide[] {
  return splitSlides(markdown).map((s) => ({ blocks: parseBlocks(s) }));
}

/** Texto puro de trechos (títulos, leitura em voz alta, tempo do modo automático). */
export function inlineText(c: readonly Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.t === 'img' ? x.alt : inlineText(x.c))).join('');
}

/** Título da apresentação: o primeiro título "#" (ou o primeiro título qualquer) do texto, ou undefined. */
export function presentationTitle(markdown: string): string | undefined {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let fence = false;
  let fallback: string | undefined;
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const t = inlineText(parseInline(h[2])).trim().slice(0, 160);
    if (!t) continue;
    if (h[1].length === 1) return t;
    fallback ??= t;
  }
  return fallback;
}

/** Caminhos de imagem citados nos slides (a rota de imagens só serve estes). */
export function imageSources(markdown: string): string[] {
  const out = new Set<string>();
  const walk = (c: readonly Inline[]) => {
    for (const x of c) {
      if (x.t === 'img') out.add(x.src);
      else if (x.t === 'b' || x.t === 'i' || x.t === 'link') walk(x.c);
    }
  };
  for (const s of parseSlides(markdown))
    for (const b of s.blocks) {
      if (b.t === 'img') out.add(b.src);
      else if (b.t === 'h' || b.t === 'p' || b.t === 'quote') walk(b.c);
      else if (b.t === 'list') b.items.forEach((it) => walk(it.c));
      else if (b.t === 'table') [b.head, ...b.rows].forEach((row) => row.forEach(walk));
    }
  return [...out].filter(Boolean);
}

/** Texto de um slide (para o tempo do modo automático). */
export function slideText(s: Slide): string {
  return s.blocks
    .map((b) =>
      b.t === 'code'
        ? b.v
        : b.t === 'img'
          ? b.alt
          : b.t === 'list'
            ? b.items.map((it) => inlineText(it.c)).join(' ')
            : b.t === 'table'
              ? [b.head, ...b.rows].map((r) => r.map(inlineText).join(' ')).join(' ')
              : inlineText(b.c),
    )
    .join(' ');
}

/** Quanto tempo cada slide fica na tela no modo automático: pelo tamanho do texto, de 5 a 20 s. */
export function autoAdvanceMs(s: Slide): number {
  const chars = slideText(s).replace(/\s+/g, ' ').trim().length;
  const images = s.blocks.filter((b) => b.t === 'img').length;
  return Math.min(20_000, Math.max(5_000, 3_000 + chars * 55 + images * 2_500));
}
