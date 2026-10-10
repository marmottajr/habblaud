// Estilo geral do escritório nas áreas comuns (recepção, copa, lounge, banheiros e corredor): troca o piso, o
// acabamento das paredes e a cor dos tapetes do layout que core.ts e corridor.ts montam, sem mexer nos móveis nem
// nos lugares. Cada estilo usa os mesmos tons do escritório inteiro (os das salas: art/roomlook.ts), para o conjunto
// ficar harmônico; as cores que a pessoa escolhe valem por cima, exatamente como escolhidas. "classico" sem cores
// escolhidas devolve a área como ela é.
import type { FloorKind, WallStyle } from '../../art/api';
import { mix, shade } from '../../art/core/color';
import type { OfficeColors, OfficeStyleId } from '../../../../shared/roomstyle';
import type { AreaKind, AreaLayout } from './types';

export interface AreaLook {
  /** Piso novo (com a cor, quando é carpete); ausente = o da área. */
  floor?: { kind: FloorKind; tint?: string; tint2?: string };
  /** Acabamento das paredes; as de vidro continuam de vidro. */
  wall?: Pick<WallStyle, 'base' | 'trim' | 'pattern'>;
  /** Cores dos tapetes, na ordem em que a área os tem (sobrando tapete, repete a última). */
  rugs?: readonly string[];
}

export type CoreLooks = Partial<Record<AreaKind, AreaLook>>;

const carpete = (cor: string) => ({ kind: 'carpet' as const, tint: cor, tint2: shade(cor, -0.035) });

const AREAS: readonly AreaKind[] = ['reception', 'cafe', 'lounge', 'restroom', 'corridor'];

/** O que cada estilo faz em cada área, de fábrica (sem cores escolhidas). */
function styleLooks(style: OfficeStyleId | undefined): CoreLooks {
  switch (style) {
    case 'corporativo': {
      const [p, s, trim] = ['#34415f', '#7a8496', '#27314a'];
      const parede = { base: '#f1f2f4', trim, pattern: 'plain' as const };
      return {
        reception: { floor: carpete('#c3c7ce'), wall: { ...parede, pattern: 'wood_panel' }, rugs: [p, s] },
        cafe: { floor: { kind: 'marble' }, wall: parede, rugs: [s] },
        lounge: { floor: carpete('#c3c7ce'), wall: parede, rugs: [p, s] },
        restroom: { wall: { base: '#e9ecf0', trim, pattern: 'tiles' }, rugs: [s] },
        corridor: { floor: carpete('#b6bbc3'), rugs: [p] },
      };
    }
    case 'moderno': {
      const [p, s] = ['#4a4f5a', '#b3b8c0'];
      const parede = { base: '#f4f4f2', trim: p, pattern: 'plain' as const };
      return {
        reception: { floor: { kind: 'concrete' }, wall: parede, rugs: [p, s] },
        cafe: { floor: { kind: 'concrete' }, wall: parede, rugs: [s] },
        lounge: { floor: { kind: 'concrete' }, wall: parede, rugs: [p, s] },
        restroom: { wall: { base: '#eef0f2', trim: p, pattern: 'tiles' }, rugs: [s] },
        corridor: { rugs: [s] },
      };
    }
    case 'futurista': {
      const [rugP, rugS, neonP, neonS] = ['#1f7495', '#53409d', '#3dcaea', '#9a70f7'];
      const parede = (trim: string) => ({ base: '#2b3353', trim, pattern: 'tiles' as const });
      return {
        reception: { floor: carpete('#252c48'), wall: parede(neonP), rugs: [rugP, rugS] },
        cafe: { floor: carpete('#2a3251'), wall: parede(neonP), rugs: [rugP] },
        lounge: { floor: carpete('#252c48'), wall: parede(neonS), rugs: [rugS, rugP] },
        restroom: { floor: carpete('#2a3251'), wall: parede(neonS), rugs: [rugP] },
        corridor: { floor: carpete('#1f2540'), rugs: [rugP] },
      };
    }
    default:
      return {};
  }
}

/**
 * O que vale em cada área: o estilo e, por cima, as cores escolhidas, usadas como foram escolhidas. A principal
 * pinta o piso (que vira carpete, o piso que aceita qualquer cor) e as paredes de todas as áreas; a de apoio, os
 * tapetes e os frisos.
 */
export function coreLooks(style: OfficeStyleId | undefined, colors?: OfficeColors): CoreLooks {
  const base = styleLooks(style);
  const p = colors?.primary;
  const s = colors?.secondary;
  if (!p && !s) return base;
  const out: CoreLooks = {};
  for (const kind of AREAS) {
    const look = base[kind] ?? {};
    out[kind] = {
      ...look,
      ...(p ? { floor: carpete(p) } : {}),
      ...(p || s ? { wall: p || look.wall ? { base: p ? mix(p, '#ffffff', 0.1) : look.wall!.base, trim: s ?? look.wall?.trim, pattern: look.wall?.pattern ?? 'plain' } : undefined } : {}),
      ...(s ? { rugs: [s] } : {}),
    };
    if (!out[kind]!.wall) delete out[kind]!.wall;
  }
  return out;
}

/** A área com o estilo geral aplicado (uma cópia; os móveis, os lugares e os ids são os mesmos). */
export function styleCoreArea(area: AreaLayout, style: OfficeStyleId | undefined, colors?: OfficeColors): AreaLayout {
  const look = coreLooks(style, colors)[area.kind];
  if (!look) return area;
  const rugs = look.rugs;
  return {
    ...area,
    floors: look.floor ? area.floors.map((f) => ({ ...f, kind: look.floor!.kind, tint: look.floor!.tint, tint2: look.floor!.tint2 })) : area.floors,
    walls: look.wall ? area.walls.map((w) => (w.style.pattern === 'glass' ? w : { ...w, style: { ...w.style, ...look.wall } })) : area.walls,
    rugs: rugs?.length ? area.rugs.map((r, i) => ({ ...r, color: rugs[Math.min(i, rugs.length - 1)] })) : area.rugs,
  };
}
