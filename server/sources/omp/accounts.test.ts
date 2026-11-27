// Contas do omp: descoberta das agent dirs (HABBLAUD_OMP_DIRS › PI_CODING_AGENT_DIR › ~/.omp/agent, só com sessions/),
// ids pela pasta-mãe, letra (alias de shell ou derivada), cor sem repetir; isOmpDir fora das contas do Claude Code.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, discoverClaudeDirs, isClaudeDir, isOmpDir } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { defaultOmpDir, detectOmpAccounts, discoverOmpDirs, ompAccountIds } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  return {
    dir: tmp.dir,
    /** Cria `<pai>/<nome>` como agent dir (com ou sem sessions/). */
    agent(parent: string, sessions = true, name = 'agent'): string {
      const dir = join(tmp.dir, parent, name);
      mkdirSync(dir, { recursive: true });
      if (sessions) mkdirSync(join(dir, 'sessions', '-proj'), { recursive: true });
      return dir;
    },
  };
}

describe('discoverOmpDirs', () => {
  it('padrão ~/.omp/agent com sessions/; sem sessions/ ou sem a pasta: nada, sem erro', () => {
    const h = home();
    expect(discoverOmpDirs({}, h.dir)).toEqual([]);
    h.agent('.omp', false);
    expect(discoverOmpDirs({}, h.dir)).toEqual([]);
    const main = h.agent('.omp');
    expect(discoverOmpDirs({}, h.dir)).toEqual([main]);
    expect(defaultOmpDir({}, h.dir)).toBe(main);
  });

  it('PI_CODING_AGENT_DIR substitui o padrão; HABBLAUD_OMP_DIRS substitui tudo (lista, ~, repetidos e pastas sem sessions/)', () => {
    const h = home();
    const main = h.agent('.omp');
    const work = h.agent('.omp-trabalho');
    const empty = h.agent('.omp-vazio', false);
    expect(discoverOmpDirs({ PI_CODING_AGENT_DIR: work }, h.dir)).toEqual([work]);
    expect(discoverOmpDirs({ PI_CODING_AGENT_DIR: empty }, h.dir)).toEqual([]);
    expect(discoverOmpDirs({ HABBLAUD_OMP_DIRS: `${work}, ${main},${work}, ${empty}, /nao/existe`, PI_CODING_AGENT_DIR: empty }, h.dir)).toEqual([work, main]);
    expect(discoverOmpDirs({ HABBLAUD_OMP_DIRS: '~/.omp/agent' }, h.dir)).toEqual([main]);
  });

  it('caminho absoluto do sistema (no Windows, C:\\...) vale como veio', () => {
    const h = home();
    const dir = h.agent('.omp');
    expect(dir).toMatch(process.platform === 'win32' ? /^[A-Za-z]:\\/ : /^\//);
    expect(discoverOmpDirs({ HABBLAUD_OMP_DIRS: dir }, '/outra/home')).toEqual([dir]);
  });
});

describe('contas', () => {
  it('id = nome da pasta-mãe; repetido ganha ~2, ~3', () => {
    const h = home();
    const ids = ompAccountIds([h.agent('a/.omp'), h.agent('b/.omp'), h.agent('c/.omp'), h.agent('.omp-trabalho')]);
    expect(ids).toEqual(['.omp', '.omp~2', '.omp~3', '.omp-trabalho']);
  });

  it('letra pelo alias de shell (PI_CODING_AGENT_DIR), derivada sem colidir; cor sem repetir; nome', () => {
    const h = home();
    const main = h.agent('.omp');
    const work = h.agent('.omp-trabalho');
    writeFileSync(join(h.dir, '.zshrc'), [`alias ow="PI_CODING_AGENT_DIR=${work.replaceAll('\\', '/')} omp"`, "alias o='omp'", 'export PI_CODING_AGENT_DIR=/x # não é alias'].join('\n'));
    const accs = detectOmpAccounts([main, work], { home: h.dir, env: {}, taken: { shorts: ['C'], colors: [ACCOUNT_COLORS[0]] } });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['.omp', 'omp', 'O', 'omp O', main],
      ['.omp-trabalho', 'omp', 'OW', 'omp OW', work],
    ]);
    expect(accs[0].color).not.toBe(ACCOUNT_COLORS[0]);
    expect(accs[0].color).not.toBe(accs[1].color);
    // Sem alias e com uma conta só: "omp", letra O; a do Claude Code (O) ocupada: outra.
    expect(detectOmpAccounts([main], { home: h.dir, env: {}, taken: { shorts: ['O'] } }).map((a) => [a.short, a.name])).toEqual([['P', 'omp']]);
  });

  it('no Docker, HABBLAUD_ACCOUNTS (provider omp) traz id, nome, letra e a pasta do host', () => {
    const h = home();
    const mounted = h.agent('omp-montado');
    const env = { HABBLAUD_ACCOUNTS: JSON.stringify([{ id: '.omp', provider: 'omp', mountDir: mounted, configDir: '/Users/x/.omp/agent', short: 'Z', name: 'omp Mac', color: '#123456' }, { id: 'x', configDir: '/y' }]) };
    const [a] = detectOmpAccounts([mounted], { home: h.dir, env });
    expect(a).toMatchObject({ id: '.omp', provider: 'omp', configDir: '/Users/x/.omp/agent', short: 'Z', name: 'omp Mac', color: '#123456' });
  });
});

describe('isOmpDir: fora das contas do Claude Code', () => {
  it('agent.db/models.yml + sessions/ de pastas = omp; com projects/ ou sem as marcas = do Claude', () => {
    const h = home();
    const omp = h.agent('.omp');
    expect(isOmpDir(omp)).toBe(false); // só sessions/: ainda sem marca do omp
    writeFileSync(join(omp, 'agent.db'), '');
    expect(isOmpDir(omp)).toBe(true);
    expect(isClaudeDir(omp)).toBe(false);
    mkdirSync(join(omp, 'projects'));
    expect(isOmpDir(omp)).toBe(false);
    expect(isClaudeDir(omp)).toBe(true);
    const claude = join(h.dir, '.claude');
    mkdirSync(join(claude, 'sessions'), { recursive: true });
    expect(isOmpDir(claude)).toBe(false);
    expect(isClaudeDir(claude)).toBe(true);
  });

  it('HABBLAUD_CLAUDE_DIRS apontando para uma pasta do omp não a toma como conta do Claude', () => {
    const h = home();
    const omp = h.agent('.omp');
    writeFileSync(join(omp, 'models.yml'), '');
    expect(discoverClaudeDirs({ HABBLAUD_CLAUDE_DIRS: omp }, h.dir)).toEqual([]);
    expect(discoverClaudeDirs({ CLAUDE_CONFIG_DIR: omp }, h.dir)).toEqual([]);
  });
});
