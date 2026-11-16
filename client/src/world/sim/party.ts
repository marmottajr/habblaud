// Festa no escritório (POST /api/party; shared/party.ts), lado da simulação: enquanto o snapshot traz `party`, todos os
// personagens presentes (principais e subagentes) vão para a sala anfitriã, cada um para um lugar livre (sala primeiro,
// depois o corredor), e comemoram em revezamento (pulinhos, risada, papo) com confete; no fim, cada um volta para a
// própria sala e retoma o que fazia. Quem está esperando você (mão levantada), indo embora ou entregando o resultado
// fica de fora. Só visual: o `roomId` dos agentes não muda. A faixa e o confete da sala usam o desenho da festa do
// GitHub (render/github-fx.ts) com o efeito `fx`.
import type { Dir } from '../../art/api';
import type { OfficeParty } from '../../../../shared/types';
import { tr } from '../../../../shared/i18n';
import { TILE } from '../constants';
import { FREE } from '../path/grid';
import { facing, type Character } from './character';
import { PARTY_CHEER_MS, type RoomFx } from './github';
import type { Sim } from './sim';
import type { Step } from './steps';

/** Quantos tiles a busca de lugares percorre a partir do meio da sala (sala inteira e um bom pedaço do corredor). */
const MAX_VISIT = 900;
/** Fora da sala anfitriã (no corredor) só depois de a sala lotar; casas "em xadrez" antes das vizinhas (sem amontoar). */
const OUTSIDE_COST = 10_000;
const CROWD_COST = 1_000;
/** Distância (tiles) a partir da qual o personagem corre para a festa. */
const RUN_FROM = 18;
const PARTY_EMOJIS = ['🎉', '🥳', '🎶', '🎊', '✨'];

interface Tile {
  x: number;
  y: number;
}

/** Os personagens da festa: modos que vão (trabalhando, à toa, esperando um shell) e quem está visível e disponível. */
export function canParty(ch: Pick<Character, 'mode' | 'gone' | 'leaving'>): boolean {
  if (ch.gone || ch.leaving) return false;
  return ch.mode === 'idle' || ch.mode === 'work' || ch.mode === 'shell';
}

/**
 * Lugares da festa em ordem de preferência, a partir de `start` (um tile livre no meio da sala): só tiles livres (nada
 * de móvel nem de assento), sem os de aproximação dos lugares (`spotTiles`, para ninguém bloquear uma mesa), dentro da
 * sala antes do corredor e, em cada um, as casas pares do xadrez antes das vizinhas, do meio para fora. Puro, testável.
 */
export function partyTiles(
  grid: { w: number; h: number; get(x: number, y: number): number },
  rect: { x: number; y: number; w: number; h: number },
  start: Tile,
  spotTiles: ReadonlySet<number>,
  max = MAX_VISIT,
): Tile[] {
  const inRoom = (x: number, y: number) => x > rect.x && x < rect.x + rect.w - 1 && y >= rect.y + 2 && y < rect.y + rect.h - 1;
  const parity = (start.x + start.y) & 1;
  const seen = new Set<number>([start.y * grid.w + start.x]);
  const queue: { x: number; y: number; d: number }[] = [{ ...start, d: 0 }];
  const out: { x: number; y: number; cost: number }[] = [];
  for (let i = 0; i < queue.length && seen.size <= max; i++) {
    const t = queue[i];
    if (!spotTiles.has(t.y * grid.w + t.x)) {
      out.push({ x: t.x, y: t.y, cost: (inRoom(t.x, t.y) ? 0 : OUTSIDE_COST) + (((t.x + t.y) & 1) === parity ? 0 : CROWD_COST) + t.d });
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = t.x + dx;
      const y = t.y + dy;
      const k = y * grid.w + x;
      if (seen.has(k) || grid.get(x, y) !== FREE) continue;
      seen.add(k);
      queue.push({ x, y, d: t.d + 1 });
    }
  }
  return out.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x).map(({ x, y }) => ({ x, y }));
}

/** Festa no escritório: concilia com o snapshot, reserva os lugares e planeja quem vai. */
export class PartyState {
  /** Faixa e confete da sala anfitriã (no relógio do navegador); null = nenhuma festa. */
  fx: RoomFx | null = null;
  /** Lugar de cada convidado (id do personagem -> tile). */
  private readonly spot = new Map<string, Tile>();
  /** Lugares em ordem de preferência (refeitos quando a festa, a anfitriã ou o prédio mudam). */
  private tiles: Tile[] | null = null;
  private tilesFor = '';
  /** Festa que já chamou todo mundo (o `key` dela) e a anfitriã de então. */
  private started: { key: number; roomId: string } | null = null;

  /**
   * Aplica a festa do snapshot. Relógios do servidor e do navegador podem divergir: o que vale é quanto já passou e
   * quanto falta segundo o servidor (`serverTime`), como nos efeitos das salas.
   */
  sync(party: OfficeParty | undefined, serverTime: number, now: number): void {
    if (!party || party.until <= serverTime) {
      if (this.fx) this.fx.end = Math.min(this.fx.end, now);
      return;
    }
    const end = now + (party.until - serverTime);
    const cur = this.fx;
    if (cur && cur.key === party.at && cur.roomId === party.roomId) {
      cur.end = end;
      return;
    }
    const elapsed = Math.max(0, Math.min(serverTime - party.at, party.until - party.at));
    this.fx = { roomId: party.roomId, kind: 'party', text: tr('Festa no escritório!'), key: party.at, start: now - elapsed, end, cheered: new Set() };
  }

  /** A festa está acontecendo agora. */
  on(now: number): boolean {
    return !!this.fx && now < this.fx.end;
  }

  /** Começo, troca de anfitriã e fim: chama todo mundo para a festa ou de volta para casa. A cada quadro (barato). */
  update(sim: Sim, now: number): void {
    const fx = this.fx;
    if (fx && now >= fx.end) {
      this.fx = null;
      this.finish(sim);
      return;
    }
    if (!fx) return;
    const tag = `${fx.key}|${fx.roomId}|${sim.layoutVersion}`;
    if (this.tilesFor !== tag) {
      // festa nova, outra anfitriã ou o prédio mudou (sala nova, mudança): lugares refeitos, todos replanejam
      const guests = [...this.spot.keys()];
      this.tiles = null;
      this.tilesFor = tag;
      this.spot.clear();
      const fresh = !this.started || this.started.key !== fx.key || this.started.roomId !== fx.roomId;
      this.started = { key: fx.key, roomId: fx.roomId };
      const room = sim.rooms.get(fx.roomId);
      if (room && !room.lightOn) room.setLight(true, now);
      if (fresh) {
        for (const ch of sim.chars.values()) if (canParty(ch)) sim.interrupt(ch);
      } else {
        for (const id of guests) {
          const ch = sim.chars.get(id);
          if (ch) sim.interrupt(ch);
        }
      }
    }
  }

  /** Acabou (ou foi encerrada): quem estava na festa volta para casa já, sem terminar a dança. */
  private finish(sim: Sim): void {
    for (const id of this.spot.keys()) {
      const ch = sim.chars.get(id);
      if (ch) sim.interrupt(ch);
    }
    this.spot.clear();
    this.tiles = null;
    this.tilesFor = '';
    this.started = null;
  }

  /**
   * Plano da festa para `ch` (chamado pelo planejador antes de tudo, menos ir embora e entregar): ir até o lugar dele
   * na sala anfitriã ou, já lá, comemorar mais um pouco. false = não vai à festa (sem festa, não pode ou sem lugar).
   */
  plan(sim: Sim, ch: Character, now: number): boolean {
    const fx = this.fx;
    if (!fx || now >= fx.end || !canParty(ch)) return false;
    const room = sim.rooms.get(fx.roomId);
    if (!room || !room.present || room.phase === 'dismantling') return false;
    const tile = this.tileOf(sim, ch);
    if (!tile) return false;
    const r = room.layout.rect;
    const dir: Dir = facing(tile.x * TILE, tile.y * TILE, (r.x + r.w / 2) * TILE, (r.y + r.h / 2) * TILE);
    const steps: Step[] = [];
    if (ch.atSpot) steps.push({ t: 'exit' });
    if (ch.atSpot || ch.tx !== tile.x || ch.ty !== tile.y) {
      const dist = Math.abs(tile.x - ch.tx) + Math.abs(tile.y - ch.ty);
      steps.push({ t: 'go', tx: tile.x, ty: tile.y, dir, run: dist >= RUN_FROM }, { t: 'do', fn: () => (ch.arriving = false) });
    } else {
      // já está na festa: um número (pulinhos na maioria das vezes), às vezes um emoji ou um confete, e uma pausa
      const k = ch.rng();
      if (k < 0.55) steps.push({ t: 'act', pose: 'cheer', ms: PARTY_CHEER_MS, dir });
      else if (k < 0.75) steps.push({ t: 'act', pose: 'laugh', ms: 1_800, dir });
      else steps.push({ t: 'act', pose: 'talk', ms: 2_000, dir: ch.rng() < 0.5 ? 'left' : 'right' });
      const extra = ch.rng();
      if (extra < 0.3) steps.push({ t: 'do', fn: () => ((ch.chatEmoji = PARTY_EMOJIS[Math.floor(ch.rng() * PARTY_EMOJIS.length)]), (ch.chatUntil = sim.now + 2_000)) });
      else if (extra < 0.42) steps.push({ t: 'do', fn: () => sim.pushEffect({ kind: 'confetti', charId: ch.id, at: sim.now }) });
    }
    steps.push({ t: 'until', cond: () => !this.on(sim.now), minMs: 400, maxMs: 700 + Math.floor(ch.rng() * 2_200), pose: 'stand', dir });
    ch.queue.push(...steps);
    return true;
  }

  /**
   * Volta de uma aba oculta (Sim.fastForward): quem vai à festa já aparece no lugar dele, em pé, em vez de sair da mesa
   * e atravessar o prédio de novo.
   */
  settle(sim: Sim, now: number): void {
    const fx = this.fx;
    if (!fx || now >= fx.end) return;
    const room = sim.rooms.get(fx.roomId);
    if (!room || !room.present || room.phase === 'dismantling') return;
    for (const ch of sim.chars.values()) {
      if (!canParty(ch) || ch.step || ch.queue.length) continue;
      const tile = this.tileOf(sim, ch);
      if (!tile) continue;
      ch.atSpot = null;
      ch.seated = false;
      ch.sortY = null;
      ch.standTile = null;
      ch.placeAtTile(tile.x, tile.y);
      ch.setPose('stand');
    }
  }

  /** Lugar reservado de `ch` (o primeiro livre na ordem de preferência), ou null se a festa lotou. */
  private tileOf(sim: Sim, ch: Character): Tile | null {
    const mine = this.spot.get(ch.id);
    if (mine) return mine;
    const tiles = this.placesFor(sim);
    const taken = new Set([...this.spot.values()].map((t) => t.y * sim.building.grid.w + t.x));
    const free = tiles.find((t) => !taken.has(t.y * sim.building.grid.w + t.x));
    if (!free) return null;
    this.spot.set(ch.id, free);
    return free;
  }

  private placesFor(sim: Sim): Tile[] {
    if (this.tiles) return this.tiles;
    const room = this.fx ? sim.rooms.get(this.fx.roomId) : undefined;
    if (!room) return (this.tiles = []);
    const grid = sim.building.grid;
    const r = room.layout.rect;
    const spotTiles = new Set<number>();
    for (const s of sim.spots.all()) spotTiles.add(s.ty * grid.w + s.tx);
    // começa do tile livre mais perto do meio do piso
    const cx = r.x + r.w / 2;
    const cy = r.y + (r.h + 2) / 2;
    let start: Tile | null = null;
    let best = Infinity;
    for (let y = r.y + 2; y < r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        if (grid.get(x, y) !== FREE || spotTiles.has(y * grid.w + x)) continue;
        const d = Math.abs(x + 0.5 - cx) + Math.abs(y + 0.5 - cy);
        if (d < best) {
          best = d;
          start = { x, y };
        }
      }
    }
    this.tiles = start ? partyTiles(grid, r, start, spotTiles) : [];
    return this.tiles;
  }
}
