import { describe, expect, it } from 'vitest';
import { frameCapFor } from './pacing';

describe('frameCapFor', () => {
  it('ativo sem limite da interface usa o ritmo do monitor', () => {
    expect(frameCapFor({ uiCap: 0, active: true, focused: true })).toBe(0);
  });
  it('ativo com limite da interface mantém o limite', () => {
    expect(frameCapFor({ uiCap: 30, active: true, focused: true })).toBe(30);
  });
  it('parado com foco desenha a 30', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: true })).toBe(30);
  });
  it('parado sem foco desenha a 15', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: false })).toBe(15);
  });
  it('parado sem foco com limite 30 vale o menor (15)', () => {
    expect(frameCapFor({ uiCap: 30, active: false, focused: false })).toBe(15);
  });
  it('parado com foco e limite 10 vale o menor (10)', () => {
    expect(frameCapFor({ uiCap: 10, active: false, focused: true })).toBe(10);
  });
});
