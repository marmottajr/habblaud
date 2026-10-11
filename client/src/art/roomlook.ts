// Estilos de sala (puros): o que a pessoa escolhe em "Aparência da sala" vira um tema.
//  - a cor: uma das paletas de theme.ts (pelo índice) ou uma cor livre ("#rrggbb"), de onde saem os tons da sala;
//  - o estilo: piso, parede e móveis combinados (moderno, industrial, vidro...), por cima da cor.
// Sem nada escolhido, vale o tema que a semente da sala sorteia (theme.ts).
import { effectiveLook, ROOM_COLOR_RE, type OfficeColors, type OfficeStyleId, type RoomLookId, type RoomStyle } from '../../../shared/roomstyle';
import type { FloorKind, RoomTheme, WallPattern } from './api';
import { mix, shade } from './core/color';
import { roomTheme } from './theme';

/** O que um estilo fixa. Cores com função recebem a cor da sala (`accent`) e devolvem o tom. */
interface LookDef {
  floor: FloorKind;
  floorColor?: (accent: string) => string;
  wallBase: (accent: string) => string;
  wallTrim: (accent: string) => string;
  pattern: WallPattern;
  desk: 'wood' | 'white' | 'dark' | 'black';
  /** Com a cor da sala escura (preto, grafite, azul-marinho), a mesa do estilo vira a preta. */
  deskOnDark?: 'black';
  /** Cadeira fixa do estilo; ausente = a que combina com a cor da sala. */
  chair?: 'black' | 'blue' | 'red' | 'green' | 'gray';
  /** Tapete: quanto da cor da sala entra sobre o tom neutro do estilo (0 = neutro, 1 = a cor). */
  rug: (accent: string) => string;
  /** Sala formal (RoomTheme.formal): cadeiras de escritório nas reuniões, sem puffs nem pôsteres. */
  formal?: boolean;
  /**
   * Estilos gerais do escritório (Corporativo, Moderno, Futurista): de fábrica, toda sala usa os mesmos tons (o
   * tapete da ilha, os outros tapetes e o rodapé/friso), para o conjunto ficar harmônico. Sem isto, o tapete sai de
   * `rug`, com a cor da própria sala.
   */
  duo?: { carpet: string; carpet2: string; trim: string };
}

export const LOOKS: Record<Exclude<RoomLookId, 'classico'>, LookDef> = {
  corporativo: {
    floor: 'carpet',
    floorColor: () => '#c3c7ce',
    wallBase: () => '#f1f2f4',
    wallTrim: () => '#27314a',
    pattern: 'plain',
    desk: 'dark',
    deskOnDark: 'black',
    chair: 'black',
    rug: (a) => mix('#4c5363', a, 0.2),
    formal: true,
    duo: { carpet: '#34415f', carpet2: '#7a8496', trim: '#27314a' },
  },
  futurista: {
    floor: 'carpet',
    floorColor: () => '#252c48',
    wallBase: () => '#2b3353',
    wallTrim: (a) => mix(a, '#ffffff', 0.18),
    pattern: 'tiles',
    desk: 'white',
    chair: 'blue',
    rug: (a) => mix('#17203a', a, 0.55),
    duo: { carpet: '#1f7495', carpet2: '#53409d', trim: '#3dcaea' },
  },
  moderno: {
    floor: 'concrete',
    wallBase: () => '#f4f4f2',
    wallTrim: () => '#3a404b',
    pattern: 'plain',
    desk: 'white',
    deskOnDark: 'black',
    chair: 'black',
    rug: (a) => mix('#c6cad1', a, 0.28),
    duo: { carpet: '#4a4f5a', carpet2: '#b3b8c0', trim: '#4a4f5a' },
  },
  minimalista: {
    floor: 'wood',
    wallBase: () => '#fafaf7',
    wallTrim: () => '#d9d6cf',
    pattern: 'plain',
    desk: 'white',
    chair: 'gray',
    rug: (a) => mix('#ebe7df', a, 0.14),
  },
  industrial: {
    floor: 'concrete',
    wallBase: () => '#b9654a',
    wallTrim: () => '#4a4f5c',
    pattern: 'brick',
    desk: 'dark',
    chair: 'gray',
    rug: (a) => mix('#8f949d', a, 0.25),
  },
  executivo: {
    floor: 'wood',
    wallBase: () => '#efe6d8',
    wallTrim: () => '#7a5a40',
    pattern: 'wood_panel',
    desk: 'dark',
    chair: 'black',
    rug: (a) => mix('#5a4636', a, 0.3),
    formal: true,
  },
  vidro: {
    floor: 'marble',
    wallBase: (a) => mix('#eaf3f8', a, 0.06),
    wallTrim: () => '#9db4c6',
    pattern: 'glass',
    desk: 'white',
    chair: 'blue',
    rug: (a) => mix('#d5e3ec', a, 0.25),
  },
  noturno: {
    floor: 'carpet',
    floorColor: (a) => mix('#3b4150', a, 0.08),
    wallBase: () => '#2f3542',
    wallTrim: (a) => mix('#596173', a, 0.45),
    pattern: 'plain',
    desk: 'black',
    chair: 'black',
    rug: (a) => mix('#2a2f3a', a, 0.42),
  },
  aconchegante: {
    floor: 'carpet',
    floorColor: (a) => mix('#e6dccb', a, 0.16),
    wallBase: (a) => mix('#f6efe4', a, 0.05),
    wallTrim: (a) => mix('#b99f7a', a, 0.3),
    pattern: 'stripes',
    desk: 'wood',
    rug: (a) => mix('#d9c8ad', a, 0.4),
  },
};

const CHAIRS: readonly { id: 'blue' | 'red' | 'green'; h: number }[] = [
  { id: 'red', h: 0 },
  { id: 'green', h: 130 },
  { id: 'blue', h: 220 },
];

/** Matiz (0–360) e saturação (0–1) de uma cor "#rrggbb". */
function hueSat(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l };
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: d / (1 - Math.abs(2 * l - 1)), l };
}

/** A cor é escura (preto, grafite, azul-marinho)? Com ela, mesa clara destoa: a sala pede a mesa preta. */
export function isDarkColor(hex: string): boolean {
  return hueSat(hex).l < 0.27;
}

/** A cadeira que combina com a cor: preta ou cinza para tons sem cor; senão, a de matiz mais próximo. */
export function chairFor(hex: string): 'black' | 'blue' | 'red' | 'green' | 'gray' {
  const { h, s, l } = hueSat(hex);
  if (s < 0.18) return l < 0.45 ? 'black' : 'gray';
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  return [...CHAIRS].sort((x, y) => dist(h, x.h) - dist(h, y.h))[0].id;
}

/** O tema de uma cor livre: os tons claros da sala (tapete, parede) saem dela; ela mesma é o destaque. */
export function themeFromColor(hex: string): RoomTheme {
  const c = hex.toLowerCase();
  const carpet = mix('#d9dce1', c, 0.3);
  return {
    carpet,
    carpet2: shade(carpet, -0.045),
    wall: { base: mix('#f5f5f3', c, 0.07), trim: mix('#a9aeb7', c, 0.45), pattern: 'plain' },
    accent: c,
    deskVariant: isDarkColor(c) ? 'black' : 'white',
    chairVariant: isDarkColor(c) ? 'black' : chairFor(c),
  };
}

/** O tema da sala só pela cor: a escolhida (paleta ou livre), ou a que a semente sorteia. */
export function colorTheme(seed: number, color: RoomStyle['color']): RoomTheme {
  if (typeof color === 'string' && ROOM_COLOR_RE.test(color)) return themeFromColor(color);
  return roomTheme(typeof color === 'number' ? color : seed);
}

/**
 * As cores que mandam numa sala, usadas exatamente como foram escolhidas: `primary` pinta o piso e as paredes
 * (a principal do escritório); `secondary` pinta os tapetes e o friso (a de apoio do escritório, ou a cor da
 * própria sala). Ausente = a do estilo.
 */
export interface LookColors {
  primary?: string;
  secondary?: string;
}

/** A parede na cor principal: um pouco mais clara que o piso, só o bastante para se ler como parede. */
export const wallOf = (primary: string): string => mix(primary, '#ffffff', 0.1);

/**
 * Aplica um estilo por cima do tema de cor e, por cima do estilo, as cores escolhidas (`cores`). Nos estilos gerais
 * (os que têm `duo`) sem cor escolhida, toda sala usa os tons de fábrica do estilo.
 */
export function applyLook(base: RoomTheme, look: RoomLookId | undefined, cores?: LookColors): RoomTheme {
  const def = look && look !== 'classico' ? LOOKS[look] : undefined;
  const a = base.accent;
  let t: RoomTheme = base;
  if (def) {
    const rug = def.duo ? def.duo.carpet : def.rug(a);
    t = {
      carpet: rug,
      carpet2: def.duo ? def.duo.carpet2 : shade(rug, -0.05),
      wall: { base: def.wallBase(a), trim: def.duo ? def.duo.trim : def.wallTrim(a), pattern: def.pattern },
      accent: a,
      deskVariant: def.desk,
      chairVariant: def.chair ?? base.chairVariant,
      floor: def.floor,
      ...(def.floorColor ? { floorColor: def.floorColor(a) } : {}),
      ...(def.formal ? { formal: true } : {}),
    };
  }
  const p = cores?.primary;
  const s2 = cores?.secondary;
  if (!p && !s2) return t;
  // As cores escolhidas valem como foram escolhidas: a de apoio nos tapetes e no friso; a principal no piso
  // (que vira carpete, o piso que aceita qualquer cor) e nas paredes.
  const escura = isDarkColor(p ?? s2!);
  return {
    ...t,
    ...(s2 ? { carpet: s2, carpet2: s2 } : {}),
    wall: { ...t.wall, ...(p ? { base: wallOf(p) } : {}), ...(s2 ? { trim: s2 } : {}) },
    ...(p ? { floor: 'carpet' as const, floorColor: p } : {}),
    // Cor escura pede móveis escuros (nos estilos que têm a mesa preta, e no clássico).
    ...(escura && (!def || def.deskOnDark) ? { deskVariant: 'black', chairVariant: 'black' } : {}),
  };
}

/**
 * O tema de uma sala a partir de quem sorteia o tema pela semente (`seeded`): a cor da sala (a escolhida, ou a
 * sorteada), o estilo (o da sala, ou o geral) e, por cima, as cores: a principal do escritório no piso e nas
 * paredes; nos tapetes e frisos, a cor escolhida para a sala ou, sem ela, a de apoio do escritório.
 */
export function resolveTheme(seeded: (seed: number) => RoomTheme, seed: number, style: RoomStyle | undefined, office?: OfficeStyleId, colors?: OfficeColors): RoomTheme {
  const cor = style?.color;
  const base = typeof cor === 'string' && ROOM_COLOR_RE.test(cor) ? themeFromColor(cor) : seeded(typeof cor === 'number' ? cor : seed);
  const look = effectiveLook(style, office);
  // A cor da própria sala manda nos tapetes dela quando o estilo é um dos gerais (nos outros ela já entra pelo tema).
  const geral = look === 'corporativo' || look === 'moderno' || look === 'futurista';
  const propria = cor !== undefined && (geral || !!colors?.secondary || !!colors?.primary) ? base.accent : undefined;
  return applyLook(base, look, { primary: colors?.primary, secondary: propria ?? colors?.secondary });
}

/** O tema completo de uma sala: a cor e, por cima, o estilo dela (ou o geral do escritório, com as cores dele). */
export function styledTheme(seed: number, style: RoomStyle | undefined, office?: OfficeStyleId, colors?: OfficeColors): RoomTheme {
  return resolveTheme(roomTheme, seed, style, office, colors);
}
