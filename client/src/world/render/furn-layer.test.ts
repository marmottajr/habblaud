// Camadas de desenho: partição dos props e escolha dos móveis a redesenhar (sem canvas).
import { describe, expect, it } from 'vitest';
import { isStaticProp, layerProps, redrawSet, type DepthRect } from './furn-layer';

const item = (id: string, ay: number, x: number, y: number, w = 10, h = 10): DepthRect & { id: string } => ({ id, ay, x, y, w, h });
const hit = { x: 0, y: 0, w: 10, h: 10 };
const ids = (l: { id: string }[]): string[] => l.map((i) => i.id);

describe('props estáticos', () => {
  it('árvore, cerca e flores soltas são estáticas; poste, banco, totem, calçamento e props de sala não', () => {
    for (const kind of ['tree', 'hedge', 'flowers'] as const) expect(isStaticProp({ kind })).toBe(true);
    for (const kind of ['lamp', 'bench', 'totem', 'paving'] as const) expect(isStaticProp({ kind })).toBe(false);
    expect(isStaticProp({ kind: 'hedge', whenRoom: 0 })).toBe(false);
  });
});

describe('redrawSet', () => {
  it('móvel atrás do personagem não volta', () => {
    expect(redrawSet([item('a', 5, 0, 0)], hit, 10, [])).toEqual([]);
  });

  it('móvel na frente que cruza volta', () => {
    expect(ids(redrawSet([item('a', 20, 5, 5)], hit, 10, []))).toEqual(['a']);
  });

  it('móvel na frente mas longe não volta', () => {
    expect(redrawSet([item('a', 20, 100, 100)], hit, 10, [])).toEqual([]);
  });

  it('cascata: quem cruza um já escolhido também volta, na ordem de ay', () => {
    const a = item('A', 10, 5, 5);
    const b = item('B', 20, 14, 5);
    expect(ids(redrawSet([a, b], hit, 0, []))).toEqual(['A', 'B']);
  });

  it('cascata só para frente: item de ay menor que cruza um escolhido depois não entra', () => {
    const c = item('C', 5, 14, 5); // não cruza hit; cruza B, mas B vem depois na lista
    const a = item('A', 10, 5, 5);
    const b = item('B', 20, 14, 5);
    expect(ids(redrawSet([c, a, b], hit, 0, []))).toEqual(['A', 'B']);
  });

  it('reaproveita o array de saída', () => {
    const out: (DepthRect & { id: string })[] = [];
    redrawSet([item('a', 20, 5, 5)], hit, 10, out);
    const r = redrawSet([item('b', 20, 5, 5)], hit, 10, out);
    expect(r).toBe(out);
    expect(ids(r)).toEqual(['b']);
  });
});

describe('layerProps', () => {
  it('estático que cruza um dinâmico fica fora das camadas', () => {
    const rects = new Map<object, { x: number; y: number; w: number; h: number }>();
    const mk = (kind: 'hedge' | 'lamp' | 'tree', x: number) => {
      const p = { kind };
      rects.set(p, { x, y: 0, w: 10, h: 10 });
      return p;
    };
    const hedgeNear = mk('hedge', 5);
    const hedgeFar = mk('hedge', 50);
    const tree = mk('tree', 100);
    const lamp = mk('lamp', 0);
    const set = layerProps([hedgeNear, hedgeFar, tree, lamp], (p) => rects.get(p)!);
    expect([...set]).toEqual([hedgeFar, tree]);
  });
});
