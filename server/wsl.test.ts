import { describe, expect, it } from 'vitest';
import { isWindowsPidDomain, isWsl, parseTasklistPids, WindowsPids, windowsPathToWsl } from './wsl';

const TASKLIST = ['"System Idle Process","0","Services","0","8 K"', '"claude.exe","15644","Console","2","350.468 K"', '"node.exe","12640","Console","2","90.112 K"', ''].join('\r\n');

describe('WSL', () => {
  it('reconhece o WSL pela variável do distro', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
    expect(isWsl({})).toBe(false);
  });

  it('reconhece o registro de uma sessão do Windows', () => {
    expect(isWindowsPidDomain('win32:arthur')).toBe(true);
    expect(isWindowsPidDomain('linux:96f3:pid:[4026532328]')).toBe(false);
    expect(isWindowsPidDomain(undefined)).toBe(false);
  });

  it('traduz o caminho do Windows para o que o WSL enxerga', () => {
    expect(windowsPathToWsl('C:\\Users\\Arthu\\workspace\\app')).toBe('/mnt/c/Users/Arthu/workspace/app');
    expect(windowsPathToWsl('D:/dados/app')).toBe('/mnt/d/dados/app');
    expect(windowsPathToWsl('C:\\')).toBe('/mnt/c');
    expect(windowsPathToWsl('C:\\app', '/win')).toBe('/win/c/app');
    // Sem letra de unidade (UNC, POSIX): fica como veio.
    expect(windowsPathToWsl('\\\\servidor\\pasta')).toBe('\\\\servidor\\pasta');
    expect(windowsPathToWsl('/home/arthur/app')).toBe('/home/arthur/app');
  });

  it('lê os PIDs do CSV do tasklist', () => {
    expect([...parseTasklistPids(TASKLIST)].sort((a, b) => a - b)).toEqual([0, 12640, 15644]);
    expect(parseTasklistPids('ERRO: qualquer coisa').size).toBe(0);
  });
});

describe('PIDs do Windows', () => {
  it('carrega a lista na primeira consulta e responde pelo cache', () => {
    let calls = 0;
    const pids = new WindowsPids({
      listSync: () => {
        calls++;
        return TASKLIST;
      },
      list: async () => TASKLIST,
      now: () => 0,
    });
    expect(pids.isAlive(15644)).toBe(true);
    expect(pids.isAlive(999)).toBe(false);
    expect(calls).toBe(1);
  });

  it('renova a lista em segundo plano quando ela envelhece', async () => {
    let now = 0;
    let current = TASKLIST;
    const pids = new WindowsPids({ listSync: () => current, list: async () => current, now: () => now, ttlMs: 1_000 });
    expect(pids.isAlive(15644)).toBe(true);
    current = '"node.exe","12640","Console","2","90.112 K"';
    now = 500;
    expect(pids.isAlive(15644)).toBe(true);
    now = 1_500;
    // Lista velha: ainda responde por ela e dispara a renovação.
    expect(pids.isAlive(15644)).toBe(true);
    await pids.idle();
    expect(pids.isAlive(15644)).toBe(false);
    expect(pids.isAlive(12640)).toBe(true);
  });

  it('sem tasklist (interop desligado), confia no arquivo de sessão', async () => {
    let now = 0;
    const pids = new WindowsPids({
      listSync: () => {
        throw new Error('ENOENT');
      },
      list: async () => {
        throw new Error('ENOENT');
      },
      now: () => now,
      ttlMs: 1_000,
    });
    expect(pids.isAlive(15644)).toBe(true);
    now = 2_000;
    expect(pids.isAlive(15644)).toBe(true);
    await pids.idle();
    expect(pids.isAlive(15644)).toBe(true);
  });

  it('uma lista vazia (saída inesperada) não derruba todo mundo', () => {
    const pids = new WindowsPids({ listSync: () => 'saída estranha', list: async () => '', now: () => 0 });
    expect(pids.isAlive(15644)).toBe(true);
  });
});
