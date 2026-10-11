import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { cleanJob, JOB_MAX, JobStore } from './jobs';
import { NameStore } from './names';
import { Office } from './office';

setQuiet(true);

function officeWith(jobs: JobStore | undefined): Office {
  return new Office({
    names: new NameStore(null),
    jobs,
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
  });
}

const MAIN = { id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/social', role: 'Agente principal', startedAt: 1, status: 'idle' as const };

describe('cleanJob', () => {
  it('uma linha só, sem controle, espaços colapsados e no máximo JOB_MAX caracteres', () => {
    expect(cleanJob('  Analista   de\n mercado\t ')).toBe('Analista de mercado');
    expect(cleanJob('x'.repeat(200))).toHaveLength(JOB_MAX);
    expect(cleanJob('a\u0000b\u2028c')).toBe('a b c');
  });

  it('vazio ou não texto = sem função', () => {
    expect(cleanJob('   ')).toBeUndefined();
    expect(cleanJob(undefined)).toBeUndefined();
    expect(cleanJob(42)).toBeUndefined();
    expect(cleanJob({ job: 'x' })).toBeUndefined();
  });
});

describe('JobStore', () => {
  it('guarda por sessão, sugere por sala sem repetir e persiste', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'data', 'jobs.json');
      const a = new JobStore(file);
      a.set('s1', '/p/social', 'Roteirista');
      a.set('s2', '/p/social', 'roteirista');
      a.set('s3', '/p/social', 'Estrategista');
      a.set('s4', '/p/loja', 'Dev');
      expect(a.get('s1')).toBe('Roteirista');
      expect(a.roomJobs('/p/social')).toEqual(['Roteirista', 'Estrategista']);
      expect(a.roomJobs('/p/loja')).toEqual(['Dev']);
      a.flush();
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);

      const b = new JobStore(file);
      b.load();
      expect(b.get('s3')).toBe('Estrategista');
      expect(b.roomJobs('/p/social')).toEqual(['Roteirista', 'Estrategista']);
    } finally {
      tmp.cleanup();
    }
  });

  it('tirar a função não tira a sugestão; forget tira a sugestão e não a função de quem tem', () => {
    const s = new JobStore(null);
    s.set('s1', '/p', 'Dev');
    s.set('s2', '/p', 'Dev');
    s.set('s1', '/p', undefined);
    expect(s.get('s1')).toBeUndefined();
    expect(s.roomJobs('/p')).toEqual(['Dev']);
    expect(s.forget('/p', 'DEV')).toBe(true);
    expect(s.forget('/p', 'Dev')).toBe(false);
    expect(s.roomJobs('/p')).toEqual([]);
    expect(s.get('s2')).toBe('Dev');
  });

  it('a sessão nova herda a função da anterior', () => {
    const s = new JobStore(null);
    s.set('s1', '/p', 'Planejamento');
    s.remember('s2', 's1');
    s.remember('s9', 'nao-existe');
    expect(s.get('s2')).toBe('Planejamento');
    expect(s.get('s9')).toBeUndefined();
  });

  it('arquivo torto não derruba: começa do zero', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'jobs.json');
      mkdirSync(tmp.dir, { recursive: true });
      const s = new JobStore(file);
      s.set('s1', '/p', 'Dev');
      s.flush();
      const again = new JobStore(join(tmp.dir, 'nao-existe.json'));
      again.load();
      expect(again.get('s1')).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });
});

describe('Office.setJob', () => {
  it('põe a função no snapshot do agente e nas sugestões da sala', () => {
    const office = officeWith(new JobStore(null));
    office.addMain(MAIN);
    expect(office.setJob(MAIN.id, '  Analista de   mercado ')).toBe('Analista de mercado');
    const snap = office.commit().snapshot;
    expect(snap.agents[0].job).toBe('Analista de mercado');
    expect(snap.rooms[0].jobs).toEqual(['Analista de mercado']);
  });

  it('texto vazio tira a função', () => {
    const office = officeWith(new JobStore(null));
    office.addMain(MAIN);
    office.setJob(MAIN.id, 'Dev');
    expect(office.setJob(MAIN.id, '')).toBeUndefined();
    expect(office.commit().snapshot.agents[0].job).toBeUndefined();
  });

  it('agente que não existe, subagente ou escritório sem funções: null', () => {
    const office = officeWith(new JobStore(null));
    office.addMain(MAIN);
    office.addSub({ id: 's1:a1', parentId: MAIN.id, sessionId: 's1', role: 'Explore', background: false, startedAt: 2 });
    expect(office.setJob('nao-existe', 'Dev')).toBeNull();
    expect(office.setJob('s1:a1', 'Dev')).toBeNull();
    const semFuncoes = officeWith(undefined);
    semFuncoes.addMain(MAIN);
    expect(semFuncoes.setJob(MAIN.id, 'Dev')).toBeNull();
  });

  it('a função acompanha a sessão: volta quando o agente reaparece e segue depois de um /clear', () => {
    const jobs = new JobStore(null);
    const first = officeWith(jobs);
    first.addMain(MAIN);
    first.setJob(MAIN.id, 'Roteirista');
    first.switchSession(MAIN.id, 's2');

    const second = officeWith(jobs);
    second.addMain({ ...MAIN, id: '.claude:2', sessionId: 's2' });
    expect(second.commit().snapshot.agents[0].job).toBe('Roteirista');
  });
});

describe('POST /api/agents/:id/job', () => {
  async function start() {
    const tmp = tempDir();
    const dir = join(tmp.dir, '.claude');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      jobs: new JobStore(null),
      version: '9.9.9',
      startedAt: Date.now(),
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: () => undefined,
    });
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false });
    const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    office.addMain(MAIN);
    const close = async () => {
      hub.stop();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      tmp.cleanup();
    };
    return { base: `http://127.0.0.1:${port}`, port, close };
  }

  const post = (base: string, id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/agents/${encodeURIComponent(id)}/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('grava, devolve a função limpa e publica no snapshot', async () => {
    const env = await start();
    try {
      const res = await post(env.base, MAIN.id, { job: ' Estrategista  ' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: MAIN.id, job: 'Estrategista' });
      const snap = (await (await fetch(`${env.base}/api/snapshot`)).json()) as OfficeSnapshot;
      expect(snap.agents[0].job).toBe('Estrategista');
      expect(await (await post(env.base, MAIN.id, { job: '' })).json()).toEqual({ id: MAIN.id, job: null });
    } finally {
      await env.close();
    }
  });

  it('recusa agente desconhecido, outro método, corpo que não é JSON e outra origem', async () => {
    const env = await start();
    try {
      expect((await post(env.base, 'nao-existe', { job: 'Dev' })).status).toBe(404);
      expect((await fetch(`${env.base}/api/agents/${encodeURIComponent(MAIN.id)}/job`)).status).toBe(405);
      const form = await fetch(`${env.base}/api/agents/${encodeURIComponent(MAIN.id)}/job`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'job=Dev' });
      expect(form.status).toBe(415);
      expect((await post(env.base, MAIN.id, { job: 'Dev' }, { Origin: 'https://site-de-fora.example' })).status).toBe(403);
    } finally {
      await env.close();
    }
  });

  it('POST /api/jobs/forget tira a sugestão da sala e deixa a função de quem tem', async () => {
    const env = await start();
    try {
      await post(env.base, MAIN.id, { job: 'Estrategsita' });
      const forget = (body: unknown) => fetch(`${env.base}/api/jobs/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(await (await forget({ room: '/p/social', job: 'estrategsita' })).json()).toEqual({ removed: true });
      expect(await (await forget({ room: '/p/social', job: 'estrategsita' })).json()).toEqual({ removed: false });
      expect(await (await forget({ room: 42 })).json()).toEqual({ removed: false });
      const snap = (await (await fetch(`${env.base}/api/snapshot`)).json()) as OfficeSnapshot;
      expect(snap.rooms[0].jobs).toBeUndefined();
      expect(snap.agents[0].job).toBe('Estrategsita');
    } finally {
      await env.close();
    }
  });

  it('só pelo próprio computador: um nome liberado na rede não altera a função', async () => {
    const env = await start();
    try {
      const status = await new Promise<number>((ok, fail) => {
        const req = http.request(
          { host: '127.0.0.1', port: env.port, path: `/api/agents/${encodeURIComponent(MAIN.id)}/job`, method: 'POST', headers: { Host: 'habblaud.lan', 'Content-Type': 'application/json' } },
          (res) => {
            res.resume();
            ok(res.statusCode ?? 0);
          },
        );
        req.on('error', fail);
        req.end(JSON.stringify({ job: 'Dev' }));
      });
      expect(status).toBe(403);
    } finally {
      await env.close();
    }
  });
});
