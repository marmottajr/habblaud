import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roomFolder } from '../../shared/presentation';
import type { AgentInfo, OutboxStatus } from '../../shared/types';
import { PresentationStore, REQUEST_TIMEOUT_MS, type PresentationStoreOptions } from './store';

const ROOM = 'c:/users/ana/loja';
const OTHER = 'c:/users/ana/blog';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('PresentationStore', () => {
  let root: string;
  let now: number;
  let ready: Array<[string, string]>;
  let changes: number;
  let sent: Array<{ agentId: string; text: string }>;
  let status: OutboxStatus;
  const agents = new Map<string, Partial<AgentInfo>>();

  const write = (room: string, folder: string, md: string, at = now) => {
    const dir = join(root, 'apresentacoes', roomFolder(room), folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'slides.md'), md);
    utimesSync(join(dir, 'slides.md'), at / 1000, at / 1000);
    return dir;
  };

  const store = (over: Partial<PresentationStoreOptions> = {}) =>
    new PresentationStore({
      dir: join(root, 'apresentacoes'),
      hostDir: 'C:\\Users\\ana\\.habblaud\\apresentacoes',
      dataDir: join(root, 'data'),
      rooms: () => [
        { id: ROOM, name: 'loja' },
        { id: OTHER, name: 'blog' },
      ],
      agent: (id) => agents.get(id) as AgentInfo | undefined,
      send: (agentId, text) => {
        sent.push({ agentId, text });
        return { messageId: `m${sent.length}` };
      },
      messageStatus: () => status,
      onChange: () => changes++,
      onReady: (roomId, title) => ready.push([roomId, title]),
      now: () => now,
      ...over,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'habblaud-tv-'));
    now = Date.UTC(2026, 10, 16, 14, 0);
    ready = [];
    changes = 0;
    sent = [];
    status = 'delivered';
    agents.clear();
    agents.set('a1', { id: 'a1', kind: 'main', roomId: ROOM, status: 'idle' });
    agents.set('s1', { id: 's1', kind: 'sub', roomId: ROOM, status: 'working' });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('acha as apresentações das salas abertas, com título e slides; sem pasta, a TV fica desligada', () => {
    write(ROOM, '2026-11-15-1000-login', '# Login novo\n---\n## Antes\n---\n## Depois');
    write(ROOM, '2026-11-16-0900-banco', '## Só subtítulo', now + 1000);
    write('c:/fechada', '2026-11-16-0900-x', '# X');
    write(ROOM, '..ruim', '# nome inválido');
    const s = store();
    s.scan();
    const list = s.list(ROOM);
    expect(list.map((p) => [p.title, p.slides, p.seen])).toEqual([
      ['Só subtítulo', 1, false],
      ['Login novo', 3, false],
    ]);
    expect(list[0]!.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(s.tvs().get(ROOM)).toEqual({ state: 'new', title: 'Só subtítulo', count: 2 });
    expect(s.tvs().has(OTHER)).toBe(false);
    // a primeira varredura não avisa (já estavam lá)
    expect(ready).toEqual([]);
  });

  it('assistida: a TV sai do "nova", vale depois de reiniciar (presentations.json)', () => {
    write(ROOM, 'a', '# A');
    const s = store();
    s.scan();
    const id = s.list(ROOM)[0]!.id;
    expect(s.markSeen(id)).toBe(true);
    expect(s.markSeen('desconhecida')).toBe(false);
    expect(s.tvs().get(ROOM)!.state).toBe('ready');
    const again = store();
    again.scan();
    expect(again.list(ROOM)[0]!.seen).toBe(true);
  });

  it('pedido: manda o texto ao agente principal, "Preparando…" até a apresentação chegar, e avisa a nova', () => {
    const s = store();
    s.scan();
    expect(s.request(ROOM, 's1')).toMatchObject({ status: 409 });
    expect(s.request(OTHER, 'a1')).toMatchObject({ status: 404 });
    expect(s.request(ROOM, 'a1')).toEqual({ ok: true, messageId: 'm1' });
    expect(sent[0]!.text).toContain(`C:\\Users\\ana\\.habblaud\\apresentacoes\\${roomFolder(ROOM)}\\`);
    expect(s.tvs().get(ROOM)).toEqual({ state: 'preparing', count: 0 });
    now += 60_000;
    write(ROOM, '2026-11-16-1400-login', '# Login novo');
    s.scan();
    expect(ready).toEqual([[ROOM, 'Login novo']]);
    expect(s.tvs().get(ROOM)).toMatchObject({ state: 'new', count: 1 });
    expect(changes).toBeGreaterThan(0);
  });

  it('o "Preparando…" acaba se a mensagem falha, o agente sai ou o prazo vence', () => {
    const s = store();
    s.scan();
    s.request(ROOM, 'a1');
    status = 'failed';
    s.scan();
    expect(s.tvs().has(ROOM)).toBe(false);
    status = 'delivered';
    s.request(ROOM, 'a1');
    now += REQUEST_TIMEOUT_MS + 1;
    s.scan();
    expect(s.tvs().has(ROOM)).toBe(false);
  });

  it('sem mensagens não dá para pedir', () => {
    const s = store({ send: undefined });
    expect(s.canRequest).toBe(false);
    expect(s.request(ROOM, 'a1')).toMatchObject({ status: 403 });
  });

  it('imagens: só as citadas; relativa dentro da pasta; absoluta pelo leitor de arquivos', async () => {
    const dir = write(ROOM, 'a', '# A\n![tela](tela.png)\n![fora](../b/x.png)\n![abs](/proj/x.png)\n![txt](nota.txt)');
    writeFileSync(join(dir, 'tela.png'), PNG);
    writeFileSync(join(dir, 'nota.txt'), 'oi');
    const reads: string[] = [];
    const s = store({
      readFile: async (p) => {
        reads.push(p);
        return { data: PNG };
      },
    });
    s.scan();
    const id = s.list(ROOM)[0]!.id;
    expect(await s.image(id, 'tela.png')).toMatchObject({ type: 'image/png', name: 'tela.png' });
    expect(await s.image(id, 'outra.png')).toMatchObject({ status: 404 });
    expect(await s.image(id, '../b/x.png')).toMatchObject({ status: 404 });
    expect(await s.image(id, 'nota.txt')).toMatchObject({ status: 415 });
    expect(await s.image(id, '/proj/x.png')).toMatchObject({ type: 'image/png' });
    expect(reads).toEqual(['/proj/x.png']);
    expect(s.content(id)!.markdown).toContain('![tela](tela.png)');
  });
});
