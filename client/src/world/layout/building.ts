// Montagem do prédio: núcleo + corredor + salas de projeto -> grade de caminhabilidade e spots.
import { FURNITURE } from '../../art/api';
import { BUILDING_H, COL_W } from '../constants';
import { BLOCKED, FREE, SEAT, WalkGrid } from '../path/grid';
import { furnitureBlocks, furnitureIsSeat } from './builder';
import { layoutCafe, layoutLounge, layoutReception, layoutRestroom } from './core';
import type { OfficeColors, OfficeStyleId } from '../../../../shared/roomstyle';
import { styleCoreArea } from './corestyle';
import { layoutCorridor } from './corridor';
import { buildingRect } from './geometry';
import type { AreaLayout, SpotDef, TileRect } from './types';

export interface BuildingLayout {
  cols: number;
  rect: TileRect;
  core: AreaLayout[];
  corridor: AreaLayout;
  rooms: AreaLayout[];
  grid: WalkGrid;
  spots: SpotDef[];
}

let coreCache: AreaLayout[] | null = null;
const styledCore = new Map<string, AreaLayout[]>();

/**
 * Áreas fixas do núcleo (calculadas uma vez). Com `style` (e as cores escolhidas), no estilo geral do escritório
 * (corestyle.ts); cada combinação é montada uma vez.
 */
export function coreAreas(style?: OfficeStyleId, colors?: OfficeColors): AreaLayout[] {
  const base = (coreCache ??= [layoutReception(), layoutRestroom(), layoutCafe(), layoutLounge()]);
  if ((!style || style === 'classico') && !colors?.primary && !colors?.secondary) return base;
  const chave = `${style ?? 'classico'}|${colors?.primary ?? ''}|${colors?.secondary ?? ''}`;
  let feito = styledCore.get(chave);
  if (!feito) {
    // Poucas combinações ficam guardadas: quem arrasta o seletor de cores gera muitas.
    if (styledCore.size > 24) styledCore.clear();
    styledCore.set(chave, (feito = base.map((a) => styleCoreArea(a, style, colors))));
  }
  return feito;
}

/** Marca na grade as células caminháveis de uma área, os bloqueios e os assentos. */
export function paintArea(grid: WalkGrid, area: AreaLayout): void {
  for (const r of area.walkable) grid.fill(r.x, r.y, r.w, r.h, FREE);
  for (const r of area.blocked ?? []) grid.fill(r.x, r.y, r.w, r.h, BLOCKED);
  for (const f of area.furniture) {
    const def = FURNITURE[f.kind];
    if (def.mount !== 'floor') continue;
    const { w, h } = def.footprint;
    if (furnitureBlocks(f.kind)) grid.fill(f.tx, f.ty, w, h, BLOCKED);
    else if (furnitureIsSeat(f.kind)) {
      for (let y = f.ty; y < f.ty + h; y++) for (let x = f.tx; x < f.tx + w; x++) if (grid.get(x, y) === FREE) grid.set(x, y, SEAT);
    }
  }
}

export function buildWalkGrid(cols: number, areas: readonly AreaLayout[], version = 0): WalkGrid {
  const grid = new WalkGrid(cols * COL_W, BUILDING_H, version);
  for (const a of areas) paintArea(grid, a);
  return grid;
}

export function assembleBuilding(cols: number, rooms: readonly AreaLayout[], version = 0, style?: OfficeStyleId, colors?: OfficeColors): BuildingLayout {
  const core = coreAreas(style, colors);
  const corridor = styleCoreArea(layoutCorridor(cols), style, colors);
  const all = [...core, corridor, ...rooms];
  const grid = buildWalkGrid(cols, all, version);
  const spots: SpotDef[] = [];
  for (const a of all) spots.push(...a.spots);
  return { cols, rect: buildingRect(cols), core, corridor, rooms: [...rooms], grid, spots };
}
