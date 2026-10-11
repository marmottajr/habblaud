// Aparência de uma sala escolhida por quem usa o escritório: o layout dos móveis, o estilo (piso, parede e
// móveis), a cor e o lado. Sem nada escolhido, a sala continua como sempre: tudo sorteado pela semente dela.

/** Os layouts prontos. Cada um tem um ícone na tela (client/src/ui/roomstyle.ts) e um desenho (world/layout/room.ts). */
export const ROOM_LAYOUTS = ['equipe', 'criativo', 'reunioes', 'operacao', 'diretoria', 'individual', 'conferencia'] as const;
export type RoomLayoutId = (typeof ROOM_LAYOUTS)[number];

/**
 * Quantos lugares de trabalho (mesas) cada layout tem; "auto" é a sala sorteada. É o teto do limite de agentes
 * fixos da sala (o desenho está em client/src/world/layout/room.ts, e um teste confere os dois).
 */
export const LAYOUT_DESKS: Record<RoomLayoutId | 'auto', number> = { auto: 6, equipe: 12, criativo: 6, reunioes: 6, operacao: 6, diretoria: 4, individual: 1, conferencia: 12 };

/** O maior limite de agentes fixos que uma sala aceita (o do layout com mais mesas). */
export const MAX_ROOM_AGENTS = 12;

/** Quantos agentes fixos cabem sentados à mesa numa sala com esta aparência. */
export function roomCapacity(style?: Pick<RoomStyle, 'layout'>): number {
  return LAYOUT_DESKS[style?.layout ?? 'auto'];
}

/** Lê um limite de agentes vindo de fora: inteiro de 1 a MAX_ROOM_AGENTS; qualquer outra coisa = sem escolha. */
export function parseAgentLimit(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_ROOM_AGENTS ? raw : undefined;
}

/**
 * O limite de agentes fixos que vale numa sala: o escolhido nas configurações dela, sem passar das mesas do
 * layout; sem escolha, as mesas do layout.
 */
export function roomAgentLimit(style: Pick<RoomStyle, 'layout'> | undefined, escolhido?: number): number {
  const cabe = roomCapacity(style);
  const n = parseAgentLimit(escolhido);
  return n ? Math.min(n, cabe) : cabe;
}

/** Quantas cores de sala existem (as paletas de client/src/art/theme.ts). */
export const ROOM_COLORS = 10;

/**
 * Os estilos prontos: cada um combina piso, parede e móveis (client/src/art/roomlook.ts). A cor escolhida entra por
 * cima, nos tapetes e nos detalhes.
 */
export const ROOM_LOOKS = ['classico', 'corporativo', 'moderno', 'futurista', 'minimalista', 'industrial', 'executivo', 'vidro', 'noturno', 'aconchegante'] as const;
export type RoomLookId = (typeof ROOM_LOOKS)[number];

/**
 * O estilo geral do escritório (Configurações): vale nas áreas comuns e em toda sala que não escolheu o seu.
 * "classico" é o escritório como o Habblaud sempre desenhou.
 */
export const OFFICE_STYLES = ['classico', 'corporativo', 'moderno', 'futurista'] as const;
export type OfficeStyleId = (typeof OFFICE_STYLES)[number];

export const OFFICE_STYLE_INFO: Record<OfficeStyleId, { nome: string; dica: string }> = {
  classico: { nome: 'Clássico', dica: 'O escritório de sempre: cada sala com a sua cor, puffs, pôsteres e porcelanato' },
  corporativo: { nome: 'Corporativo', dica: 'Carpete cinza, paredes claras com rodapé escuro, mesas escuras, cadeiras de escritório; sem puffs nem pôsteres' },
  moderno: { nome: 'Moderno', dica: 'Cimento queimado, paredes lisas claras com rodapé grafite, mesas brancas e cadeiras pretas' },
  futurista: { nome: 'Futurista', dica: 'Piso e paredes escuros com frisos luminosos na cor de cada sala, mesas brancas' },
};

/**
 * As duas cores do escritório (Configurações), usadas exatamente como a pessoa escolheu:
 *  - `primary` (a principal): o piso e as paredes do escritório inteiro;
 *  - `secondary` (a de apoio): os tapetes e os frisos.
 * Cada uma é "#rrggbb"; ausente = a do estilo.
 */
export interface OfficeColors {
  primary?: string;
  secondary?: string;
}

/**
 * As cores de fábrica de cada estilo, para os seletores mostrarem o que está em uso: a do piso e a dos tapetes
 * maiores. (No clássico cada sala tem as suas: só vale o que a pessoa escolher.)
 */
export const OFFICE_DEFAULT_COLORS: Record<Exclude<OfficeStyleId, 'classico'>, Required<OfficeColors>> = {
  corporativo: { primary: '#c3c7ce', secondary: '#34415f' },
  moderno: { primary: '#d6d4cd', secondary: '#4a4f5a' },
  futurista: { primary: '#252c48', secondary: '#22c3e6' },
};

/** Lê as cores vindas de fora: só "#rrggbb" fica. */
export function parseOfficeColors(raw: unknown): OfficeColors {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as { primary?: unknown; secondary?: unknown };
  const cor = (v: unknown) => (typeof v === 'string' && ROOM_COLOR_RE.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);
  const out: OfficeColors = {};
  const p = cor(r.primary);
  const s = cor(r.secondary);
  if (p) out.primary = p;
  if (s) out.secondary = s;
  return out;
}

/** As duas cores em uso: as escolhidas, ou as do estilo. No clássico sem escolha, nenhuma. */
export function officePalette(style: OfficeStyleId | undefined, colors: OfficeColors | undefined): OfficeColors {
  const padrao = style && style !== 'classico' ? OFFICE_DEFAULT_COLORS[style] : undefined;
  return { primary: colors?.primary ?? padrao?.primary, secondary: colors?.secondary ?? padrao?.secondary };
}

/** Lê o estilo geral vindo de fora; qualquer outra coisa é o clássico. */
export function parseOfficeStyle(raw: unknown): OfficeStyleId {
  return typeof raw === 'string' && (OFFICE_STYLES as readonly string[]).includes(raw) ? (raw as OfficeStyleId) : 'classico';
}

/** O estilo que vale numa sala: o que ela escolheu, ou o geral do escritório (o clássico não muda nada). */
export function effectiveLook(style: Pick<RoomStyle, 'look'> | undefined, office: OfficeStyleId | undefined): RoomLookId | undefined {
  if (style?.look) return style.look;
  return office && office !== 'classico' ? office : undefined;
}

/** Cor livre, escolhida no seletor de cores: "#rrggbb". */
export const ROOM_COLOR_RE = /^#[0-9a-f]{6}$/;

export interface RoomStyle {
  /** Layout escolhido; ausente = o sorteado pela semente da sala. */
  layout?: RoomLayoutId;
  /** Lado da ilha de mesas: true = invertido, false = normal; ausente = o sorteado. */
  mirror?: boolean;
  /** Cor da sala: índice da paleta (de 0 a ROOM_COLORS - 1) ou uma cor livre ("#rrggbb"); ausente = a sorteada. */
  color?: number | string;
  /** Estilo (piso, parede e móveis); ausente = o da paleta de cor da sala. */
  look?: RoomLookId;
  /**
   * A mesa de cada agente fixo da sala: nome de arquivo do agente -> número da mesa (1 = a primeira de cima, à
   * esquerda; conta-se como se lê). Quem não está aqui senta na primeira mesa livre. Não muda o desenho da sala.
   */
  seats?: Record<string, number>;
}

/** Nome de arquivo de agente fixo (o mesmo formato do comando `equipe`). */
const SEAT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Lê as mesas marcadas vindas de fora: agente válido, mesa de 1 a MAX_ROOM_AGENTS, uma mesa por agente. */
export function parseSeats(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  const usadas = new Set<number>();
  for (const [slug, n] of Object.entries(raw as Record<string, unknown>)) {
    if (usadas.size >= MAX_ROOM_AGENTS) break;
    const mesa = parseAgentLimit(n);
    if (!SEAT_SLUG_RE.test(slug) || !mesa || usadas.has(mesa)) continue;
    out[slug] = mesa;
    usadas.add(mesa);
  }
  return usadas.size ? out : undefined;
}

/** Texto que muda quando as mesas marcadas mudam (a tela manda cada um para a mesa dele quando ele é outro). */
export function seatsKey(s: Pick<RoomStyle, 'seats'> | undefined): string {
  return s?.seats
    ? Object.entries(s.seats)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([slug, n]) => `${slug}:${n}`)
        .join(',')
    : '';
}

/** Nome e descrição curta de cada estilo ("auto" = o da paleta da sala). */
export const ROOM_LOOK_INFO: Record<RoomLookId | 'auto', { nome: string; dica: string }> = {
  auto: { nome: 'Do escritório', dica: 'Segue o estilo geral do escritório, escolhido em Configurações' },
  classico: { nome: 'Clássico', dica: 'Piso de porcelanato, com a parede e os móveis da cor da sala' },
  corporativo: { nome: 'Corporativo', dica: 'Carpete cinza, parede clara com rodapé escuro, mesas escuras, cadeiras de escritório; sem puffs nem pôsteres' },
  futurista: { nome: 'Futurista', dica: 'Piso e paredes escuros, frisos luminosos na cor da sala e mesas brancas' },
  moderno: { nome: 'Moderno', dica: 'Cimento queimado, parede lisa clara com rodapé grafite, mesas brancas (pretas quando a cor da sala é escura) e cadeiras pretas' },
  minimalista: { nome: 'Minimalista', dica: 'Madeira clara, parede branca lisa, mesas brancas e cadeiras cinza' },
  industrial: { nome: 'Industrial', dica: 'Cimento queimado, parede de tijolo, mesas escuras e cadeiras cinza' },
  executivo: { nome: 'Executivo', dica: 'Piso de madeira, parede em painel de madeira, mesas escuras e cadeiras pretas' },
  vidro: { nome: 'Vidro', dica: 'Porcelanato, paredes de vidro, mesas brancas e cadeiras azuis' },
  noturno: { nome: 'Noturno', dica: 'Carpete grafite, parede escura, mesas pretas e cadeiras pretas' },
  aconchegante: { nome: 'Aconchegante', dica: 'Carpete na cor da sala, parede listrada, mesas de madeira' },
};

/** Nome e descrição curta de cada layout ("auto" = o sorteado). */
export const ROOM_LAYOUT_INFO: Record<RoomLayoutId | 'auto', { nome: string; dica: string }> = {
  auto: { nome: 'Automático', dica: 'O escritório escolhe os móveis desta sala' },
  equipe: { nome: 'Equipe', dica: 'Doze mesas: uma ilha de seis de cada lado da sala, com o corredor no meio, e canto de descanso' },
  criativo: { nome: 'Criativo', dica: 'Ilha de seis mesas, recanto com poltronas e puffs, e plantas' },
  reunioes: { nome: 'Reuniões', dica: 'Ilha de seis mesas, mesinhas redondas e mesa de pé' },
  operacao: { nome: 'Operação', dica: 'Ilha de seis mesas, mesa de reunião, impressão e arquivos' },
  diretoria: { nome: 'Diretoria', dica: 'A sala dividida em quatro gabinetes por divisórias de vidro, cada um com a sua mesa e uma cadeira de visita' },
  conferencia: { nome: 'Conferência', dica: 'Sala de reunião: uma mesa de conferência inteiriça com doze cadeiras de escritório' },
  individual: { nome: 'Individual', dica: 'Sala corporativa de uma pessoa: mesa executiva com três monitores, cadeiras de visita, mesa de reunião, poltrona de leitura e arquivos' },
};

/** Lê uma aparência vinda de fora (arquivo, rota): só o que é válido fica. Nada escolhido = undefined. */
export function parseRoomStyle(raw: unknown): RoomStyle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { layout?: unknown; mirror?: unknown; color?: unknown; look?: unknown; seats?: unknown };
  const out: RoomStyle = {};
  if (typeof r.layout === 'string' && (ROOM_LAYOUTS as readonly string[]).includes(r.layout)) out.layout = r.layout as RoomLayoutId;
  if (typeof r.mirror === 'boolean') out.mirror = r.mirror;
  if (typeof r.color === 'number' && Number.isInteger(r.color) && r.color >= 0 && r.color < ROOM_COLORS) out.color = r.color;
  else if (typeof r.color === 'string' && ROOM_COLOR_RE.test(r.color.trim().toLowerCase())) out.color = r.color.trim().toLowerCase();
  if (typeof r.look === 'string' && (ROOM_LOOKS as readonly string[]).includes(r.look)) out.look = r.look as RoomLookId;
  const seats = parseSeats(r.seats);
  if (seats) out.seats = seats;
  return Object.keys(out).length ? out : undefined;
}

/** Texto que muda quando a aparência muda (a tela refaz a sala quando ele é outro). */
export function roomStyleKey(s: RoomStyle | undefined): string {
  return s ? `${s.layout ?? ''}|${s.mirror === undefined ? '' : s.mirror ? 1 : 0}|${s.color ?? ''}|${s.look ?? ''}` : '';
}
