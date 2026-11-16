import { describe, expect, it } from 'vitest';
import { BLOCKED, FREE } from '../path/grid';
import { audienceTiles } from './tv';

describe('plateia da TV', () => {
  // sala 16x12 em (0,0), piso livre a partir da linha 2; um móvel em (6,3) e um tile de aproximação em (5,4)
  const grid = { w: 16, get: (x: number, y: number) => (x === 6 && y === 3 ? BLOCKED : x >= 1 && x <= 14 && y >= 2 && y <= 10 ? FREE : BLOCKED) };
  const rect = { x: 0, y: 0, w: 16, h: 12 };

  it('em frente à TV primeiro, sem móveis nem lugares de aproximação, a fileira da parede por último', () => {
    const tiles = audienceTiles(grid, rect, 5, new Set([4 * 16 + 5]));
    expect(tiles[0]).toEqual({ x: 5, y: 3 });
    expect(tiles).not.toContainEqual({ x: 6, y: 3 });
    expect(tiles).not.toContainEqual({ x: 5, y: 4 });
    expect(tiles.every((t) => Math.abs(t.x - 5) <= 4 && t.y >= 2 && t.y <= 5)).toBe(true);
    // a fileira colada na parede (y = 2) vem depois da segunda fileira do mesmo lugar
    expect(tiles.findIndex((t) => t.x === 5 && t.y === 2)).toBeGreaterThan(tiles.findIndex((t) => t.x === 5 && t.y === 3));
  });
});
