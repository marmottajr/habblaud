import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectKiroAccount, discoverKiroDir, discoverKiroDirs, kiroDirOf, windowsKiroDirs } from './accounts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kiro-acc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('kiroDirOf', () => {
  it('aceita a pasta da conta, a de sessões e uma pasta solta com os arquivos', () => {
    const root = tmp();
    const base = join(root, '.kiro');
    const cli = join(base, 'sessions', 'cli');
    mkdirSync(cli, { recursive: true });
    expect(kiroDirOf(base)).toEqual({ dir: base, sessionsDir: cli });
    expect(kiroDirOf(cli)).toEqual({ dir: base, sessionsDir: cli });
    const loose = join(root, 'copia');
    mkdirSync(loose);
    writeFileSync(join(loose, 'a.lock'), '{}');
    expect(kiroDirOf(loose)).toEqual({ dir: loose, sessionsDir: loose });
    expect(kiroDirOf(join(root, 'nao-existe'))).toBeUndefined();
  });
});

describe('discoverKiroDirs', () => {
  it('KIRO_SESSIONS_DIR aponta para as sessões (antes virava .../sessions/cli/sessions/cli)', () => {
    const root = tmp();
    const cli = join(root, '.kiro', 'sessions', 'cli');
    mkdirSync(cli, { recursive: true });
    expect(discoverKiroDirs({ KIRO_SESSIONS_DIR: cli }, '/nada', { wsl: false })).toEqual([{ dir: join(root, '.kiro'), sessionsDir: cli }]);
  });

  it('KIRO_HOME inexistente cai no ~/.kiro', () => {
    const home = tmp();
    mkdirSync(join(home, '.kiro', 'sessions', 'cli'), { recursive: true });
    expect(discoverKiroDirs({ KIRO_HOME: join(home, 'x') }, home, { wsl: false }).map((d) => d.dir)).toEqual([join(home, '.kiro')]);
    expect(discoverKiroDir({}, home)).toBe(join(home, '.kiro'));
  });

  it('no WSL soma as pastas do Windows (sem Public/Default), e HABBLAUD_KIRO_WINDOWS=0 desliga', () => {
    const home = tmp();
    mkdirSync(join(home, '.kiro', 'sessions', 'cli'), { recursive: true });
    const users = tmp();
    for (const u of ['ana', 'Public', 'semkiro']) mkdirSync(join(users, u), { recursive: true });
    mkdirSync(join(users, 'ana', '.kiro', 'sessions', 'cli'), { recursive: true });
    mkdirSync(join(users, 'Public', '.kiro', 'sessions', 'cli'), { recursive: true });
    expect(windowsKiroDirs(users)).toEqual([join(users, 'ana', '.kiro')]);
    expect(discoverKiroDirs({}, home, { wsl: true, windowsUsersRoot: users }).map((d) => d.dir)).toEqual([join(home, '.kiro'), join(users, 'ana', '.kiro')]);
    expect(discoverKiroDirs({ HABBLAUD_KIRO_WINDOWS: '0' }, home, { wsl: true, windowsUsersRoot: users })).toHaveLength(1);
  });

  it('HABBLAUD_KIRO_DIRS substitui a lista (vírgula ou ;) e não repete', () => {
    const a = tmp();
    const b = tmp();
    mkdirSync(join(a, 'sessions', 'cli'), { recursive: true });
    mkdirSync(join(b, 'sessions', 'cli'), { recursive: true });
    const list = discoverKiroDirs({ HABBLAUD_KIRO_DIRS: `${a}, ${b};${join(a, 'sessions', 'cli')}` }, '/nada', { wsl: true, windowsUsersRoot: '/nada' });
    expect(list.map((d) => d.dir)).toEqual([a, b]);
  });
});

it('conta do Windows tem id, nome e letra próprios', () => {
  expect(detectKiroAccount('/mnt/c/Users/u/.kiro', {}, { windows: true })).toMatchObject({ id: '.kiro-windows', short: 'W', name: 'Kiro (Windows)', provider: 'kiro' });
});
