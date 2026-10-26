import { describe, expect, it, vi } from 'vitest';
import { pixelText, pixelTextWidth } from './pixelfont';

describe('rótulos bitmap em chinês', () => {
  it('reserva espaço para ideogramas e mantém as medidas latinas', () => {
    expect(pixelTextWidth('')).toBe(0);
    expect(pixelTextWidth('abc')).toBe(11);
    expect(pixelTextWidth('已关闭')).toBe(26);
    expect(pixelTextWidth('A中')).toBe(12);
  });

  it('desenha os ideogramas com a fonte local em vez de espaços vazios', () => {
    const ctx = { fillStyle: '', save: vi.fn(), restore: vi.fn(), fillText: vi.fn(), fillRect: vi.fn() };
    expect(pixelText(ctx as unknown as CanvasRenderingContext2D, '已关闭', 4, 10, '#fff')).toBe(27);
    expect(ctx.fillText.mock.calls).toEqual([['已', 4, 8], ['关', 13, 8], ['闭', 22, 8]]);
    expect(ctx.save).toHaveBeenCalledTimes(3);
    expect(ctx.restore).toHaveBeenCalledTimes(3);
  });
});
