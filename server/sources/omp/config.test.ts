// ServerConfig: HABBLAUD_OMP liga/desliga a fonte do omp e ompDirs vem da descoberta (HABBLAUD_OMP_DIRS › PI_CODING_AGENT_DIR
// › ~/.omp/agent, só com sessions/).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import { tempDir } from '../../test/fixtures';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const agent = join(tmp.dir, '.omp', 'agent');
  mkdirSync(join(agent, 'sessions'), { recursive: true });
  return { home: tmp.dir, agent };
}

describe('loadConfig: omp', () => {
  it('ligado por padrão (variável ausente ou vazia ou truthy) com a pasta padrão', () => {
    const h = home();
    for (const v of [undefined, '', '1', 'true']) {
      const c = loadConfig({ HOME: h.home, ...(v === undefined ? {} : { HABBLAUD_OMP: v }) }, []);
      expect(c.omp, String(v)).toBe(true);
      expect(c.ompDirs, String(v)).toEqual([h.agent]);
    }
  });

  it('HABBLAUD_OMP=0 desliga: sem pastas, mesmo com sessions/ no disco', () => {
    const h = home();
    for (const v of ['0', 'false', 'off']) {
      const c = loadConfig({ HOME: h.home, HABBLAUD_OMP: v }, []);
      expect(c.omp, v).toBe(false);
      expect(c.ompDirs, v).toEqual([]);
    }
  });

  it('sem pasta com sessions/: ligado mas sem pastas (o servidor sobe sem a fonte)', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const c = loadConfig({ HOME: tmp.dir }, []);
    expect(c.omp).toBe(true);
    expect(c.ompDirs).toEqual([]);
  });

  it('HABBLAUD_OMP_DIRS e PI_CODING_AGENT_DIR', () => {
    const h = home();
    const other = join(h.home, 'outro', 'agent');
    mkdirSync(join(other, 'sessions'), { recursive: true });
    expect(loadConfig({ HOME: h.home, PI_CODING_AGENT_DIR: other }, []).ompDirs).toEqual([other]);
    expect(loadConfig({ HOME: h.home, PI_CODING_AGENT_DIR: other, HABBLAUD_OMP_DIRS: `${h.agent},${other}` }, []).ompDirs).toEqual([h.agent, other]);
  });

  it('uso do plano (omp usage): ligado por padrão; HABBLAUD_OMP_USAGE=0, HABBLAUD_OMP=0 e o Docker desligam', () => {
    const h = home();
    const usage = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: h.home, HABBLAUD_IN_DOCKER: '0', ...env }, []).ompUsage;
    expect(usage({})).toBe(true);
    expect(usage({ HABBLAUD_OMP_USAGE: '1' })).toBe(true);
    expect(usage({ HABBLAUD_OMP_USAGE: '0' })).toBe(false);
    expect(usage({ HABBLAUD_OMP: '0' })).toBe(false);
    expect(usage({ HABBLAUD_IN_DOCKER: '1' })).toBe(false);
  });
});
