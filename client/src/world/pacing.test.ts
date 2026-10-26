import { describe, expect, it } from 'vitest';
import { frameCapFor, sleepsBetweenFrames } from './pacing';

describe('frameCapFor', () => {
  it('ativo sem limite da interface usa o ritmo do monitor', () => {
    expect(frameCapFor({ uiCap: 0, active: true, focused: true, powerSave: false, motion: true })).toBe(0);
  });
  it('ativo com limite da interface mantém o limite', () => {
    expect(frameCapFor({ uiCap: 30, active: true, focused: true, powerSave: false, motion: true })).toBe(30);
  });
  it('parado com foco e movimento desenha a 30', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: true, powerSave: false, motion: true })).toBe(30);
  });
  it('parado sem foco e com movimento desenha a 15', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: false, powerSave: false, motion: true })).toBe(15);
  });
  it('parado sem foco com movimento e limite 30 vale o menor (15)', () => {
    expect(frameCapFor({ uiCap: 30, active: false, focused: false, powerSave: false, motion: true })).toBe(15);
  });
  it('parado com foco e limite 10 vale o menor (10)', () => {
    expect(frameCapFor({ uiCap: 10, active: false, focused: true, powerSave: false, motion: true })).toBe(10);
  });
  it('economia, parado, com foco e com movimento desenha a 10 (ignora o movimento)', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: true, powerSave: true, motion: true })).toBe(10);
  });
  it('economia, parado, sem foco desenha a 5', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: false, powerSave: true, motion: true })).toBe(5);
  });
  it('economia, ativo, sem limite da interface usa o ritmo do monitor', () => {
    expect(frameCapFor({ uiCap: 0, active: true, focused: true, powerSave: true, motion: true })).toBe(0);
  });
  it('economia, parado, com foco e limite 30 da interface vale 10', () => {
    expect(frameCapFor({ uiCap: 30, active: false, focused: true, powerSave: true, motion: true })).toBe(10);
  });
  it('sem movimento, com foco, sem economia desenha a 10', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: true, powerSave: false, motion: false })).toBe(10);
  });
  it('sem movimento, sem foco, sem economia desenha a 5', () => {
    expect(frameCapFor({ uiCap: 0, active: false, focused: false, powerSave: false, motion: false })).toBe(5);
  });
  it('ativo sem movimento e sem limite da interface segue o monitor', () => {
    expect(frameCapFor({ uiCap: 0, active: true, focused: true, powerSave: false, motion: false })).toBe(0);
  });
  it('sem movimento com limite 30 da interface (terminal aberto) vale 10', () => {
    expect(frameCapFor({ uiCap: 30, active: false, focused: true, powerSave: false, motion: false })).toBe(10);
  });
});

describe('sleepsBetweenFrames', () => {
  it('abaixo de 30 qps dorme no timer', () => {
    expect(sleepsBetweenFrames(10)).toBe(true);
  });
  it('30 qps ou mais segue no rAF', () => {
    expect(sleepsBetweenFrames(30)).toBe(false);
  });
  it('sem limite segue no rAF', () => {
    expect(sleepsBetweenFrames(0)).toBe(false);
  });
});
