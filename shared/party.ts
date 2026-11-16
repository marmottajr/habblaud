// Festa no escritório (POST /api/party): por alguns minutos, todos os personagens presentes vão para uma sala
// anfitriã comemorar e depois voltam cada um para a sua. É só visual: não mexe nas sessões nem nos agentes (o
// snapshot leva só OfficeParty; quem anda é a simulação do navegador, client/src/world/sim/party.ts). Código puro,
// usado pelo servidor (server/model/office.ts e a rota em server/http/app.ts) e pelos testes.
import type { AgentInfo, RoomInfo } from './types';
import { tr } from './i18n';

/** Duração padrão da festa. */
export const PARTY_DEFAULT_MS = 120_000;
/** Duração mínima e máxima aceitas (em segundos, no corpo do POST). */
export const PARTY_MIN_S = 10;
export const PARTY_MAX_S = 600;

/** Corpo do POST /api/party já conferido. */
export interface PartyRequest {
  /** Sala anfitriã pedida: id ou nome exibido (sem diferenciar caixa). Ausente = a sala com mais agentes. */
  room?: string;
  /** Duração em ms. */
  ms: number;
}

/**
 * Confere o corpo do POST /api/party: `{room?: texto, seconds?: inteiro de PARTY_MIN_S a PARTY_MAX_S}`. Corpo vazio
 * vale (festa padrão na sala com mais agentes).
 */
export function parsePartyRequest(body: unknown): PartyRequest | { error: string } {
  const b = (body ?? {}) as { room?: unknown; seconds?: unknown };
  if (typeof b !== 'object' || Array.isArray(b)) return { error: tr('esperado {room?: texto, seconds?: número}') };
  let room: string | undefined;
  if (b.room !== undefined && b.room !== null && b.room !== '') {
    if (typeof b.room !== 'string' || b.room.length > 1000) return { error: tr('esperado {room?: texto, seconds?: número}') };
    room = b.room.trim() || undefined;
  }
  let ms = PARTY_DEFAULT_MS;
  if (b.seconds !== undefined && b.seconds !== null) {
    const s = b.seconds;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < PARTY_MIN_S || s > PARTY_MAX_S) {
      return { error: tr('a duração da festa vai de {0} a {1} segundos', [PARTY_MIN_S, PARTY_MAX_S]) };
    }
    ms = s * 1000;
  }
  return room === undefined ? { ms } : { room, ms };
}

/** Agente que aparece no escritório (vai à festa, se puder): principal ou subagente que não saiu nem terminou. */
function present(a: Pick<AgentInfo, 'status'>): boolean {
  return a.status !== 'offline' && a.status !== 'done';
}

/**
 * Sala anfitriã da festa. Com `requested`, a sala com esse id ou, senão, com esse nome (sem diferenciar caixa);
 * nenhuma = 'unknown'. Sem pedido, a sala com mais agentes presentes (empate: a de menor slot, a mais antiga no
 * prédio); sem nenhuma sala = 'empty'.
 */
export function pickPartyRoom(
  rooms: readonly Pick<RoomInfo, 'id' | 'name' | 'slot'>[],
  agents: readonly Pick<AgentInfo, 'roomId' | 'status'>[],
  requested?: string,
): { roomId: string } | { error: 'unknown' | 'empty' } {
  if (requested !== undefined) {
    const byId = rooms.find((r) => r.id === requested);
    if (byId) return { roomId: byId.id };
    const key = requested.toLocaleLowerCase();
    const byName = rooms.find((r) => r.name.toLocaleLowerCase() === key);
    return byName ? { roomId: byName.id } : { error: 'unknown' };
  }
  if (!rooms.length) return { error: 'empty' };
  const count = new Map<string, number>();
  for (const a of agents) if (present(a)) count.set(a.roomId, (count.get(a.roomId) ?? 0) + 1);
  let best = rooms[0];
  for (const r of rooms) {
    const n = count.get(r.id) ?? 0;
    const b = count.get(best.id) ?? 0;
    if (n > b || (n === b && r.slot < best.slot)) best = r;
  }
  return { roomId: best.id };
}
