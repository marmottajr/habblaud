// Equipe de agentes fixos junto com o resto do escritório: chave nas mensagens, nome da sala, personagem do agente fixo.
//   1. Responder pergunta (AskUserQuestion) e mandar mensagem pela página exigem a chave do escritório, quando ela
//      existe, como já era para aprovar permissão. O plugin e o hook (que rodam dentro da sessão) não levam chave.
//   2. Sala de equipe com nome próprio (`equipe nome`) mantém o nome da equipe: "Renomear" da tela não o troca.
//   3. Personagem: o agente fixo não pega nem perde o personagem da sala; o editor da tela grava um personagem por
//      agente fixo (parado ou trabalhando), por cima do que o comando `equipe editar` escolheu, e "voltar" devolve o
//      de antes.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InboxMessage, OfficeSnapshot, OutboxMessage } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { createMessageRoutes } from '../messages/http';
import { MessageRegistry } from '../messages/registry';
import { JobStore } from '../model/jobs';
import { NameStore } from '../model/names';
import { Office, staffKey } from '../model/office';
import { RoomAliases } from '../model/room-aliases';
import { createPermissionRoutes } from '../permissions/http';
import { PermissionRegistry } from '../permissions/registry';
import { tempDir } from '../test/fixtures';
import { hookJson, request } from '../test/permission-server';
import { FilaDePedidos } from './pedidos';
import type { Equipes } from './registro';

setQuiet(true);

const CHAVE = 'chave-de-teste-com-mais-de-vinte';
const K = { 'X-Equipe-Chave': CHAVE };
const ERRADA = { 'X-Equipe-Chave': 'errada-errada-errada-errada' };
const SOCIAL = '/p/social';
const SEM_NOME = '/p/sem-nome';
const LOJA = '/p/loja';
const MAIN = 'acc:1';
const SESSION = 'sess-1';

/** Uma equipe com nome próprio e personagem escolhido pelo comando (o CMO), e outra sem nome próprio. */
const EQ: Equipes = new Map([
  [
    SOCIAL,
    {
      nome: 'Equipe de Marketing',
      nomeProprio: true,
      agentes: [
        { slug: 'cmo', funcao: 'CMO', personagem: { nome: 'Otávio', look: 'm' as const, semente: 4242 } },
        { slug: 'analista', funcao: 'Analista' },
      ],
    },
  ],
  [SEM_NOME, { nome: 'sem-nome', agentes: [{ slug: 'dev', funcao: 'Dev' }] }],
]);

interface Servidor {
  base: string;
  office: Office;
  names: NameStore;
  aliases: RoomAliases;
  permissions: PermissionRegistry;
  close(): Promise<void>;
}

/** Office, Hub e as rotas de verdade (guard, app, permissões, mensagens, renomear, personagem) ligados como em server/index.ts. */
async function servir(opts: { comChave?: boolean } = {}): Promise<Servidor> {
  const tmp = tempDir();
  const keyFile = join(tmp.dir, 'chave');
  if (opts.comChave ?? true) writeFileSync(keyFile, `${CHAVE}\n`);
  const late: { permissions?: PermissionRegistry; messages?: MessageRegistry } = {};
  const names = new NameStore(null);
  const aliases = new RoomAliases(null);
  const office = new Office({
    names,
    jobs: new JobStore(null),
    equipe: () => EQ,
    roomAlias: (path) => aliases.get(path),
    version: 't',
    startedAt: Date.now(),
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    terminal: true,
    permissions: () => late.permissions?.snapshot() ?? new Map(),
    messages: () => late.messages?.reachable() ?? new Set(),
  });
  office.syncEquipe();
  const hub = new Hub(office, { throttleMs: 10 });
  const fila = new FilaDePedidos({ equipes: () => EQ, keyFile, agentes: () => office.list() });
  const permissions = new PermissionRegistry({ office, viewers: () => 1, tickMs: 50 });
  const messages = new MessageRegistry({ office, tickMs: 20 });
  late.permissions = permissions;
  late.messages = messages;
  permissions.start();
  messages.start();
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 't',
    inDocker: false,
    terminal: true,
    permissions: createPermissionRoutes(permissions, { conferirChave: (k) => fila.conferirChave(k) }),
    messages: createMessageRoutes(messages, { conferirChave: (k) => fila.conferirChave(k) }),
    renameRoom: (id, name) => {
      const path = office.roomPath(id);
      if (!path) return undefined;
      aliases.set(path, name);
      office.refreshRoomNames();
      return office.roomName(id);
    },
  });
  const guard = createRequestGuard({ allowedHosts: new Set() });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  office.addMain({ id: MAIN, account: 'acc', sessionId: SESSION, cwd: LOJA, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    office,
    names,
    aliases,
    permissions,
    close: () =>
      new Promise((ok) => {
        permissions.stop();
        messages.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      }),
  };
}

let srv: Servidor | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const post = (s: Servidor, path: string, body: unknown, headers?: Record<string, string>) => request(s.base, path, { method: 'POST', body, headers });
const snapshot = async (s: Servidor) => (await request(s.base, '/api/snapshot')).json as OfficeSnapshot;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const PERGUNTAS = [
  { question: 'Qual banco usar?', header: 'Banco', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
  { question: 'Quais testes rodar?', multiSelect: true, options: [{ label: 'Unidade' }, { label: 'E2E' }] },
];
const RESPOSTA = { behavior: 'answer', answers: [{ question: 0, options: [1] }, { question: 1, options: [0], other: 'lint' }] };

describe('chave do escritório nas novidades do autor: responder pergunta e mandar mensagem', () => {
  it('responder uma pergunta (AskUserQuestion) pela página exige a chave; o hook da sessão registra e espera sem chave', async () => {
    srv = await servir();
    // O hook (dentro da sessão) registra a pergunta sem chave.
    const reg = await post(srv, '/api/permissions', hookJson({ tool_name: 'AskUserQuestion', tool_input: { questions: PERGUNTAS }, permission_suggestions: [] }));
    expect(reg.status).toBe(201);
    const { id } = reg.json as { id: string };
    const antes = (await snapshot(srv)).agents.find((a) => a.id === MAIN)!;
    expect(antes).toMatchObject({ status: 'waiting', permission: { id, tool: 'AskUserQuestion' } });

    // Sem a chave, ou com a chave errada, a resposta não entra e a pergunta continua esperando.
    const semChave = await post(srv, `/api/permissions/${id}/decision`, RESPOSTA);
    expect(semChave.status).toBe(401);
    expect(semChave.json).toMatchObject({ error: expect.stringMatching(/chave do escritório/) });
    expect((await post(srv, `/api/permissions/${id}/decision`, RESPOSTA, ERRADA)).status).toBe(401);
    expect(srv.permissions.size).toBe(1);
    expect((await snapshot(srv)).agents.find((a) => a.id === MAIN)?.permission?.id).toBe(id);
    // Ver a pergunta (leitura) não pede chave: a página mostra as opções antes de responder.
    expect((await request(srv.base, `/api/permissions/${id}`)).status).toBe(200);

    // Com a chave, a resposta chega ao hook que estava esperando (sem chave).
    const esperando = request(srv.base, `/api/permissions/${id}/wait?timeout=20`);
    await sleep(50);
    expect((await post(srv, `/api/permissions/${id}/decision`, RESPOSTA, K)).status).toBe(200);
    expect((await esperando).json).toEqual({ status: 'decided', ...RESPOSTA });
  });

  it('"responder no terminal" e recusar pela página também exigem a chave', async () => {
    srv = await servir();
    const { id } = (await post(srv, '/api/permissions', hookJson())).json as { id: string };
    for (const body of [{ behavior: 'terminal' }, { behavior: 'deny', message: 'agora não' }, { behavior: 'allow' }]) {
      expect((await post(srv, `/api/permissions/${id}/decision`, body)).status, body.behavior).toBe(401);
    }
    expect(srv.permissions.size).toBe(1);
    expect((await post(srv, `/api/permissions/${id}/decision`, { behavior: 'deny', message: 'agora não' }, K)).status).toBe(200);
  });

  it('mandar mensagem pela página exige a chave; o plugin busca e confirma sem chave', async () => {
    srv = await servir();
    // O plugin da sessão pergunta se há mensagens (sem chave): é isso que acende a caixa no escritório.
    expect((await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json).toEqual({ messages: [] });
    await sleep(30);
    expect((await snapshot(srv)).agents.find((a) => a.id === MAIN)?.canMessage).toBe(true);

    const texto = 'Roda os testes de novo';
    const semChave = await post(srv, '/api/messages', { agentId: MAIN, text: texto });
    expect(semChave.status).toBe(401);
    expect(semChave.json).toMatchObject({ error: expect.stringMatching(/chave do escritório/) });
    expect((await post(srv, '/api/messages', { agentId: MAIN, text: texto }, ERRADA)).status).toBe(401);
    // Nada entrou na fila da sessão.
    expect((await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json).toEqual({ messages: [] });

    const criada = await post(srv, '/api/messages', { agentId: MAIN, text: texto }, K);
    expect(criada.status).toBe(201);
    const msg = criada.json as OutboxMessage;
    const caixa = (await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' })).json as { messages: InboxMessage[] };
    expect(caixa.messages).toEqual([{ id: msg.id, text: texto }]);
    expect((await post(srv, '/api/mod/inbox/ack', { session: SESSION, results: [{ id: msg.id, ok: true }] })).json).toEqual({ ok: true });
    // A situação da mensagem é só leitura: a página consulta sem chave.
    expect(((await request(srv.base, `/api/messages/${encodeURIComponent(msg.id)}`)).json as OutboxMessage).status).toBe('delivered');
  });

  it('sem chave criada no computador, responder e mandar mensagem valem como na versão do autor (sem chave)', async () => {
    srv = await servir({ comChave: false });
    const reg = await post(srv, '/api/permissions', hookJson({ tool_name: 'AskUserQuestion', tool_input: { questions: PERGUNTAS }, permission_suggestions: [] }));
    const { id } = reg.json as { id: string };
    expect((await post(srv, `/api/permissions/${id}/decision`, RESPOSTA)).status).toBe(200);
    await post(srv, '/api/mod/inbox', { session: SESSION, account: 'acc' });
    expect((await post(srv, '/api/messages', { agentId: MAIN, text: 'oi' })).status).toBe(201);
  });
});

describe('nome da sala: o da equipe continua valendo com o "Renomear" do autor', () => {
  it('sala de equipe com nome próprio não é renomeada pela tela; as outras são', async () => {
    srv = await servir();
    const nomes = async () => new Map((await snapshot(srv!)).rooms.map((r) => [r.id, r.name]));
    expect((await nomes()).get(SOCIAL)).toBe('Equipe de Marketing');

    const recusado = await post(srv, '/api/rooms/rename', { id: SOCIAL, name: 'Outro nome' });
    expect(recusado.status).toBe(409);
    expect(recusado.json).toMatchObject({ error: expect.stringMatching(/Equipe de Marketing.*equipe nome/) });
    expect((await nomes()).get(SOCIAL)).toBe('Equipe de Marketing');
    expect(srv.aliases.get(SOCIAL)).toBeUndefined();

    // Mesmo que exista um nome de tela guardado para a pasta (rooms.json), o da equipe vale.
    srv.aliases.set(SOCIAL, 'Apelido antigo');
    srv.office.refreshRoomNames();
    expect((await nomes()).get(SOCIAL)).toBe('Equipe de Marketing');

    // Sala comum e sala de equipe sem nome próprio: o renomear do autor funciona, e vazio volta ao nome da pasta.
    expect((await post(srv, '/api/rooms/rename', { id: LOJA, name: 'Lojinha' })).json).toEqual({ name: 'Lojinha' });
    expect((await post(srv, '/api/rooms/rename', { id: SEM_NOME, name: 'Time de Produto' })).json).toEqual({ name: 'Time de Produto' });
    const depois = await nomes();
    expect(depois.get(LOJA)).toBe('Lojinha');
    expect(depois.get(SEM_NOME)).toBe('Time de Produto');
    expect((await post(srv, '/api/rooms/rename', { id: LOJA, name: '' })).json).toEqual({ name: 'loja' });
    expect((await post(srv, '/api/rooms/rename', { id: '/p/nao-existe', name: 'x' })).status).toBe(404);
  });
});

describe('personagem: agente fixo e o editor de personagem do autor', () => {
  function escritorio(names = new NameStore(null)) {
    const office = new Office({ names, jobs: new JobStore(null), equipe: () => EQ, version: '9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
    office.syncEquipe();
    return { office, names };
  }
  const agentes = (office: Office) => office.commit().snapshot.agents;
  const fixo = (office: Office, slug: string, sala = SOCIAL) => agentes(office).find((a) => a.staff === slug && a.roomId === sala && a.status !== 'offline')!;
  const comum = (office: Office, id: string, sessionId: string, cwd = SOCIAL) =>
    office.addMain({ id, account: 'acc', sessionId, cwd, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  const sessaoDoFixo = (office: Office, id: string, sessionId: string, slug: string) =>
    office.addMain({ id, account: 'acc', sessionId, cwd: SOCIAL, agent: slug, role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  const OTAVIO = { name: 'Otávio', look: 'm', seed: 4242 };

  it('o personagem da sala (sessão comum) não muda nem é tomado pelo agente fixo', () => {
    const { office, names } = escritorio();
    expect(fixo(office, 'cmo')).toMatchObject({ ...OTAVIO, parked: true });
    expect(fixo(office, 'cmo').custom).toBeUndefined();

    // Uma conversa comum na pasta da equipe salva o personagem da sala no editor.
    comum(office, 'acc:1', 's1');
    expect(office.setCharacter('acc:1', { name: 'Zeca', seed: 7, parts: {} })).toEqual({ result: 'ok' });
    expect(names.character(SOCIAL)).toMatchObject({ name: 'Zeca', seed: 7, owner: 's1' });

    // O CMO parado continua o Otávio; a sessão dele abre como o Otávio, e não como o personagem da sala.
    expect(fixo(office, 'cmo')).toMatchObject(OTAVIO);
    sessaoDoFixo(office, 'acc:2', 's2', 'cmo');
    const trabalhando = fixo(office, 'cmo');
    expect(trabalhando).toMatchObject({ ...OTAVIO, id: 'acc:2' });
    expect(trabalhando.custom).toBeUndefined();
    expect(trabalhando.parts).toBeUndefined();
    // /clear na sessão do agente fixo não o faz dono do personagem da sala.
    office.switchSession('acc:2', 's2b');
    expect(names.character(SOCIAL)?.owner).toBe('s1');
    expect(fixo(office, 'cmo')).toMatchObject(OTAVIO);
    // A conversa comum continua com o personagem dela.
    expect(agentes(office).find((a) => a.id === 'acc:1')).toMatchObject({ name: 'Zeca', seed: 7, custom: true });
  });

  it('editor num agente fixo parado: um personagem por agente, que vale também quando ele trabalha', () => {
    const { office, names } = escritorio();
    const parado = staffKey(SOCIAL, 'analista');
    const antes = fixo(office, 'analista');
    expect(office.setCharacter(parado, { name: 'Marina', seed: 99, parts: { accessory: 'glasses' } })).toEqual({ result: 'ok' });
    expect(fixo(office, 'analista')).toMatchObject({ id: parado, name: 'Marina', look: antes.look, seed: 99, parts: { accessory: 'glasses' }, custom: true, parked: true });
    // Não vira o personagem da sala, e o colega da mesma sala fica como estava.
    expect(names.character(SOCIAL)).toBeUndefined();
    expect(fixo(office, 'cmo')).toMatchObject(OTAVIO);

    sessaoDoFixo(office, 'acc:3', 's3', 'analista');
    expect(fixo(office, 'analista')).toMatchObject({ id: 'acc:3', name: 'Marina', seed: 99, parts: { accessory: 'glasses' }, custom: true });
    // Uma conversa comum que chega na sala não recebe o personagem do agente fixo.
    comum(office, 'acc:4', 's4');
    const visita = agentes(office).find((a) => a.id === 'acc:4')!;
    expect(visita.name).not.toBe('Marina');
    expect(visita.custom).toBeUndefined();
  });

  it('editor num agente fixo trabalhando vale na hora; "voltar" devolve o personagem escolhido pelo comando', () => {
    const { office, names } = escritorio();
    sessaoDoFixo(office, 'acc:2', 's2', 'cmo');
    expect(office.setCharacter('acc:2', { name: 'Otávio', seed: 5, parts: { topStyle: 'polo' } })).toEqual({ result: 'ok' });
    expect(fixo(office, 'cmo')).toMatchObject({ id: 'acc:2', name: 'Otávio', look: 'm', seed: 5, parts: { topStyle: 'polo' }, custom: true });
    expect(names.character(SOCIAL)).toBeUndefined();
    // O registro mudou por outro motivo (equipe editar em outro agente): o que o editor gravou continua valendo.
    office.syncEquipe();
    expect(fixo(office, 'cmo')).toMatchObject({ seed: 5, parts: { topStyle: 'polo' }, custom: true });

    expect(office.resetCharacter('acc:2')).toBe('ok');
    const voltou = fixo(office, 'cmo');
    expect(voltou).toMatchObject(OTAVIO);
    expect(voltou.custom).toBeUndefined();
    expect(voltou.parts).toBeUndefined();
    // Voltar num agente fixo que nunca foi editado não muda nada.
    expect(office.resetCharacter(staffKey(SOCIAL, 'analista'))).toBe('ok');
    expect(fixo(office, 'cmo')).toMatchObject(OTAVIO);
  });

  it('nome de agente fixo é só dele: nem outro agente fixo nem uma conversa comum pegam, mesmo com ele parado', () => {
    const { office } = escritorio();
    comum(office, 'acc:1', 's1');
    const outroFixo = office.setCharacter(staffKey(SOCIAL, 'analista'), { name: 'otávio', seed: 1, parts: {} });
    expect(outroFixo).toMatchObject({ result: 'conflict', message: expect.stringMatching(/Otávio já é um agente fixo em Equipe de Marketing/) });
    const conversa = office.setCharacter('acc:1', { name: 'Otávio', seed: 1, parts: {} });
    expect(conversa).toMatchObject({ result: 'conflict', message: expect.stringMatching(/agente fixo/) });
    // O nome que o editor deu a um agente fixo também fica reservado.
    expect(office.setCharacter(staffKey(SOCIAL, 'analista'), { name: 'Marina', seed: 1, parts: {} })).toEqual({ result: 'ok' });
    expect(office.setCharacter('acc:1', { name: 'Marina', seed: 2, parts: {} })).toMatchObject({ result: 'conflict' });
    expect(office.setCharacter(staffKey(SEM_NOME, 'dev'), { name: 'Marina', seed: 2, parts: {} })).toMatchObject({ result: 'conflict' });
    // Regravar o próprio agente com o mesmo nome (só mudou o visual) não é conflito.
    expect(office.setCharacter(staffKey(SOCIAL, 'analista'), { name: 'Marina', seed: 3, parts: {} })).toEqual({ result: 'ok' });
    // Quem não é agente fixo nem sessão aberta: não encontrado.
    expect(office.setCharacter(staffKey(SOCIAL, 'nao-existe'), { name: 'X', seed: 1, parts: {} })).toEqual({ result: 'not-found' });
    expect(office.resetCharacter(staffKey('/p/outra', 'cmo'))).toBe('not-found');
  });

  it('o personagem do agente fixo gravado pelo editor sobrevive a reiniciar o servidor (names.json)', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'names.json');
      const primeiro = new NameStore(file);
      const a = escritorio(primeiro);
      expect(a.office.setCharacter(staffKey(SOCIAL, 'cmo'), { name: 'Otávio', seed: 77, parts: { accessory: 'cap' } })).toEqual({ result: 'ok' });
      primeiro.flush();
      const segundo = new NameStore(file);
      segundo.load();
      const b = escritorio(segundo);
      expect(fixo(b.office, 'cmo')).toMatchObject({ name: 'Otávio', look: 'm', seed: 77, parts: { accessory: 'cap' }, custom: true });
      expect(fixo(b.office, 'analista').custom).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });

  it('pela rota do editor: o agente fixo parado (id com a pasta) é salvo e restaurado', async () => {
    srv = await servir();
    const id = encodeURIComponent(staffKey(SOCIAL, 'analista'));
    const salvo = await request(srv.base, `/api/agents/${id}/character`, { method: 'PUT', body: { name: 'Marina', seed: 99, parts: {} } });
    expect(salvo).toMatchObject({ status: 200, json: { ok: true } });
    const parado = (await snapshot(srv)).agents.find((a) => a.staff === 'analista')!;
    expect(parado).toMatchObject({ name: 'Marina', seed: 99, custom: true, parked: true });
    const conflito = await request(srv.base, `/api/agents/${id}/character`, { method: 'PUT', body: { name: 'Otávio', seed: 1, parts: {} } });
    expect(conflito.status).toBe(409);
    expect((await fetch(`${srv.base}/api/agents/${id}/character`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200);
    expect((await snapshot(srv)).agents.find((a) => a.staff === 'analista')?.custom).toBeUndefined();
    expect((await snapshot(srv)).agents.find((a) => a.staff === 'cmo')).toMatchObject({ name: 'Otávio', look: 'm', seed: 4242 });
  });
});
