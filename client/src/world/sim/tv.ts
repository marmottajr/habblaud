// Plateia da TV das salas (apresentações; shared/presentation.ts), lado da simulação: enquanto uma apresentação está
// aberta na tela (ui/tv.ts chama WorldApi.setTvAudience), os personagens daquela sala que estão disponíveis (trabalhando,
// à toa ou esperando um shell; nunca quem levantou a mão para você) vão para a frente da TV, viram para ela e
// assistem, com uma reação de vez em quando. Ao fechar, cada um volta ao que fazia. Só visual: nada muda nos agentes.
import type { Dir } from '../../art/api';
import { TILE } from '../constants';
import { FREE } from '../path/grid';
import type { Character } from './character';
import { canParty } from './party';
import type { Sim } from './sim';
import type { Step } from './steps';

const REACTIONS = ['👀', '🍿', '👏', '🤔', '💡', '👍'];

interface Tile {
  x: number;
  y: number;
}

/**
 * Lugares da plateia em ordem de preferência: os tiles livres da sala (sem móvel, assento nem tile de aproximação de
 * algum lugar), das primeiras fileiras em frente à TV para trás, os mais perto do meio da TV primeiro. Puro, testável.
 */
export function audienceTiles(
  grid: { w: number; get(x: number, y: number): number },
  rect: { x: number; y: number; w: number; h: number },
  tvTileX: number,
  spotTiles: ReadonlySet<number>,
  rows = 4,
): Tile[] {
  const out: { x: number; y: number; cost: number }[] = [];
  for (let y = rect.y + 2; y < Math.min(rect.y + 2 + rows, rect.y + rect.h - 1); y++) {
    for (let x = rect.x + 1; x < rect.x + rect.w - 1; x++) {
      if (grid.get(x, y) !== FREE || spotTiles.has(y * grid.w + x)) continue;
      const dx = Math.abs(x - tvTileX);
      if (dx > 4) continue;
      // a primeira fileira (colada na parede) fica para trás: de lá a TV fica em cima da cabeça
      const row = y - (rect.y + 2);
      out.push({ x, y, cost: dx * 2 + (row === 0 ? 5 : row) });
    }
  }
  return out.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x).map(({ x, y }) => ({ x, y }));
}

export class TvAudience {
  /** Sala com a apresentação aberta, ou null. */
  roomId: string | null = null;
  private readonly spot = new Map<string, Tile>();
  private tiles: Tile[] | null = null;
  private tilesFor = '';

  /** Abre (sala) ou fecha (null) a plateia: quem vai interrompe o que fazia; ao fechar, todos voltam. */
  set(sim: Sim, roomId: string | null): void {
    if (roomId === this.roomId) return;
    const watchers = [...this.spot.keys()];
    this.roomId = roomId;
    this.spot.clear();
    this.tiles = null;
    this.tilesFor = '';
    for (const id of watchers) {
      const ch = sim.chars.get(id);
      if (ch) sim.interrupt(ch);
    }
    if (!roomId) return;
    for (const ch of sim.chars.values()) if (ch.roomId === roomId && canParty(ch)) sim.interrupt(ch);
  }

  /** O prédio mudou (sala nova, mudança de vaga): os lugares são refeitos e a plateia replaneja. */
  update(sim: Sim): void {
    if (!this.roomId) return;
    const room = sim.rooms.get(this.roomId);
    if (!room || !room.present || room.phase === 'dismantling') {
      this.set(sim, null);
      return;
    }
    const tag = `${this.roomId}|${sim.layoutVersion}`;
    if (this.tilesFor === tag) return;
    const first = this.tilesFor === '';
    this.tilesFor = tag;
    this.tiles = null;
    if (first) return;
    const watchers = [...this.spot.keys()];
    this.spot.clear();
    for (const id of watchers) {
      const ch = sim.chars.get(id);
      if (ch) sim.interrupt(ch);
    }
  }

  /** Plano de `ch` (depois da festa, antes do resto): ir até o lugar dele em frente à TV ou continuar assistindo. */
  plan(sim: Sim, ch: Character, now: number): boolean {
    const roomId = this.roomId;
    if (!roomId || ch.roomId !== roomId || !canParty(ch)) return false;
    const room = sim.rooms.get(roomId);
    if (!room || !room.present || room.phase === 'dismantling') return false;
    const tile = this.tileOf(sim, ch);
    if (!tile) return false;
    const dir: Dir = 'up';
    const steps: Step[] = [];
    if (ch.atSpot) steps.push({ t: 'exit' });
    if (ch.atSpot || ch.tx !== tile.x || ch.ty !== tile.y) {
      steps.push({ t: 'go', tx: tile.x, ty: tile.y, dir }, { t: 'do', fn: () => (ch.arriving = false) });
    } else {
      const k = ch.rng();
      if (k < 0.12) steps.push({ t: 'act', pose: 'laugh', ms: 1_400, dir });
      else if (k < 0.24) steps.push({ t: 'act', pose: 'talk', ms: 1_800, dir: ch.rng() < 0.5 ? 'left' : 'right' });
      if (ch.rng() < 0.18) steps.push({ t: 'do', fn: () => ((ch.chatEmoji = REACTIONS[Math.floor(ch.rng() * REACTIONS.length)]), (ch.chatUntil = sim.now + 2_000)) });
    }
    steps.push({ t: 'until', cond: () => this.roomId !== roomId, minMs: 1_500, maxMs: 4_000 + Math.floor(ch.rng() * 6_000), pose: 'stand', dir });
    ch.queue.push(...steps);
    void now;
    return true;
  }

  private tileOf(sim: Sim, ch: Character): Tile | null {
    const mine = this.spot.get(ch.id);
    if (mine) return mine;
    const tiles = this.placesFor(sim);
    const w = sim.building.grid.w;
    const taken = new Set([...this.spot.values()].map((t) => t.y * w + t.x));
    const free = tiles.find((t) => !taken.has(t.y * w + t.x));
    if (!free) return null;
    this.spot.set(ch.id, free);
    return free;
  }

  private placesFor(sim: Sim): Tile[] {
    if (this.tiles) return this.tiles;
    const room = this.roomId ? sim.rooms.get(this.roomId) : undefined;
    const tv = room?.layout.wallItems.find((w) => w.kind === 'tv');
    if (!room || !tv) return (this.tiles = []);
    const grid = sim.building.grid;
    const spotTiles = new Set<number>();
    for (const s of sim.spots.all()) spotTiles.add(s.ty * grid.w + s.tx);
    this.tiles = audienceTiles(grid, room.layout.rect, Math.floor(tv.cx / TILE), spotTiles);
    return this.tiles;
  }
}
