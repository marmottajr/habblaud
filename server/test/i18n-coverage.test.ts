import { describe, expect, it } from 'vitest';
import { collectKeys } from '../../scripts/i18n-check';
import { ZH_CN } from '../../shared/locales/zh-CN';

describe('cobertura do chinês simplificado', () => {
  it('cobre todos os textos usados e não tem chaves obsoletas', () => {
    expect(Object.keys(ZH_CN).sort()).toEqual([...collectKeys().keys()].sort());
  });
});
