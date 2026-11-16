import { describe, expect, it } from 'vitest';
import { acceptedImage, fitSize, imageName } from './message-images';

describe('imagens da caixa de mensagem', () => {
  it('fitSize: o lado maior vai a 2000 px no máximo, mantendo a proporção; nunca aumenta', () => {
    expect(fitSize(3840, 2160)).toEqual({ w: 2000, h: 1125, scaled: true });
    expect(fitSize(1080, 2400)).toEqual({ w: 900, h: 2000, scaled: true });
    expect(fitSize(1280, 720)).toEqual({ w: 1280, h: 720, scaled: false });
  });

  it('só PNG, JPEG, GIF e WebP', () => {
    expect(acceptedImage({ type: 'image/png' })).toBe(true);
    expect(acceptedImage({ type: 'image/webp' })).toBe(true);
    expect(acceptedImage({ type: 'image/svg+xml' })).toBe(false);
    expect(acceptedImage({ type: 'application/pdf' })).toBe(false);
  });

  it('um print colado (sem nome, ou "image.png") vira "print-<hora>"', () => {
    const at = new Date(2026, 10, 16, 9, 5, 7);
    expect(imageName({ name: '', type: 'image/png' }, at)).toBe('print-090507.png');
    expect(imageName({ name: 'image.png', type: 'image/png' }, at)).toBe('print-090507.png');
    expect(imageName({ name: '', type: 'image/jpeg' }, at)).toBe('print-090507.jpg');
    expect(imageName({ name: 'tela.webp', type: 'image/webp' }, at)).toBe('tela.webp');
  });
});
