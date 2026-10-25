// Regras puras da câmera do mundo.
import { describe, expect, it } from 'vitest';
import { renderDpr } from './camera';

describe('renderDpr', () => {
  it('usa a densidade da tela, de 1 a 3', () => {
    expect(renderDpr(2, false)).toBe(2);
    expect(renderDpr(4, false)).toBe(3);
    expect(renderDpr(undefined, false)).toBe(1);
    expect(renderDpr(0.5, false)).toBe(1);
  });
  it('economia de energia: 1 com zoom ≥ 0,7; mais densidade só abaixo disso, até a da tela', () => {
    expect(renderDpr(3, true)).toBe(1);
    expect(renderDpr(3, true, 2)).toBe(1);
    expect(renderDpr(3, true, 0.77)).toBe(1);
    expect(renderDpr(3, true, 0.35)).toBe(2);
    expect(renderDpr(3, true, 0.2)).toBe(3);
    expect(renderDpr(2, true, 0.2)).toBe(2);
    expect(renderDpr(1, true, 0.2)).toBe(1);
  });
});
