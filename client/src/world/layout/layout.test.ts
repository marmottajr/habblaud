import { describe, expect, it } from 'vitest';
import { LAYOUT_DESKS, ROOM_LAYOUTS } from '../../../../shared/roomstyle';
import { FURNITURE, TILE, type FurnitureKind, type RoomTheme } from '../../art/api';
import { BUILDING_H, COL_W, CORRIDOR_Y, SOUTH_Y } from '../constants';
import { assembleBuilding, coreAreas } from './building';
import { columnsFor, slotAt, slotColumn, slotRect, slotSide } from './geometry';
import { coreLooks, styleCoreArea } from './corestyle';
import { layoutCorridor } from './corridor';
import { formalVariant, layoutProjectRoom, roomVariant, styledVariant } from './room';
import { layoutExterior, slotShell } from './exterior';
import { RECEPTION_ID } from './core';
import type { AreaLayout } from './types';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

function roomsFor(slots: number[]): AreaLayout[] {
  return slots.map((slot) => layoutProjectRoom({ id: `/proj/${slot}`, slot, seed: 1000 + slot * 77 }, theme));
}

describe('mapeamento de slots', () => {
  it('coluna = núcleo + floor(slot/2); par = norte, ímpar = sul', () => {
    expect(slotColumn(0)).toBe(2);
    expect(slotColumn(1)).toBe(2);
    expect(slotColumn(2)).toBe(3);
    expect(slotColumn(7)).toBe(5);
    expect(slotSide(0)).toBe('north');
    expect(slotSide(1)).toBe('south');
    expect(slotSide(6)).toBe('north');
    expect(slotAt(3, 'south')).toBe(3);
    expect(slotAt(slotColumn(9), slotSide(9))).toBe(9);
  });

  it('retângulos das salas não se sobrepõem e respeitam o corredor', () => {
    const a = slotRect(0);
    const b = slotRect(1);
    expect(a).toEqual({ x: 2 * COL_W, y: 0, w: COL_W, h: 12 });
    expect(b.y).toBe(SOUTH_Y);
    expect(a.y + a.h).toBe(CORRIDOR_Y);
    expect(b.y + b.h).toBe(BUILDING_H);
  });

  it('largura do prédio: núcleo + maior coluna usada + 1 (mínimo 1 coluna de projeto)', () => {
    expect(columnsFor([])).toBe(3);
    expect(columnsFor([0, 1])).toBe(3);
    expect(columnsFor([5])).toBe(5);
    expect(columnsFor([2, 11])).toBe(8);
  });
});

describe('layout do prédio', () => {
  const slots = [0, 1, 2, 3, 4, 7];
  const rooms = roomsFor(slots);
  const cols = columnsFor(slots);
  const b = assembleBuilding(cols, rooms);
  const reception = coreAreas().find((a) => a.id === RECEPTION_ID)!;
  const elevator = reception.spots.find((s) => s.kind === 'elevator')!;
  const reach = b.grid.reachableFrom(elevator.tx, elevator.ty);
  const reachable = (x: number, y: number) => reach[y * b.grid.w + x] === 1;

  it('há dois elevadores com tiles de aproximação caminháveis', () => {
    const elevators = reception.spots.filter((s) => s.kind === 'elevator');
    expect(elevators).toHaveLength(2);
    for (const e of elevators) expect(b.grid.walkable(e.tx, e.ty)).toBe(true);
  });

  it('todos os spots são alcançáveis a partir dos elevadores', () => {
    const unreachable = b.spots.filter((s) => !reachable(s.tx, s.ty)).map((s) => s.id);
    expect(unreachable).toEqual([]);
  });

  it('as portas conectam cada sala ao corredor', () => {
    for (const room of rooms) {
      const door = room.door!;
      expect(door).toBeDefined();
      for (let x = door.x; x < door.x + door.w; x++) {
        for (let y = door.y; y < door.y + door.h; y++) expect(b.grid.walkable(x, y)).toBe(true);
        // tile do corredor imediatamente fora da porta
        const outside = room.side === 'north' ? door.y + door.h : door.y - 1;
        expect(outside >= CORRIDOR_Y && outside < SOUTH_Y).toBe(true);
        expect(reachable(x, outside)).toBe(true);
      }
      // o interior inteiro (fora móveis) é alcançável
      const r = room.rect;
      for (let y = r.y + 2; y < r.y + 11; y++)
        for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(reachable(x, y)).toBe(true);
    }
  });

  it('cada sala tem 6 mesas, ao menos 4 lugares extras sentados, interruptor e quadro', () => {
    for (const room of rooms) {
      const desks = room.spots.filter((s) => s.kind === 'desk');
      expect(desks).toHaveLength(6);
      expect(new Set(desks.map((d) => d.rank))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      expect(desks.filter((d) => d.side === 'N')).toHaveLength(3);
      expect(room.spots.filter((s) => s.kind === 'stool' || s.kind === 'nook').length).toBeGreaterThanOrEqual(4);
      expect(room.spots.filter((s) => s.kind === 'stand').length).toBeGreaterThanOrEqual(3);
      expect(room.spots.filter((s) => s.kind === 'switch')).toHaveLength(1);
      expect(room.wallItems.some((w) => w.kind === 'whiteboard')).toBe(true);
      expect(room.wallItems.some((w) => w.kind === 'sign')).toBe(true);
      expect(room.wallItems.some((w) => w.kind === 'light_switch')).toBe(true);
      for (const d of desks) expect(room.furniture.some((f) => f.id === d.deskId)).toBe(true);
    }
  });

  it('móveis bloqueantes não se sobrepõem e ficam dentro da área', () => {
    for (const area of [...b.core, b.corridor, ...rooms]) {
      const used = new Map<string, string>();
      for (const f of area.furniture) {
        const def = FURNITURE[f.kind];
        expect(def.mount).toBe('floor');
        for (let y = f.ty; y < f.ty + def.footprint.h; y++) {
          for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
            expect(x >= area.rect.x && x < area.rect.x + area.rect.w && y >= area.rect.y && y < area.rect.y + area.rect.h).toBe(true);
            const key = `${x},${y}`;
            if (def.blocks) {
              expect(used.get(key), `${f.id} sobre ${used.get(key)}`).toBeUndefined();
              used.set(key, f.id);
            }
          }
        }
      }
      for (const w of area.wallItems) expect(FURNITURE[w.kind].mount).toBe('wall');
    }
  });

  it('spots têm ids únicos', () => {
    const ids = b.spots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pontos de conversa e ping-pong vêm em pares', () => {
    const groups = new Map<string, number>();
    for (const s of b.spots) if (s.group && (s.kind === 'talk' || s.kind === 'pingpong')) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
    for (const [, n] of groups) expect(n).toBe(2);
  });

  it('corredor alterna bebedouro e banco nas colunas de projeto, sem excesso de plantas', () => {
    const coolers = b.corridor.furniture.filter((f) => f.kind === 'water_cooler');
    expect(coolers.length).toBeGreaterThanOrEqual(Math.ceil((cols - 2) / 2));
    const benches = b.corridor.furniture.filter((f) => f.kind === 'bench');
    expect(benches.length).toBeGreaterThanOrEqual(Math.floor((cols - 2) / 2));
    const plants = b.corridor.furniture.filter((f) => f.kind === 'plant_tall' || f.kind === 'plant_small');
    expect(plants.length).toBeLessThanOrEqual(cols * 2);
  });

  it('a área externa e os pátios cobrem o prédio', () => {
    const ext = layoutExterior(cols);
    expect(ext.bounds.x).toBeLessThan(0);
    expect(ext.bounds.x + ext.bounds.w).toBeGreaterThan(cols * COL_W);
    const shell = slotShell(5, true);
    expect(shell.walls.length).toBeGreaterThan(0);
    expect(shell.props.every((p) => p.slot === 5)).toBe(true);
  });
});

/** Móveis de chão altos que escondem o que está pendurado na parede logo atrás. */
const TALL_FLOOR = new Set<FurnitureKind>(['plant_tall', 'bookshelf', 'binder_shelf', 'fridge', 'vending_machine', 'arcade', 'water_cooler', 'floor_lamp', 'toilet_stall']);
const WALL_DECOR = new Set<FurnitureKind>(['painting', 'poster', 'window', 'tv', 'whiteboard', 'sign', 'clock', 'mirror', 'door_frame']);

/** Itens de parede decorativos com algum móvel alto encostado na frente (ids). */
function hiddenWallItems(area: AreaLayout): string[] {
  const out: string[] = [];
  for (const w of area.wallItems) {
    if (w.on !== 'face' || !WALL_DECOR.has(w.kind)) continue;
    const half = (FURNITURE[w.kind].footprint.w * TILE) / 2 - 2;
    const wy = w.baseY / TILE;
    for (const f of area.furniture) {
      if (!TALL_FLOOR.has(f.kind) || f.ty !== wy) continue;
      const fx0 = f.tx * TILE + (f.dx ?? 0);
      const fx1 = fx0 + FURNITURE[f.kind].footprint.w * TILE;
      if (fx0 < w.cx + half && fx1 > w.cx - half) out.push(`${w.id} atrás de ${f.id}`);
    }
  }
  return out;
}

describe('variações das salas de projeto', () => {
  const seeds = Array.from({ length: 90 }, (_, i) => (i * 7919 + 13) >>> 0);

  it('toda variação é válida: sem sobreposição, tudo alcançável, lugares suficientes', () => {
    for (const slot of [0, 1]) {
      for (const seed of seeds) {
        const room = layoutProjectRoom({ id: `/v/${seed}`, slot, seed }, theme);
        const b = assembleBuilding(columnsFor([slot]), [room]);
        const used = new Map<string, string>();
        for (const f of room.furniture) {
          const def = FURNITURE[f.kind];
          for (let y = f.ty; y < f.ty + def.footprint.h; y++)
            for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
              expect(x >= room.rect.x + 1 && x < room.rect.x + 15 && y >= room.rect.y + 2 && y < room.rect.y + 11, `${f.id} fora do piso`).toBe(true);
              if (!def.blocks) continue;
              expect(used.get(`${x},${y}`), `${f.id} sobre ${used.get(`${x},${y}`)}`).toBeUndefined();
              used.set(`${x},${y}`, f.id);
            }
        }
        const door = room.door!;
        const reach = b.grid.reachableFrom(door.x, door.y);
        for (const sp of room.spots) expect(reach[sp.ty * b.grid.w + sp.tx], `${sp.id} inalcançável (semente ${seed})`).toBe(1);
        const r = room.rect;
        for (let y = r.y + 2; y < r.y + 11; y++)
          for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(reach[y * b.grid.w + x], `tile ${x},${y} isolado (semente ${seed})`).toBe(1);
        expect(room.spots.filter((sp) => sp.kind === 'desk')).toHaveLength(6);
        expect(room.spots.filter((sp) => sp.kind === 'stool' || sp.kind === 'nook').length).toBeGreaterThanOrEqual(4);
        // spots de uso não podem cair em cima de móvel que bloqueia
        for (const sp of room.spots) expect(b.grid.walkable(sp.tx, sp.ty), `${sp.id} sobre móvel`).toBe(true);
        expect(hiddenWallItems(room)).toEqual([]);
      }
    }
  });

  it('as salas não são todas iguais: espelhamento, canto de reunião e cantos variam', () => {
    const vs = seeds.map(roomVariant);
    expect(new Set(vs.map((v) => v.mirror)).size).toBe(2);
    expect(new Set(vs.map((v) => v.meeting)).size).toBe(3);
    expect(new Set(vs.map((v) => v.left)).size).toBeGreaterThan(1);
    expect(new Set(vs.map((v) => v.right)).size).toBeGreaterThan(1);
    // o piso é porcelanato (azulejo é do banheiro) com um leve tom da sala
    const room = layoutProjectRoom({ id: '/v/x', slot: 0, seed: 42 }, theme);
    expect(room.floors.every((f) => f.kind !== 'tile_white')).toBe(true);
    expect(room.floorTint).toBe(theme.carpet);
  });
});

describe('itens de parede', () => {
  it('quadros, janelas, TV, placas e espelhos não ficam atrás de móveis altos', () => {
    for (const area of [...coreAreas(), ...roomsFor([0, 1, 2, 3, 4, 7])]) expect(hiddenWallItems(area), area.id).toEqual([]);
  });

  it('passagens nas faces das paredes têm batente', () => {
    const restroom = coreAreas().find((a) => a.kind === 'restroom')!;
    expect(restroom.wallItems.some((w) => w.kind === 'door_frame')).toBe(true);
    for (const room of roomsFor([1, 3, 7])) expect(room.wallItems.some((w) => w.kind === 'door_frame'), room.id).toBe(true);
  });
});

describe('layouts prontos (a aparência escolhida para a sala)', () => {
  const layouts = ROOM_LAYOUTS;

  it('todo layout é válido nos dois lados do corredor e nos dois lados da ilha: nada sobreposto, tudo alcançável', () => {
    for (const layout of layouts) {
      for (const slot of [0, 1]) {
        for (const mirror of [false, true]) {
          const room = layoutProjectRoom({ id: `/l/${layout}`, slot, seed: 4242, style: { layout, mirror } }, theme);
          const b = assembleBuilding(columnsFor([slot]), [room]);
          const onde = `${layout}, vaga ${slot}, ${mirror ? 'invertido' : 'normal'}`;
          const used = new Map<string, string>();
          for (const f of room.furniture) {
            const def = FURNITURE[f.kind];
            for (let y = f.ty; y < f.ty + def.footprint.h; y++)
              for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
                expect(x >= room.rect.x + 1 && x < room.rect.x + 15 && y >= room.rect.y + 2 && y < room.rect.y + 11, `${f.id} fora do piso (${onde})`).toBe(true);
                if (!def.blocks) continue;
                expect(used.get(`${x},${y}`), `${f.id} sobre ${used.get(`${x},${y}`)} (${onde})`).toBeUndefined();
                used.set(`${x},${y}`, f.id);
              }
          }
          const door = room.door!;
          const reach = b.grid.reachableFrom(door.x, door.y);
          for (const sp of room.spots) {
            expect(reach[sp.ty * b.grid.w + sp.tx], `${sp.id} inalcançável (${onde})`).toBe(1);
            expect(b.grid.walkable(sp.tx, sp.ty), `${sp.id} sobre móvel (${onde})`).toBe(true);
          }
          const r = room.rect;
          for (let y = r.y + 2; y < r.y + 11; y++) for (let x = r.x + 1; x < r.x + 15; x++) if (b.grid.walkable(x, y)) expect(reach[y * b.grid.w + x], `tile ${x},${y} isolado (${onde})`).toBe(1);
          expect(new Set(room.spots.map((sp) => sp.id)).size).toBe(room.spots.length);
          // as mesas de cada layout são o teto do limite de agentes da sala (LAYOUT_DESKS); na sala de reunião os
          // lugares são as doze cadeiras em volta da mesa
          const lugares = room.spots.filter((sp) => sp.kind === (layout === 'conferencia' ? 'stool' : 'desk'));
          expect(lugares, onde).toHaveLength(LAYOUT_DESKS[layout]);
          expect(new Set(lugares.map((sp) => sp.rank)).size, onde).toBe(layout === 'conferencia' ? 1 : lugares.length);
          // lugares extras (subagentes): com doze mesas na sala de equipe, bastam os dois do canto de descanso
          expect(room.spots.filter((sp) => sp.kind === 'stool' || sp.kind === 'nook').length).toBeGreaterThanOrEqual(layout === 'equipe' ? 2 : 4);
          expect(hiddenWallItems(room), onde).toEqual([]);
        }
      }
    }
  });

  it('cada layout fixa a reunião e os cantos; o lado da ilha é o escolhido, ou o sorteado', () => {
    expect(styledVariant(42, { layout: 'equipe' })).toMatchObject({ meeting: 'table', left: 'rest', right: 'standdesk', solo: false });
    expect(styledVariant(42, { layout: 'criativo' })).toMatchObject({ meeting: 'lounge', solo: false });
    expect(styledVariant(42, { layout: 'reunioes' })).toMatchObject({ meeting: 'round', solo: false });
    expect(styledVariant(42, { layout: 'operacao' })).toMatchObject({ meeting: 'table', left: 'print', right: 'stands' });
    expect(styledVariant(42, { layout: 'individual' })).toMatchObject({ meeting: 'board', left: 'wait', right: 'print', solo: true });
    expect(styledVariant(42, { layout: 'equipe' }).mirror).toBe(roomVariant(42).mirror);
    expect(styledVariant(42, { mirror: !roomVariant(42).mirror }).mirror).toBe(!roomVariant(42).mirror);
    // Sem escolha, é o sorteio de sempre.
    expect(styledVariant(42)).toEqual(roomVariant(42));
    expect(styledVariant(42, { color: 3 })).toEqual(roomVariant(42));
  });

  it('a sala individual tem uma mesa executiva só (peça única de quatro quadrados), com o lugar no meio, de frente para quem entra, e duas cadeiras de visita', () => {
    const room = layoutProjectRoom({ id: '/l/dono', slot: 0, seed: 7, style: { layout: 'individual', mirror: false } }, theme);
    const mesas = room.furniture.filter((f) => f.kind === 'desk' || f.kind === 'desk_back' || f.kind === 'desk_exec');
    expect(mesas.map((f) => f.kind)).toEqual(['desk_exec']);
    expect(FURNITURE.desk_exec.footprint).toEqual({ w: 4, h: 1 });
    // um lugar só, no meio da mesa (também com a sala invertida)
    const lugar = room.spots.filter((sp) => sp.kind === 'desk');
    expect(lugar).toHaveLength(1);
    expect(lugar[0].x).toBe((mesas[0].tx + 2) * TILE);
    expect(lugar[0].deskId).toBe(mesas[0].id);
    const invertida = layoutProjectRoom({ id: '/l/dono', slot: 0, seed: 7, style: { layout: 'individual', mirror: true } }, theme);
    const mesaInv = invertida.furniture.find((f) => f.kind === 'desk_exec')!;
    expect(invertida.spots.find((sp) => sp.kind === 'desk')!.x).toBe((mesaInv.tx + 2) * TILE);
    expect(room.furniture.filter((f) => f.kind === 'office_chair_front')).toHaveLength(3); // a do dono e duas na mesa de reunião
    // as visitas sentam em cadeiras de escritório, de frente para a mesa; outras duas ficam na mesa de reunião
    expect(room.furniture.filter((f) => f.kind === 'office_chair')).toHaveLength(4);
    expect(room.furniture.filter((f) => f.kind === 'cafe_chair')).toHaveLength(0);
    // sala corporativa: mesa de reunião, sem puffs e sem pôster
    expect(room.furniture.filter((f) => f.kind === 'meeting_table')).toHaveLength(1);
    expect(room.furniture.filter((f) => f.kind === 'beanbag')).toHaveLength(0);
    expect(room.wallItems.filter((w) => w.kind === 'poster')).toHaveLength(0);
    expect(room.spots.find((sp) => sp.kind === 'desk')?.dir).toBe('down');
  });

  it('o piso da sala é o do estilo: porcelanato com um tom da sala, madeira, cimento ou carpete na cor do estilo', () => {
    const sala = (t: RoomTheme) => layoutProjectRoom({ id: '/l/piso', slot: 0, seed: 5 }, t);
    expect(sala(theme).floors[0].kind).toBe('marble');
    expect(sala(theme).floorTint).toBe(theme.carpet);
    expect(sala({ ...theme, floor: 'wood' }).floors[0].kind).toBe('wood');
    expect(sala({ ...theme, floor: 'concrete' }).floors[0]).toMatchObject({ kind: 'concrete' });
    const carpete = sala({ ...theme, floor: 'carpet', floorColor: '#3b4150' });
    expect(carpete.floors[0]).toMatchObject({ kind: 'carpet', tint: '#3b4150' });
    // O carpete já tem a cor dele: não leva o tom por cima.
    expect(carpete.floorTint).toBeUndefined();
  });

  it('sala formal (estilos Corporativo e Executivo): cadeiras de escritório na reunião, poltronas no lugar dos puffs, sem pôster', () => {
    const formalTheme: RoomTheme = { ...theme, formal: true };
    expect(formalVariant({ mirror: false, meeting: 'table', left: 'rest', right: 'standdesk', solo: false })).toMatchObject({ meeting: 'board', left: 'green', right: 'standdesk' });
    expect(formalVariant({ mirror: true, meeting: 'round', left: 'print', right: 'stands', solo: false })).toMatchObject({ meeting: 'board', left: 'print', mirror: true });
    expect(formalVariant({ mirror: false, meeting: 'lounge', left: 'green', right: 'green', solo: false }).meeting).toBe('lounge');
    for (const slot of [0, 1]) {
      for (let seed = 1; seed <= 40; seed++) {
        const room = layoutProjectRoom({ id: `/f/${seed}`, slot, seed: (seed * 7919 + 13) >>> 0 }, formalTheme);
        const b = assembleBuilding(columnsFor([slot]), [room]);
        const onde = `semente ${seed}, vaga ${slot}`;
        expect(room.furniture.filter((f) => f.kind === 'beanbag'), onde).toHaveLength(0);
        expect(room.furniture.filter((f) => f.kind === 'stool'), onde).toHaveLength(0);
        expect(room.wallItems.filter((w) => w.kind === 'poster'), onde).toHaveLength(0);
        expect(room.spots.filter((sp) => sp.kind === 'desk'), onde).toHaveLength(6);
        expect(room.spots.filter((sp) => sp.kind === 'stool' || sp.kind === 'nook').length, onde).toBeGreaterThanOrEqual(4);
        const used = new Map<string, string>();
        for (const f of room.furniture) {
          const def = FURNITURE[f.kind];
          if (!def.blocks) continue;
          for (let y = f.ty; y < f.ty + def.footprint.h; y++)
            for (let x = f.tx; x < f.tx + def.footprint.w; x++) {
              expect(used.get(`${x},${y}`), `${f.id} sobre ${used.get(`${x},${y}`)} (${onde})`).toBeUndefined();
              used.set(`${x},${y}`, f.id);
            }
        }
        const reach = b.grid.reachableFrom(room.door!.x, room.door!.y);
        for (const sp of room.spots) expect(reach[sp.ty * b.grid.w + sp.tx], `${sp.id} inalcançável (${onde})`).toBe(1);
      }
    }
  });

  it('a sala de reunião (layout Conferência) tem uma mesa inteiriça com doze cadeiras, sem ilha de mesas nem pôster', () => {
    for (const slot of [0, 1]) {
      const room = layoutProjectRoom({ id: '/l/reuniao', slot, seed: 9, style: { layout: 'conferencia' } }, theme);
      expect(room.furniture.filter((f) => f.kind === 'conference_table')).toHaveLength(1);
      expect(FURNITURE.conference_table.footprint).toEqual({ w: 6, h: 2 });
      expect(room.furniture.filter((f) => f.kind === 'office_chair' || f.kind === 'office_chair_front')).toHaveLength(12);
      expect(room.spots.filter((sp) => sp.kind === 'stool')).toHaveLength(12);
      expect(room.furniture.filter((f) => f.kind === 'desk' || f.kind === 'desk_back' || f.kind === 'meeting_table')).toHaveLength(0);
      expect(room.wallItems.filter((w) => w.kind === 'poster')).toHaveLength(0);
      // um tapete só no meio (o da mesa), mais o da entrada
      expect(room.rugs.length).toBe(2);
    }
  });

  it('a sala individual tem um sofá de espera de três lugares', () => {
    const room = layoutProjectRoom({ id: '/l/dono', slot: 1, seed: 7, style: { layout: 'individual' } }, theme);
    const sofa = room.furniture.filter((f) => f.kind === 'sofa');
    expect(sofa).toHaveLength(1);
    expect(room.spots.filter((sp) => sp.furnitureId === sofa[0].id)).toHaveLength(3);
  });
});

describe('estilo geral do escritório nas áreas comuns', () => {
  it('o clássico (e nenhum estilo) devolve as áreas como são', () => {
    for (const a of coreAreas()) {
      expect(styleCoreArea(a, 'classico')).toBe(a);
      expect(styleCoreArea(a, undefined)).toBe(a);
    }
    expect(coreAreas('classico')).toBe(coreAreas());
  });

  it('os outros estilos trocam piso, parede e tapetes, e deixam móveis, lugares e ids iguais', () => {
    for (const estilo of ['corporativo', 'moderno', 'futurista'] as const) {
      const antes = coreAreas();
      const depois = coreAreas(estilo);
      // A mesma lista é reaproveitada a cada montagem do prédio.
      expect(coreAreas(estilo)).toBe(depois);
      antes.forEach((a, i) => {
        const d = depois[i];
        expect(d.id).toBe(a.id);
        expect(d.furniture).toBe(a.furniture);
        expect(d.spots).toBe(a.spots);
        expect(d.walkable).toBe(a.walkable);
        expect(d.walls).toHaveLength(a.walls.length);
        expect(d.rugs).toHaveLength(a.rugs.length);
        const look = coreLooks(estilo)[a.kind];
        if (!look) return void expect(d).toBe(a);
        if (look.floor) for (const f of d.floors) expect(f.kind).toBe(look.floor.kind);
        if (look.wall) {
          // As paredes de vidro continuam de vidro; as outras levam o acabamento do estilo.
          d.walls.forEach((w, k) => {
            if (a.walls[k].style.pattern === 'glass') expect(w.style.pattern).toBe('glass');
            else expect(w.style).toMatchObject(look.wall!);
          });
        }
        if (look.rugs) for (const r of d.rugs) expect(look.rugs).toContain(r.color);
      });
      // O banheiro entra no estilo (parede e tapete), com os mesmos móveis e lugares.
      expect(depois.find((a) => a.kind === 'restroom')).not.toBe(antes.find((a) => a.kind === 'restroom'));
      // O corredor acompanha, e o prédio montado no estilo continua todo alcançável.
      const corredor = styleCoreArea(layoutCorridor(3), estilo);
      expect(corredor.spots).toHaveLength(layoutCorridor(3).spots.length);
      const b = assembleBuilding(3, roomsFor([0, 1]), 0, estilo);
      expect(b.core).toBe(depois);
      expect(b.spots.length).toBe(assembleBuilding(3, roomsFor([0, 1])).spots.length);
    }
  });

  it('as cores escolhidas valem em todas as áreas comuns, como escolhidas: a principal no piso e nas paredes, a de apoio nos tapetes e frisos', () => {
    const cores = { primary: '#000000', secondary: '#33aa77' };
    for (const estilo of ['classico', 'corporativo', 'moderno', 'futurista'] as const) {
      const areas = coreAreas(estilo, cores);
      for (const a of areas) {
        for (const f of a.floors) expect(f, `${estilo} ${a.kind}`).toMatchObject({ kind: 'carpet', tint: '#000000' });
        for (const r of a.rugs) expect(r.color, `${estilo} ${a.kind}`).toBe('#33aa77');
        for (const w of a.walls) if (w.style.pattern !== 'glass') expect(w.style.trim, `${estilo} ${a.kind}`).toBe('#33aa77');
      }
      // O corredor também, e os móveis e lugares não mudam.
      const corredor = styleCoreArea(layoutCorridor(3), estilo, cores);
      expect(corredor.floors[0]).toMatchObject({ kind: 'carpet', tint: '#000000' });
      expect(areas.map((a) => a.spots.length)).toEqual(coreAreas().map((a) => a.spots.length));
    }
    // Só a de apoio: o piso e a parede continuam os do estilo.
    const soApoio = coreAreas('moderno', { secondary: '#33aa77' }).find((a) => a.kind === 'reception')!;
    const moderno = coreAreas('moderno').find((a) => a.kind === 'reception')!;
    expect(soApoio.floors[0].kind).toBe(moderno.floors[0].kind);
    expect(soApoio.rugs.every((r) => r.color === '#33aa77')).toBe(true);
    // Sem cores, o clássico é o original; a mesma combinação é montada uma vez só.
    expect(coreAreas('classico', {})).toBe(coreAreas());
    expect(coreAreas('moderno', cores)).toBe(coreAreas('moderno', { ...cores }));
  });
});
