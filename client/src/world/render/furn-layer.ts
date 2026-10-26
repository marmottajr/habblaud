// Camadas de desenho do escritório: o que pode ser pintado uma vez e o que precisa ser redesenhado por quadro.
// Puro (sem DOM): testado em furn-layer.test.ts.
import type { ExteriorProp } from '../layout/types';

/** Retângulo no mundo. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Item da camada de móveis: profundidade (`ay`) e retângulo do sprite no mundo. */
export interface DepthRect extends Rect {
  ay: number;
}

/**
 * Props do lado de fora que nunca se cruzam com nada que se mexe: vão para as camadas pré-pintadas.
 * Fora: os que surgem com a sala (`whenRoom`), o poste (carro passa na frente), banco, totem e calçamento
 * (perto do caminho do visitante).
 */
export function isStaticProp(p: Pick<ExteriorProp, 'kind' | 'whenRoom'>): boolean {
  return p.whenRoom === undefined && p.kind !== 'lamp' && p.kind !== 'bench' && p.kind !== 'totem' && p.kind !== 'paving';
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Móveis da camada que precisam ser redesenhados depois de algo desenhado em `hit` com profundidade `depth`:
 * os de `ay` maior que cruzam `hit` e, em cascata, os de `ay` ainda maior que cruzam algum já escolhido (senão o
 * redesenho cobriria um móvel que está na frente dele). `items` vem ordenado por `ay`; `out` é reaproveitado.
 */
export function redrawSet<T extends DepthRect>(items: readonly T[], hit: Rect, depth: number, out: T[]): T[] {
  out.length = 0;
  for (const it of items) {
    if (it.ay <= depth) continue;
    let pick = overlaps(it, hit);
    for (let i = 0; i < out.length && !pick; i++) pick = overlaps(it, out[i]);
    if (pick) out.push(it);
  }
  return out;
}

/**
 * Props que vão para as camadas pré-pintadas: os estáticos que não tocam nenhum prop dinâmico. Um estático que
 * cruza o poste (ou outro dinâmico) fica na lista de profundidade, senão a camada o pintaria por cima do poste
 * (ou por baixo) mesmo quando o `y` manda o contrário.
 */
export function layerProps<P extends Pick<ExteriorProp, 'kind' | 'whenRoom'>>(props: readonly P[], rectOf: (p: P) => Rect): Set<P> {
  const dyn: Rect[] = [];
  for (const p of props) if (!isStaticProp(p)) dyn.push(rectOf(p));
  const out = new Set<P>();
  for (const p of props) {
    if (!isStaticProp(p)) continue;
    const r = rectOf(p);
    if (!dyn.some((d) => overlaps(d, r))) out.add(p);
  }
  return out;
}
