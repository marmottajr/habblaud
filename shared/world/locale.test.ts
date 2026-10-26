import { describe, expect, it } from 'vitest';
import { toWorldLocale } from './locale';
import { WORLD_LOCALES } from './protocol';

describe('idioma do protocolo público do World', () => {
  it('usa inglês para a interface chinesa sem alterar os idiomas aceitos pelo servidor', () => {
    expect(toWorldLocale('zh-CN')).toBe('en');
    for (const locale of WORLD_LOCALES) expect(toWorldLocale(locale)).toBe(locale);
  });
});
