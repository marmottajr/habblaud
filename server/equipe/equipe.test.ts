// Equipe (agentes fixos): o comando do host (equipe/equipe.mjs), o registro lido pelo servidor e como o
// escritório mostra quem está parado e quem está trabalhando.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { JobStore } from '../model/jobs';
import { NameStore } from '../model/names';
import { Office, staffKey } from '../model/office';
import { tempDir } from '../test/fixtures';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { createPermissionRoutes } from '../permissions/http';
import type { PermissionRegistry } from '../permissions/registry';
import { createEquipeRoutes, FilaDePedidos, limparPedido, MENSAGEM_TTL_MS, PENDENTE_TTL_MS, SERVICO_VIVO_MS } from './pedidos';
import { ATRASO_MAX_MS, INTERVALO_MIN, proximaOcorrencia, Rotinas, type Rotina } from './rotinas';
import { EquipeRegistro, parseRegistro, type Equipes } from './registro';

setQuiet(true);

// As preferências do computador (como os agentes chamam o dono, pastas protegidas) não entram nos testes: o
// registro padrão aponta para uma pasta vazia, e cada teste que precisa de um passa o seu.
process.env.HABBLAUD_EQUIPE_DIR = tempDir().dir;
// O nome do usuário do computador (o dono do escritório por padrão) também não: os textos esperam "o usuário".
process.env.EQUIPE_SEM_NOME_DO_COMPUTADOR = '1';


// O comando é JavaScript puro (roda no host sem compilar): entra sem tipos.
const CLI = resolve(__dirname, '../../equipe/equipe.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cli: any = await import(/* @vite-ignore */ CLI);

function projeto() {
  const tmp = tempDir();
  const dir = join(tmp.dir, 'social');
  mkdirSync(dir, { recursive: true });
  cli.prepararProjeto(dir);
  return { dir, reg: join(tmp.dir, 'reg'), cleanup: tmp.cleanup };
}

describe('comando equipe: agentes', () => {
  it('slug a partir da função', () => {
    expect(cli.slugDe('Analista de Mercado')).toBe('analista-de-mercado');
    expect(cli.slugDe('  Edição & Vídeo!! ')).toBe('edicao-video');
  });

  it('criar grava o arquivo do agente, o caderno e a equipe do projeto', () => {
    const p = projeto();
    try {
      cli.criarAgente(p.dir, 'roteirista', { funcao: 'Roteirista', descricao: 'Escreve os roteiros.', skills: ['esquete'], modelo: 'sonnet' });
      const arquivo = readFileSync(join(p.dir, '.claude/agents/roteirista.md'), 'utf8');
      expect(arquivo.startsWith('---\nname: roteirista\n')).toBe(true);
      expect(arquivo).toContain('model: sonnet');
      expect(arquivo).toContain('skills:\n  - esquete');
      expect(arquivo).toContain('Escreve os roteiros.');
      expect(arquivo).toContain(cli.MARCA_REGRAS);
      expect(arquivo).toContain('equipe fim');
      expect(readFileSync(join(p.dir, '.equipe/cadernos/roteirista.md'), 'utf8')).toContain('Caderno de Roteirista');
      expect(cli.lerConfig(p.dir).agentes.roteirista.funcao).toBe('Roteirista');
    } finally {
      p.cleanup();
    }
  });

  it('recusa nome inválido, repetido, sem função e arquivo de agente que já existia', () => {
    const p = projeto();
    try {
      expect(() => cli.criarAgente(p.dir, 'Com Espaço', { funcao: 'X' })).toThrow(/inválido/);
      expect(() => cli.criarAgente(p.dir, 'dev', {})).toThrow(/função/);
      cli.criarAgente(p.dir, 'dev', { funcao: 'Dev' });
      expect(() => cli.criarAgente(p.dir, 'dev', { funcao: 'Dev' })).toThrow(/já existe/);
      mkdirSync(join(p.dir, '.claude/agents'), { recursive: true });
      writeFileSync(join(p.dir, '.claude/agents/alheio.md'), '---\nname: alheio\n---\noi\n');
      expect(() => cli.criarAgente(p.dir, 'alheio', { funcao: 'Alheio' })).toThrow(/não é da equipe/);
    } finally {
      p.cleanup();
    }
  });

  it('editar troca cabeçalho e regras, e mantém o que o usuário escreveu', () => {
    const p = projeto();
    try {
      cli.criarAgente(p.dir, 'dev', { funcao: 'Dev' });
      const arquivo = join(p.dir, '.claude/agents/dev.md');
      const original = readFileSync(arquivo, 'utf8');
      writeFileSync(arquivo, original.replace('(Escreva aqui o que este agente faz, o que entrega e o que não é com ele.)', 'Cuida do servidor da loja.'));
      cli.editarAgente(p.dir, 'dev', { funcao: 'Desenvolvedor', modelo: 'haiku' });
      const depois = readFileSync(arquivo, 'utf8');
      expect(depois).toContain('Cuida do servidor da loja.');
      expect(depois).toContain('description: "Desenvolvedor do projeto social.');
      expect(depois).toContain('model: haiku');
      expect(depois.split(cli.MARCA_REGRAS)).toHaveLength(2);
    } finally {
      p.cleanup();
    }
  });

  it('apagar leva o arquivo e o caderno para a lixeira do projeto', () => {
    const p = projeto();
    try {
      cli.criarAgente(p.dir, 'dev', { funcao: 'Dev' });
      const destino = cli.apagarAgente(p.dir, 'dev');
      expect(existsSync(join(p.dir, '.claude/agents/dev.md'))).toBe(false);
      expect(readdirSync(destino).sort()).toEqual(['agente.json', 'agente.md', 'caderno.md']);
      expect(cli.lerConfig(p.dir).agentes.dev).toBeUndefined();
      expect(() => cli.apagarAgente(p.dir, 'dev')).toThrow(/não existe/);
    } finally {
      p.cleanup();
    }
  });
});

describe('comando equipe: demandas e passagem', () => {
  function comDois() {
    const p = projeto();
    cli.criarAgente(p.dir, 'analista', { funcao: 'Analista' });
    cli.criarAgente(p.dir, 'roteirista', { funcao: 'Roteirista' });
    cli.criarAgente(p.dir, 'video', { funcao: 'Vídeo' });
    return p;
  }

  it('cria a demanda com o pedido, as pastas das etapas e a primeira mensagem de cada agente', () => {
    const p = comDois();
    try {
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: 'Vídeo sobre grupos lotados', etapas: [{ agente: 'analista' }, { agente: 'roteirista' }] });
      expect(readFileSync(join(dir, 'pedido.md'), 'utf8')).toContain('Vídeo sobre grupos lotados');
      expect(existsSync(join(dir, '01-analista'))).toBe(true);
      expect(existsSync(join(dir, '02-roteirista'))).toBe(true);
      const msg = cli.pedidoDaEtapa(p.dir, dir, demanda, 2);
      expect(msg).toContain('etapa 2 de 2');
      expect(msg).toContain('01-analista/resultado.md');
      expect(msg).toContain('02-roteirista/resultado.md');
      const args = cli.argumentosDoClaude(p.dir, dir, demanda, 1, cli.lerConfig(p.dir));
      expect(args.slice(0, 4)).toEqual(['--agent', 'analista', '--name', 'Analista · Vídeo sobre grupos lotados']);
      expect(args).toContain('Bash(equipe fim)');
      expect(args.at(-2)).toBe('--');
    } finally {
      p.cleanup();
    }
  });

  it('permissão: vale a regra mais específica (agente, depois projeto, depois a geral); sem nenhuma, pergunta', () => {
    const p = comDois();
    try {
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }, { agente: 'roteirista' }] });
      const modo = (n: number) => {
        const a = cli.argumentosDoClaude(p.dir, dir, demanda, n, cli.lerConfig(p.dir), cli.lerPreferencias(p.reg)) as string[];
        const i = a.indexOf('--permission-mode');
        return i < 0 ? undefined : a[i + 1];
      };
      expect([modo(1), modo(2)]).toEqual(['manual', 'manual']);
      cli.definirPermissaoGeral('automático', p.reg);
      expect([modo(1), modo(2)]).toEqual(['auto', 'auto']);
      cli.definirPermissao(p.dir, 'edicoes');
      expect([modo(1), modo(2)]).toEqual(['acceptEdits', 'acceptEdits']);
      cli.editarAgente(p.dir, 'roteirista', { permissao: 'perguntar' });
      expect([modo(1), modo(2)]).toEqual(['acceptEdits', 'manual']);
      cli.editarAgente(p.dir, 'roteirista', { permissao: 'padrão' });
      // no projeto, "perguntar" vale por cima da regra geral (automático)
      cli.definirPermissao(p.dir, 'perguntar');
      expect([modo(1), modo(2)]).toEqual(['manual', 'manual']);
      cli.definirPermissao(p.dir, 'padrão');
      expect([modo(1), modo(2)]).toEqual(['auto', 'auto']);
      cli.definirPermissaoGeral('perguntar', p.reg);
      expect([modo(1), modo(2)]).toEqual(['manual', 'manual']);
      expect(() => cli.definirPermissaoGeral('bypassPermissions', p.reg)).toThrow(/desconhecida/);
      expect(() => cli.definirPermissao(p.dir, 'dontAsk')).toThrow(/desconhecida/);
      expect(() => cli.editarAgente(p.dir, 'analista', { permissao: 'dontAsk' })).toThrow(/desconhecida/);
    } finally {
      p.cleanup();
    }
  });

  it('título é só o começo, cortado em palavra inteira; o pedido vai inteiro no arquivo e a mensagem avisa', () => {
    const p = comDois();
    try {
      const longo = 'eu quero que você desenvolva 8 reels para mim, converse com o pesquisador e com o analista para ver o que mais traz resultado. ' + 'x '.repeat(300) + 'FIM-DO-PEDIDO';
      expect(cli.tituloDe('curto')).toBe('curto');
      const titulo = cli.tituloDe(longo) as string;
      expect([...titulo].length).toBeLessThanOrEqual(60);
      expect(titulo.endsWith('…')).toBe(true);
      expect(titulo).toBe('eu quero que você desenvolva 8 reels para mim, converse…');
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: longo, etapas: [{ agente: 'analista' }] });
      expect(demanda.titulo).toBe(titulo);
      const arquivo = readFileSync(join(dir, 'pedido.md'), 'utf8');
      expect(arquivo).toContain('## Pedido completo');
      expect(arquivo).toContain('FIM-DO-PEDIDO');
      const msg = cli.pedidoDaEtapa(p.dir, dir, demanda, 1) as string;
      expect(msg).toContain('O pedido completo, sem corte, está em: ');
      expect(msg).toContain('pedido.md');
    } finally {
      p.cleanup();
    }
  });

  it('liberar: o projeto dá aos agentes leitura ou edição de uma pasta de fora; regra torta é recusada', () => {
    const p = comDois();
    try {
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }] });
      const args = () => cli.argumentosDoClaude(p.dir, dir, demanda, 1, cli.lerConfig(p.dir), {}) as string[];
      expect(args()).not.toContain('Read(~/Pedidos/**)');
      cli.liberarNoProjeto(p.dir, 'Read(~/Pedidos/**)');
      cli.liberarNoProjeto(p.dir, 'Read(~/Pedidos/**)');
      expect(args().filter((a) => a === 'Read(~/Pedidos/**)')).toHaveLength(1);
      expect(args().at(-2)).toBe('--');
      expect(() => cli.liberarNoProjeto(p.dir, 'Bash(rm -rf:*)')).toThrow(/inválida/);
      expect(() => cli.liberarNoProjeto(p.dir, 'qualquer coisa')).toThrow(/inválida/);
      expect(cli.liberarNoProjeto(p.dir, 'Read(~/Pedidos/**)', true)).toEqual([]);
      expect(args()).not.toContain('Read(~/Pedidos/**)');
    } finally {
      p.cleanup();
    }
  });

  it('pasta de trabalho a mais vira --add-dir; pasta ampla ou inexistente é recusada', () => {
    const p = comDois();
    try {
      const fora = join(p.dir, '..', 'instalacao');
      mkdirSync(fora, { recursive: true });
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }] });
      const args = () => cli.argumentosDoClaude(p.dir, dir, demanda, 1, cli.lerConfig(p.dir), {}) as string[];
      expect(args()).not.toContain('--add-dir');
      const pastas = cli.pastaNoProjeto(p.dir, fora) as string[];
      cli.pastaNoProjeto(p.dir, fora);
      expect(pastas).toHaveLength(1);
      const a = args();
      expect(a.slice(a.indexOf('--add-dir'), a.indexOf('--add-dir') + 2)).toEqual(['--add-dir', pastas[0]]);
      expect(a.indexOf('--add-dir')).toBeLessThan(a.indexOf('--allowedTools'));
      expect(() => cli.pastaNoProjeto(p.dir, '/')).toThrow(/ampla/);
      expect(() => cli.pastaNoProjeto(p.dir, '~', false, '/Users/alguem')).toThrow(/ampla/);
      expect(() => cli.pastaNoProjeto(p.dir, join(p.dir, 'nao-existe'))).toThrow(/não existe/);
      expect(cli.pastaNoProjeto(p.dir, fora, true)).toEqual([]);
      expect(cli.regrasDaEquipe('x')).toContain('sem parar para pedir permissão');
      expect(cli.regrasDaEquipe('x')).toContain('--arquivo');
    } finally {
      p.cleanup();
    }
  });

  it('bloqueio do projeto vira --disallowedTools; o agente pode avisar o dono sem pedir permissão', () => {
    const p = comDois();
    try {
      const { dir, demanda } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }] });
      const args = () => cli.argumentosDoClaude(p.dir, dir, demanda, 1, cli.lerConfig(p.dir), {}) as string[];
      // Sem bloqueio do projeto, vale só o de sempre: a pasta do login de longa duração.
      expect(args().slice(args().indexOf('--disallowedTools') + 1, args().indexOf('--allowedTools'))).toEqual(cli.NEGADO_SEMPRE);
      cli.negarNoProjeto(p.dir, 'Read(**/.env)');
      cli.negarNoProjeto(p.dir, 'Edit(~/outro-sistema/**)');
      const a = args();
      const i = a.indexOf('--disallowedTools');
      expect(a.slice(i, i + 3 + cli.NEGADO_SEMPRE.length)).toEqual(['--disallowedTools', ...cli.NEGADO_SEMPRE, 'Read(**/.env)', 'Edit(~/outro-sistema/**)']);
      expect(i).toBeLessThan(a.indexOf('--allowedTools'));
      expect(() => cli.negarNoProjeto(p.dir, 'Bash(rm:*)')).toThrow(/inválida/);
      expect(cli.negarNoProjeto(p.dir, 'Read(**/.env)', true)).toEqual(['Edit(~/outro-sistema/**)']);
      expect(cli.LIBERADO).toContain('Bash(equipe avisar:*)');
      expect(cli.regrasDaEquipe('x')).toContain('equipe avisar');
    } finally {
      p.cleanup();
    }
  });

  it('recusa agente que não existe, pedido vazio e etapas demais', () => {
    const p = comDois();
    try {
      expect(() => cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'ninguem' }] })).toThrow(/não existe/);
      expect(() => cli.criarDemanda(p.dir, { pedido: '  ', etapas: [{ agente: 'analista' }] })).toThrow(/pedido/);
      const muitas = Array.from({ length: cli.ETAPAS_MAX + 1 }, () => ({ agente: 'analista' }));
      expect(() => cli.criarDemanda(p.dir, { pedido: 'x', etapas: muitas })).toThrow(/no máximo/);
    } finally {
      p.cleanup();
    }
  });

  it('fim exige o resultado; fechar a etapa abre a próxima ou conclui a demanda', () => {
    const p = comDois();
    try {
      const { dir } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }, { agente: 'roteirista' }] });
      const d = cli.lerDemanda(dir);
      d.etapas[0].estado = 'rodando';
      writeFileSync(join(dir, 'demanda.json'), JSON.stringify(d));
      expect(() => cli.marcarFim(dir, 1)).toThrow(/resultado/);
      writeFileSync(join(dir, '01-analista/resultado.md'), 'pesquisa pronta\n');
      cli.marcarFim(dir, 1);
      const r1 = cli.fecharEtapa(dir, 1);
      expect(r1.entregue).toBe(true);
      expect(r1.proxima.agente).toBe('roteirista');
      expect(r1.demanda.estado).toBe('rodando');
      writeFileSync(join(dir, '02-roteirista/resultado.md'), 'roteiro pronto\n');
      cli.marcarFim(dir, 2);
      const r2 = cli.fecharEtapa(dir, 2);
      expect(r2.proxima).toBeUndefined();
      expect(r2.demanda.estado).toBe('concluida');
    } finally {
      p.cleanup();
    }
  });

  it('sessão que fecha sem "equipe fim" deixa a demanda parada e não abre a próxima', () => {
    const p = comDois();
    try {
      const { dir } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }, { agente: 'roteirista' }] });
      const r = cli.fecharEtapa(dir, 1);
      expect(r.entregue).toBe(false);
      expect(r.proxima).toBeUndefined();
      expect(r.demanda.estado).toBe('parada');
      expect(r.demanda.etapas[1].estado).toBe('fila');
    } finally {
      p.cleanup();
    }
  });

  it('passar põe o colega logo depois de quem está trabalhando e renumera a fila', () => {
    const p = comDois();
    try {
      const { dir } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }, { agente: 'video' }] });
      expect(() => cli.passarPara(p.dir, dir, 1, 'roteirista', 'escreva')).toThrow(/em andamento/);
      const d = cli.lerDemanda(dir);
      d.etapas[0].estado = 'rodando';
      writeFileSync(join(dir, 'demanda.json'), JSON.stringify(d));
      expect(() => cli.passarPara(p.dir, dir, 1, 'ninguem', 'x')).toThrow(/não existe/);
      expect(() => cli.passarPara(p.dir, dir, 1, 'roteirista', '  ')).toThrow(/o que o colega/);
      const depois = cli.passarPara(p.dir, dir, 1, 'roteirista', 'Escreva o roteiro a partir da pesquisa.');
      expect(depois.etapas.map((e: { n: number; agente: string }) => `${e.n}:${e.agente}`)).toEqual(['1:analista', '2:roteirista', '3:video']);
      expect(depois.etapas[1].passadaPor).toBe('analista');
      expect(existsSync(join(dir, '02-roteirista'))).toBe(true);
      expect(existsSync(join(dir, '03-video'))).toBe(true);
      expect(existsSync(join(dir, '02-video'))).toBe(false);
    } finally {
      p.cleanup();
    }
  });

  it('vários colegas chamados na mesma etapa trabalham na ordem da chamada; quem volta recebe as entregas anteriores', () => {
    const p = comDois();
    try {
      const { dir } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }, { agente: 'video' }] });
      const d = cli.lerDemanda(dir);
      d.etapas[0].estado = 'rodando';
      writeFileSync(join(dir, 'demanda.json'), JSON.stringify(d));
      cli.passarPara(p.dir, dir, 1, 'roteirista', 'primeiro');
      const depois = cli.passarPara(p.dir, dir, 1, 'analista', 'segundo: devolva para mim');
      expect(depois.etapas.map((e: { agente: string; instrucao?: string }) => `${e.agente}:${e.instrucao ?? ''}`)).toEqual([
        'analista:',
        'roteirista:primeiro',
        'analista:segundo: devolva para mim',
        'video:',
      ]);
      const msg = cli.pedidoDaEtapa(p.dir, dir, depois, 3) as string;
      expect(msg).toContain('Resultado do colega anterior (roteirista)');
      expect(msg).toContain('etapa 1, analista: ');
      expect(msg).toContain('Quem passou o trabalho para você: analista.');
      expect(cli.regrasDaEquipe('x')).toContain('é o plano que decide');
    } finally {
      p.cleanup();
    }
  });

  it('a demanda tem teto de etapas: dois agentes não ficam passando o trabalho para sempre', () => {
    const p = comDois();
    try {
      const { dir } = cli.criarDemanda(p.dir, { pedido: 'x', etapas: [{ agente: 'analista' }] });
      const d = cli.lerDemanda(dir);
      d.etapas[0].estado = 'rodando';
      writeFileSync(join(dir, 'demanda.json'), JSON.stringify(d));
      for (let i = 1; i < cli.ETAPAS_MAX; i++) cli.passarPara(p.dir, dir, 1, 'roteirista', 'mais uma');
      expect(() => cli.passarPara(p.dir, dir, 1, 'roteirista', 'mais uma')).toThrow(/máximo/);
    } finally {
      p.cleanup();
    }
  });

  it('fluxo guarda a sequência; o registro traz o elenco e some quando a equipe acaba', () => {
    const p = comDois();
    try {
      expect(cli.criarFluxo(p.dir, 'video', ['analista', 'roteirista', 'video']).etapas).toHaveLength(3);
      expect(() => cli.criarFluxo(p.dir, 'x', ['ninguem'])).toThrow(/não existe/);
      expect(cli.lerFluxo(p.dir, 'video').etapas[1].agente).toBe('roteirista');
      const reg = cli.sincronizarRegistro(p.dir, p.reg);
      expect(reg.projetos[p.dir].agentes.map((a: { slug: string }) => a.slug)).toEqual(['analista', 'roteirista', 'video']);
      expect(reg.projetos[p.dir].nomeProprio).toBeUndefined();
      expect(cli.definirNome(p.dir, '  Equipe de   Marketing ')).toBe('Equipe de Marketing');
      expect(cli.sincronizarRegistro(p.dir, p.reg).projetos[p.dir]).toMatchObject({ nome: 'Equipe de Marketing', nomeProprio: true });
      expect(cli.definirNome(p.dir, '')).toBe('social');
      expect(cli.sincronizarRegistro(p.dir, p.reg).projetos[p.dir].nome).toBe('social');
      for (const s of ['analista', 'roteirista', 'video']) cli.apagarAgente(p.dir, s);
      expect(cli.sincronizarRegistro(p.dir, p.reg).projetos[p.dir]).toBeUndefined();
    } finally {
      p.cleanup();
    }
  });
});

describe('registro da equipe (servidor)', () => {
  it('lê o elenco por sala e ignora o que vier torto', () => {
    const m = parseRegistro(
      JSON.stringify({
        projetos: {
          '/p/social/': { nome: 'social', agentes: [{ slug: 'roteirista', funcao: ' Roteirista ' }, { slug: 'Ruim', funcao: 'x' }, { slug: 'sem-funcao' }, { slug: 'roteirista', funcao: 'Repetido' }] },
          'relativo/nao-vale': { nome: 'x', agentes: [{ slug: 'dev', funcao: 'Dev' }] },
          '/p/vazio': { nome: 'vazio', agentes: [] },
        },
      }),
    );
    expect([...m.keys()]).toEqual(['/p/social']);
    expect(m.get('/p/social')?.agentes).toEqual([{ slug: 'roteirista', funcao: 'Roteirista' }]);
    expect(parseRegistro('isto não é json').size).toBe(0);
  });

  it('relê quando o arquivo muda e esvazia quando ele some', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'registro.json');
      const reg = new EquipeRegistro({ file });
      expect(reg.load()).toBe(false);
      writeFileSync(file, JSON.stringify({ projetos: { '/p/a': { nome: 'a', agentes: [{ slug: 'dev', funcao: 'Dev' }] } } }));
      expect(reg.load()).toBe(true);
      expect(reg.load()).toBe(false);
      expect(reg.equipes().get('/p/a')?.agentes[0].slug).toBe('dev');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('escritório com agentes fixos', () => {
  function cenario(equipes: Equipes) {
    const state = { equipes };
    const names = new NameStore(null);
    const office = new Office({
      names,
      jobs: new JobStore(null),
      equipe: () => state.equipes,
      version: '9.9.9',
      startedAt: Date.now(),
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
    });
    office.syncEquipe();
    return { office, state, names };
  }
  const SOCIAL = new Map([['/p/social', { nome: 'social', agentes: [{ slug: 'roteirista', funcao: 'Roteirista' }, { slug: 'video', funcao: 'Editor de vídeo' }] }]]);
  const sessao = (id: string, agent?: string) => ({ id, account: '.claude', sessionId: `s-${id}`, cwd: '/p/social', role: 'Agente principal', agent, startedAt: 1, status: 'working' as const });

  it('sem sessão nenhuma, a sala existe e os agentes fixos estão lá, parados, com a função', () => {
    const { office } = cenario(SOCIAL);
    const snap = office.commit().snapshot;
    expect(snap.rooms.map((r) => r.id)).toEqual(['/p/social']);
    expect(snap.agents.map((a) => [a.staff, a.job, a.parked, a.status])).toEqual([
      ['roteirista', 'Roteirista', true, 'idle'],
      ['video', 'Editor de vídeo', true, 'idle'],
    ]);
    expect(new Set(snap.agents.map((a) => a.name)).size).toBe(2);
    expect(office.has(snap.agents[0].id)).toBe(false);
  });

  it('a sessão aberta com o agente assume o mesmo personagem (nome e aparência) e o parado some', () => {
    const { office } = cenario(SOCIAL);
    const antes = office.commit().snapshot.agents.find((a) => a.staff === 'roteirista')!;
    office.addMain(sessao('.claude:10', 'roteirista'));
    const snap = office.commit().snapshot;
    const vivos = snap.agents.filter((a) => a.staff === 'roteirista');
    expect(vivos).toHaveLength(1);
    expect(vivos[0]).toMatchObject({ id: '.claude:10', name: antes.name, seed: antes.seed, job: 'Roteirista', role: 'Agente fixo', status: 'working' });
    expect(vivos[0].parked).toBeUndefined();
    expect(snap.agents.find((a) => a.staff === 'video')?.parked).toBe(true);
  });

  it('quando a sessão fecha, o agente fixo volta a ficar parado com o mesmo nome', () => {
    const { office } = cenario(SOCIAL);
    const nome = office.commit().snapshot.agents.find((a) => a.staff === 'roteirista')!.name;
    office.addMain(sessao('.claude:10', 'roteirista'));
    office.commit();
    office.closeMain('.claude:10');
    const volta = office.commit().snapshot.agents.find((a) => a.staff === 'roteirista' && a.parked);
    expect(volta?.name).toBe(nome);
    expect(volta?.id).toBe(staffKey('/p/social', 'roteirista'));
  });

  it('sessão comum na mesma sala não pega o nome de um agente fixo, e a função do fixo não se edita pela tela', () => {
    const { office } = cenario(SOCIAL);
    const reservados = office.commit().snapshot.agents.map((a) => a.name);
    office.addMain(sessao('.claude:11'));
    office.addMain(sessao('.claude:12', 'roteirista'));
    const snap = office.commit().snapshot;
    expect(reservados).not.toContain(snap.agents.find((a) => a.id === '.claude:11')!.name);
    expect(office.setJob('.claude:12', 'Outra coisa')).toBeNull();
    expect(office.setJob('.claude:11', 'Estrategista')).toBe('Estrategista');
  });

  it('duas sessões do mesmo agente (a etapa seguinte abre com a anterior fechando): as duas são o mesmo personagem', () => {
    const { office } = cenario(SOCIAL);
    const fixo = office.commit().snapshot.agents.find((a) => a.staff === 'roteirista')!;
    office.addMain(sessao('.claude:10', 'roteirista'));
    office.addMain(sessao('.claude:11', 'roteirista'));
    const dois = office.commit().snapshot.agents.filter((a) => a.staff === 'roteirista');
    expect(dois).toHaveLength(2);
    expect(dois.map((a) => [a.name, a.seed, a.job, a.parked])).toEqual([
      [fixo.name, fixo.seed, 'Roteirista', undefined],
      [fixo.name, fixo.seed, 'Roteirista', undefined],
    ]);
  });

  it('o nome que a equipe escolheu vira o nome da sala; sem nome próprio vale o da pasta', () => {
    const comNome = cenario(new Map([['/p/social', { nome: 'Equipe de Marketing', nomeProprio: true, agentes: [{ slug: 'dev', funcao: 'Dev' }] }]]));
    expect(comNome.office.commit().snapshot.rooms[0].name).toBe('Equipe de Marketing');
    expect(cenario(SOCIAL).office.commit().snapshot.rooms[0].name).toBe('social');
    const reg = parseRegistro(JSON.stringify({ projetos: { '/p/a': { nome: ' Equipe de Marketing ', nomeProprio: true, agentes: [{ slug: 'dev', funcao: 'Dev' }] }, '/p/b': { nome: 'b', agentes: [{ slug: 'dev', funcao: 'Dev' }] } } }));
    expect(reg.get('/p/a')).toMatchObject({ nome: 'Equipe de Marketing', nomeProprio: true });
    expect(reg.get('/p/b')?.nomeProprio).toBeUndefined();
  });

  it('função editada na equipe chega em quem está trabalhando; equipe apagada libera a sala', () => {
    const { office, state } = cenario(SOCIAL);
    office.addMain(sessao('.claude:10', 'roteirista'));
    state.equipes = new Map([['/p/social', { nome: 'social', agentes: [{ slug: 'roteirista', funcao: 'Roteirista chefe' }] }]]);
    office.syncEquipe();
    const snap = office.commit().snapshot;
    expect(snap.agents.map((a) => a.job)).toEqual(['Roteirista chefe']);

    const vazio = cenario(SOCIAL);
    vazio.state.equipes = new Map();
    vazio.office.syncEquipe();
    const s2 = vazio.office.commit().snapshot;
    expect(s2.rooms).toEqual([]);
    expect(s2.agents).toEqual([]);
  });
});

describe('demanda pedida pela tela do escritório', () => {
  const EQUIPES: Equipes = new Map([['/p/social', { nome: 'social', agentes: [{ slug: 'estrategista', funcao: 'Estrategista' }] }]]);

  function fila(extra: { now?: () => number; semChave?: boolean } = {}) {
    const tmp = tempDir();
    const keyFile = join(tmp.dir, 'chave');
    if (!extra.semChave) writeFileSync(keyFile, 'chave-de-teste-com-mais-de-vinte\n');
    let n = 0;
    return { f: new FilaDePedidos({ equipes: () => EQUIPES, keyFile, now: extra.now, newId: () => `p${++n}` }), cleanup: tmp.cleanup };
  }

  it('limpa o texto: mantém as quebras de linha, tira caractere de controle e corta no tamanho', () => {
    expect(limparPedido('  linha 1\r\nlinha 2\u0000\u0007  ')).toBe('linha 1\nlinha 2');
    expect(limparPedido('x'.repeat(50), 10)).toHaveLength(10);
    expect(limparPedido('   ')).toBeUndefined();
    expect(limparPedido(42)).toBeUndefined();
  });

  it('sem o arquivo da chave o recurso fica desligado; chave errada não passa', () => {
    const sem = fila({ semChave: true });
    const com = fila();
    try {
      expect(sem.f.ligado()).toBe(false);
      expect(sem.f.conferirChave('qualquer-coisa')).toBe('desligado');
      expect(com.f.ligado()).toBe(true);
      expect(com.f.conferirChave(undefined)).toBe('errada');
      expect(com.f.conferirChave('outra-chave-qualquer-bem-longa')).toBe('errada');
      expect(com.f.conferirChave(' chave-de-teste-com-mais-de-vinte ')).toBe('ok');
    } finally {
      sem.cleanup();
      com.cleanup();
    }
  });

  it('só aceita demanda para agente da equipe do projeto, com texto', () => {
    const { f, cleanup } = fila();
    try {
      expect(() => f.criar({ room: '/p/social', slug: 'ninguem', pedido: 'x' })).toThrow(/não é da equipe/);
      expect(() => f.criar({ room: '/p/outro', slug: 'estrategista', pedido: 'x' })).toThrow(/não é da equipe/);
      expect(() => f.criar({ room: '/p/social', slug: 'estrategista', pedido: '  ' })).toThrow(/escreva/);
      expect(() => f.criar({ slug: 'estrategista', pedido: 'x' })).toThrow(/esperado/);
      const p = f.criar({ room: '/p/social/', slug: 'estrategista', pedido: 'Monte 8 Reels' });
      expect(p).toMatchObject({ id: 'p1', room: '/p/social', slug: 'estrategista', pedido: 'Monte 8 Reels', estado: 'pendente' });
    } finally {
      cleanup();
    }
  });

  it('o serviço busca, resolve uma vez só, e a consulta marca o serviço como vivo', () => {
    let agora = 1_000_000;
    const { f, cleanup } = fila({ now: () => agora });
    try {
      expect(f.servicoAtivo()).toBe(false);
      const p = f.criar({ room: '/p/social', slug: 'estrategista', pedido: 'x' });
      expect(f.pendentes().map((x) => x.id)).toEqual([p.id]);
      expect(f.servicoAtivo()).toBe(true);
      expect(f.resolver(p.id, { ok: true, demanda: '2026-10-09-0001-x' })).toBe(true);
      expect(f.resolver(p.id, { ok: true })).toBe(false);
      expect(f.get(p.id)).toMatchObject({ estado: 'aberta', demanda: '2026-10-09-0001-x' });
      expect(f.pendentes()).toEqual([]);
      const q = f.criar({ room: '/p/social', slug: 'estrategista', pedido: 'y' });
      f.resolver(q.id, { ok: false, erro: 'não deu' });
      expect(f.get(q.id)).toMatchObject({ estado: 'erro', erro: 'não deu' });
      agora += SERVICO_VIVO_MS + 1;
      expect(f.servicoAtivo()).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('pedido que o serviço não busca expira com o motivo', () => {
    let agora = 1_000_000;
    const { f, cleanup } = fila({ now: () => agora });
    try {
      const p = f.criar({ room: '/p/social', slug: 'estrategista', pedido: 'x' });
      agora += PENDENTE_TTL_MS + 1;
      expect(f.get(p.id)).toMatchObject({ estado: 'expirado' });
      expect(f.get(p.id)?.erro).toMatch(/não está rodando/);
      expect(f.resolver(p.id, { ok: true })).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rotas: estado sem chave; o resto exige a chave, JSON e o próprio computador', async () => {
    const { f, cleanup } = fila();
    const tmp = tempDir();
    const dir = join(tmp.dir, '.claude');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
    const office = new Office({ names: new NameStore(null), version: '9', startedAt: Date.now(), accounts: (x) => accounts.list(x), sources: () => [], accountName: () => undefined });
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9', inDocker: false, equipe: createEquipeRoutes(f) });
    const semRecurso = createApiHandler({ office, hub, accounts, sources: () => [], version: '9', inDocker: false });
    const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      const handler = url.searchParams.has('sem') ? semRecurso : api;
      if (!handler(req, res, url)) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const K = { 'X-Equipe-Chave': 'chave-de-teste-com-mais-de-vinte' };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(`${base}/api/equipe/estado`)).json()).toEqual({ ligado: true, servico: false });
      const pedido = { room: '/p/social', slug: 'estrategista', pedido: 'Monte 8 Reels' };
      expect((await post('/api/equipe/demandas', pedido)).status).toBe(401);
      expect((await post('/api/equipe/demandas', pedido, { 'X-Equipe-Chave': 'errada-errada-errada-errada' })).status).toBe(401);
      expect((await post('/api/equipe/demandas', pedido, { ...K, Origin: 'https://site-de-fora.example' })).status).toBe(403);
      expect((await post('/api/equipe/demandas', { ...pedido, slug: 'ninguem' }, K)).status).toBe(400);
      expect((await fetch(`${base}/api/equipe/pedidos`)).status).toBe(401);
      expect((await post('/api/equipe/demandas?sem=1', pedido, K)).status).toBe(403);

      const criado = await post('/api/equipe/demandas', pedido, K);
      expect(criado.status).toBe(201);
      const { id } = (await criado.json()) as { id: string };
      const lista = (await (await fetch(`${base}/api/equipe/pedidos`, { headers: K })).json()) as { pedidos: Array<{ id: string; pedido: string }> };
      expect(lista.pedidos).toMatchObject([{ id, pedido: 'Monte 8 Reels' }]);
      expect((await post(`/api/equipe/pedidos/${id}`, { ok: true, demanda: 'd1' }, K)).status).toBe(200);
      expect((await post(`/api/equipe/pedidos/${id}`, { ok: true }, K)).status).toBe(404);
      expect(await (await fetch(`${base}/api/equipe/demandas/${id}`, { headers: K })).json()).toMatchObject({ estado: 'aberta', demanda: 'd1', servico: true });
      expect((await fetch(`${base}/api/equipe/demandas/nao-existe`, { headers: K })).status).toBe(404);

      // Um nome liberado na rede não manda demanda: só o próprio computador.
      const rede = await new Promise<number>((ok, fail) => {
        const u = new URL(base);
        const req = http.request({ host: u.hostname, port: u.port, path: '/api/equipe/demandas', method: 'POST', headers: { Host: 'habblaud.lan', 'Content-Type': 'application/json', ...K } }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        });
        req.on('error', fail);
        req.end(JSON.stringify(pedido));
      });
      expect(rede).toBe(403);
    } finally {
      hub.stop();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      cleanup();
      tmp.cleanup();
    }
  });

  it('serviço do host: cria a chave uma vez, só atende projeto e agente registrados e prepara o terminal', () => {
    const p = projeto();
    try {
      const chave = cli.chaveDoEscritorio(p.reg);
      expect(chave.length).toBeGreaterThanOrEqual(20);
      expect(cli.chaveDoEscritorio(p.reg)).toBe(chave);
      expect(cli.chaveDoEscritorio(join(p.reg, 'outra'), false)).toBeUndefined();

      cli.criarAgente(p.dir, 'estrategista', { funcao: 'Estrategista' });
      cli.sincronizarRegistro(p.dir, p.reg);
      const fora = cli.atenderPedido({ room: '/p/nao-registrado', slug: 'estrategista', pedido: 'x' }, { registro: p.reg, simular: true });
      expect(fora).toMatchObject({ ok: false });
      expect(cli.atenderPedido({ room: p.dir, slug: 'ninguem', pedido: 'x' }, { registro: p.reg, simular: true })).toMatchObject({ ok: false });
      const r = cli.atenderPedido({ room: p.dir, slug: 'estrategista', pedido: 'Monte 8 Reels\ncom o pesquisador' }, { registro: p.reg, simular: true });
      expect(r.ok).toBe(true);
      const [{ dir, demanda }] = cli.listarDemandas(p.dir);
      expect(demanda.id).toBe(r.demanda);
      expect(readFileSync(join(dir, 'pedido.md'), 'utf8')).toContain('com o pesquisador');
      expect(existsSync(join(dir, '01-estrategista/rodar.command'))).toBe(true);

      // Sem login no Claude Code do terminal, a demanda nem é criada: o motivo volta para a tela.
      const semLogin = cli.atenderPedido({ room: p.dir, slug: 'estrategista', pedido: 'outra' }, { registro: p.reg, login: () => false });
      expect(semLogin).toEqual({ ok: false, erro: cli.SEM_LOGIN });
      expect(cli.listarDemandas(p.dir)).toHaveLength(1);

      const plist = cli.conteudoDoPlist('/opt/node/bin/node', '/x/equipe.mjs', '/Users/alguem');
      expect(plist).toContain('<string>servir</string>');
      expect(plist).toContain('<key>KeepAlive</key><true/>');
      expect(plist).toContain('/Users/alguem/.habblaud/equipe/servico.log');
    } finally {
      p.cleanup();
    }
  });
});

describe('rotinas dos agentes fixos', () => {
  // 2026-10-05 é uma segunda-feira (dia 1).
  const seg8h = new Date(2026, 9, 5, 8, 0, 0).getTime();

  it('próxima ocorrência: hoje mais tarde, o próximo dia marcado, ou a semana seguinte', () => {
    expect(new Date(proximaOcorrencia([1], '09:00', seg8h)).toString()).toBe(new Date(2026, 9, 5, 9, 0, 0).toString());
    expect(new Date(proximaOcorrencia([1], '07:00', seg8h)).toString()).toBe(new Date(2026, 9, 12, 7, 0, 0).toString());
    expect(new Date(proximaOcorrencia([3, 5], '09:30', seg8h)).toString()).toBe(new Date(2026, 9, 7, 9, 30, 0).toString());
    expect(proximaOcorrencia([], '09:00', seg8h)).toBe(Number.POSITIVE_INFINITY);
    expect(proximaOcorrencia([1], '25:00', seg8h)).toBe(Number.POSITIVE_INFINITY);
  });

  function rotinas(extra: { existe?: (room: string, slug: string) => boolean } = {}) {
    let agora = seg8h;
    const disparadas: Rotina[] = [];
    let n = 0;
    const r = new Rotinas({ file: null, existe: extra.existe ?? ((room, slug) => room === '/p/social' && slug === 'analista'), disparar: (x) => void disparadas.push({ ...x }), now: () => agora, newId: () => `r${++n}` });
    return { r, disparadas, avancar: (ms: number) => (agora += ms), ir: (t: number) => (agora = t) };
  }
  const BASE = { room: '/p/social/', slug: 'analista', pedido: 'Relatório de ontem', dias: [1, 2, 3, 4, 5], hora: '09:00' };

  it('cria com validação e lista por sala', () => {
    const { r } = rotinas();
    expect(() => r.criar({ ...BASE, slug: 'ninguem' })).toThrow(/não é da equipe/);
    expect(() => r.criar({ ...BASE, pedido: ' ' })).toThrow(/escreva/);
    expect(() => r.criar({ ...BASE, dias: [] })).toThrow(/dia/);
    expect(() => r.criar({ ...BASE, dias: [9] })).toThrow(/dia/);
    expect(() => r.criar({ ...BASE, hora: '9h' })).toThrow(/hora/);
    const nova = r.criar(BASE);
    expect(nova).toMatchObject({ id: 'r1', room: '/p/social', slug: 'analista', ativa: true, dias: [1, 2, 3, 4, 5], hora: '09:00' });
    expect(nova.proxima).toBe(new Date(2026, 9, 5, 9, 0, 0).getTime());
    expect(r.listar('/p/social')).toHaveLength(1);
    expect(r.listar('/p/outro')).toHaveLength(0);
  });

  it('na hora marcada dispara uma vez e marca a próxima; antes da hora não faz nada', () => {
    const { r, disparadas, avancar } = rotinas();
    r.criar(BASE);
    expect(r.tick()).toBe(0);
    avancar(61 * 60_000);
    expect(r.tick()).toBe(1);
    expect(r.tick()).toBe(0);
    expect(disparadas).toMatchObject([{ slug: 'analista', pedido: 'Relatório de ontem' }]);
    expect(r.listar()[0].proxima).toBe(new Date(2026, 9, 6, 9, 0, 0).getTime());
    expect(r.listar()[0].ultima).toBeDefined();
  });

  it('muito atrasada (computador desligado) não roda: pula para a próxima vez e diz por quê', () => {
    const { r, disparadas, avancar } = rotinas();
    r.criar(BASE);
    avancar(60 * 60_000 + ATRASO_MAX_MS + 60_000);
    expect(r.tick()).toBe(0);
    expect(disparadas).toHaveLength(0);
    expect(r.listar()[0].ultimoAviso).toMatch(/pulada/);
    expect(r.listar()[0].proxima).toBe(new Date(2026, 9, 6, 9, 0, 0).getTime());
  });

  it('desligada não roda; religar conta a partir de agora; agente que saiu da equipe não roda; apagar tira', () => {
    let existe = true;
    const { r, disparadas, avancar } = rotinas({ existe: () => existe });
    const nova = r.criar(BASE);
    r.ligar(nova.id, false);
    avancar(2 * 3_600_000);
    expect(r.tick()).toBe(0);
    expect(r.ligar(nova.id, true)?.proxima).toBe(new Date(2026, 9, 6, 9, 0, 0).getTime());
    existe = false;
    avancar(24 * 3_600_000);
    expect(r.tick()).toBe(0);
    expect(r.listar()[0].ultimoAviso).toMatch(/não é mais da equipe/);
    expect(disparadas).toHaveLength(0);
    expect(r.apagar(nova.id)).toBe(true);
    expect(r.apagar(nova.id)).toBe(false);
    expect(r.ligar('nao-existe', true)).toBeUndefined();
  });

  it('rotina por intervalo: roda a cada tantos minutos, com mínimo e máximo', () => {
    const { r, disparadas, avancar } = rotinas();
    expect(() => r.criar({ room: '/p/social', slug: 'analista', pedido: 'x', intervaloMin: INTERVALO_MIN - 1 })).toThrow(/intervalo/);
    expect(() => r.criar({ room: '/p/social', slug: 'analista', pedido: 'x', intervaloMin: 2.5 })).toThrow(/intervalo/);
    expect(() => r.criar({ room: '/p/social', slug: 'analista', pedido: 'x', intervaloMin: 999_999 })).toThrow(/intervalo/);
    const nova = r.criar({ room: '/p/social', slug: 'analista', pedido: 'Confira os comentários', intervaloMin: 120 });
    expect(nova).toMatchObject({ intervaloMin: 120, dias: [], hora: '' });
    expect(nova.proxima).toBe(seg8h + 120 * 60_000);
    avancar(119 * 60_000);
    expect(r.tick()).toBe(0);
    avancar(2 * 60_000);
    expect(r.tick()).toBe(1);
    expect(disparadas).toHaveLength(1);
    expect(r.listar()[0].proxima).toBe(seg8h + 121 * 60_000 + 120 * 60_000);
  });

  it('editar troca o prompt, o agente e o quando; rodar agora dispara sem mexer na próxima vez', () => {
    const { r, disparadas } = rotinas({ existe: (room, slug) => room === '/p/social' && ['analista', 'revisor'].includes(slug) });
    const nova = r.criar(BASE);
    const proxima = nova.proxima;
    expect(r.editar(nova.id, { pedido: 'Relatório da semana' })).toMatchObject({ pedido: 'Relatório da semana', proxima });
    expect(r.editar(nova.id, { slug: 'revisor' })).toMatchObject({ slug: 'revisor' });
    expect(() => r.editar(nova.id, { slug: 'ninguem' })).toThrow(/não é da equipe/);
    expect(() => r.editar(nova.id, { pedido: '   ' })).toThrow(/escreva/);
    expect(r.editar(nova.id, { intervaloMin: 60 })).toMatchObject({ intervaloMin: 60, dias: [], hora: '', proxima: seg8h + 3_600_000 });
    expect(r.editar(nova.id, { dias: [6], hora: '10:30', intervaloMin: 0 })).toMatchObject({ dias: [6], hora: '10:30' });
    expect(r.listar()[0].intervaloMin).toBeUndefined();
    expect(() => r.editar(nova.id, { hora: '99:00' })).toThrow(/hora/);
    expect(r.editar('nao-existe', { pedido: 'x' })).toBeUndefined();

    const antes = r.listar()[0].proxima;
    expect(r.rodarAgora(nova.id)).toMatchObject({ slug: 'revisor' });
    expect(disparadas).toMatchObject([{ slug: 'revisor', pedido: 'Relatório da semana' }]);
    expect(r.listar()[0].proxima).toBe(antes);
    expect(r.rodarAgora('nao-existe')).toBeUndefined();
  });

  it('guarda em arquivo e relê', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'dados', 'rotinas.json');
      const a = new Rotinas({ file, existe: () => true, disparar: () => {}, now: () => seg8h });
      a.criar(BASE);
      const b = new Rotinas({ file, existe: () => true, disparar: () => {}, now: () => seg8h });
      b.load();
      expect(b.listar()).toMatchObject([{ pedido: 'Relatório de ontem', hora: '09:00', ativa: true }]);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('recado para o agente que está trabalhando e aprovação protegida pela chave', () => {
  const EQ: Equipes = new Map([['/p/social', { nome: 'social', agentes: [{ slug: 'analista', funcao: 'Analista' }] }]]);
  const VIVOS = [
    { id: '.claude:4242', kind: 'main', staff: 'analista', status: 'working' },
    { id: '.claude:5000', kind: 'main', status: 'working' },
    { id: 'equipe:/p/social:analista', kind: 'main', staff: 'analista', status: 'idle' },
    { id: '.claude:6000', kind: 'main', staff: 'analista', status: 'offline' },
  ];

  function fila(now?: () => number) {
    const tmp = tempDir();
    const keyFile = join(tmp.dir, 'chave');
    writeFileSync(keyFile, 'chave-de-teste-com-mais-de-vinte\n');
    let n = 0;
    return { f: new FilaDePedidos({ equipes: () => EQ, keyFile, agentes: () => VIVOS, now, newId: () => `m${++n}` }), cleanup: tmp.cleanup };
  }

  it('só para agente fixo com sessão aberta; vai numa linha; a sessão busca pelo processo e confirma', () => {
    const { f, cleanup } = fila();
    try {
      expect(() => f.criarMensagem({ agentId: '.claude:5000', texto: 'oi' })).toThrow(/sessão aberta/);
      expect(() => f.criarMensagem({ agentId: 'equipe:/p/social:analista', texto: 'oi' })).toThrow();
      expect(() => f.criarMensagem({ agentId: '.claude:6000', texto: 'oi' })).toThrow(/sessão aberta/);
      expect(() => f.criarMensagem({ agentId: 'nao-existe', texto: 'oi' })).toThrow(/sessão aberta/);
      expect(() => f.criarMensagem({ agentId: '.claude:4242', texto: '  ' })).toThrow(/escreva/);
      const m = f.criarMensagem({ agentId: '.claude:4242', texto: 'Use o tom\nmais direto' });
      expect(m).toMatchObject({ id: 'm1', pid: 4242, slug: 'analista', texto: 'Use o tom mais direto', estado: 'pendente' });
      expect(f.mensagensDe(9999)).toEqual([]);
      expect(f.mensagensDe(4242).map((x) => x.id)).toEqual(['m1']);
      expect(f.resolverMensagem('m1', { ok: true })).toBe(true);
      expect(f.resolverMensagem('m1', { ok: true })).toBe(false);
      expect(f.getMensagem('m1')?.estado).toBe('entregue');
      expect(f.mensagensDe(4242)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('recado que a sessão não busca expira com o motivo', () => {
    let agora = 5_000_000;
    const { f, cleanup } = fila(() => agora);
    try {
      const m = f.criarMensagem({ agentId: '.claude:4242', texto: 'oi' });
      agora += MENSAGEM_TTL_MS + 1;
      expect(f.getMensagem(m.id)).toMatchObject({ estado: 'expirado' });
      expect(f.resolverMensagem(m.id, { ok: true })).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rotas de recado e de rotina exigem a chave; aprovar permissão pela página exige a chave quando ela existe', async () => {
    const { f, cleanup } = fila();
    const tmp = tempDir();
    const dir = join(tmp.dir, '.claude');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
    const office = new Office({ names: new NameStore(null), version: '9', startedAt: Date.now(), accounts: (x) => accounts.list(x), sources: () => [], accountName: () => undefined });
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const rot = new Rotinas({ file: null, existe: (room, slug) => !!EQ.get(room)?.agentes.some((a) => a.slug === slug), disparar: () => {} });
    const decididos: string[] = [];
    const registry = { decide: (id: string) => (decididos.push(id), 'ok') } as unknown as PermissionRegistry;
    const api = createApiHandler({
      office,
      hub,
      accounts,
      sources: () => [],
      version: '9',
      inDocker: false,
      equipe: createEquipeRoutes(f, rot),
      permissions: createPermissionRoutes(registry, { conferirChave: (k) => f.conferirChave(k) }),
    });
    const guard = createRequestGuard({ allowedHosts: new Set() });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const K = { 'X-Equipe-Chave': 'chave-de-teste-com-mais-de-vinte' };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      // recado
      expect((await post('/api/equipe/mensagens', { agentId: '.claude:4242', texto: 'oi' })).status).toBe(401);
      const criado = await post('/api/equipe/mensagens', { agentId: '.claude:4242', texto: 'Qual a fonte desse número?' }, K);
      expect(criado.status).toBe(201);
      const { id } = (await criado.json()) as { id: string };
      expect((await fetch(`${base}/api/equipe/mensagens?pid=4242`)).status).toBe(401);
      const lista = (await (await fetch(`${base}/api/equipe/mensagens?pid=4242`, { headers: K })).json()) as { mensagens: Array<{ id: string; texto: string }> };
      expect(lista.mensagens).toMatchObject([{ id, texto: 'Qual a fonte desse número?' }]);
      expect((await post(`/api/equipe/mensagens/${id}`, { ok: true }, K)).status).toBe(200);
      expect(await (await fetch(`${base}/api/equipe/mensagens/${id}`, { headers: K })).json()).toMatchObject({ estado: 'entregue' });
      expect((await post('/api/equipe/mensagens', { agentId: '.claude:5000', texto: 'oi' }, K)).status).toBe(400);

      // rotina
      const rotina = { room: '/p/social', slug: 'analista', pedido: 'Relatório de ontem', dias: [1, 3, 5], hora: '09:00' };
      expect((await post('/api/equipe/rotinas', rotina)).status).toBe(401);
      expect((await post('/api/equipe/rotinas', { ...rotina, hora: 'nove' }, K)).status).toBe(400);
      const feita = await post('/api/equipe/rotinas', rotina, K);
      expect(feita.status).toBe(201);
      const rid = ((await feita.json()) as { id: string }).id;
      const lidas = (await (await fetch(`${base}/api/equipe/rotinas?room=${encodeURIComponent('/p/social')}`, { headers: K })).json()) as { rotinas: Array<{ id: string; ativa: boolean }> };
      expect(lidas.rotinas).toMatchObject([{ id: rid, ativa: true }]);
      expect(await (await post(`/api/equipe/rotinas/${rid}`, { ativa: false }, K)).json()).toMatchObject({ ativa: false });
      expect((await post(`/api/equipe/rotinas/${rid}`, { qualquer: 1 }, K)).status).toBe(400);
      expect(await (await post(`/api/equipe/rotinas/${rid}`, { pedido: 'Relatório novo', intervaloMin: 90 }, K)).json()).toMatchObject({ pedido: 'Relatório novo', intervaloMin: 90 });
      expect((await post(`/api/equipe/rotinas/${rid}`, { rodar: true }, K)).status).toBe(200);
      expect((await post('/api/equipe/rotinas/nao-existe', { rodar: true }, K)).status).toBe(404);
      expect((await post(`/api/equipe/rotinas/${rid}`, { apagar: true }, K)).status).toBe(200);
      expect((await post(`/api/equipe/rotinas/${rid}`, { apagar: true }, K)).status).toBe(404);

      // permissão: sem a chave não decide; com a chave decide
      expect((await post('/api/permissions/pedido-1/decision', { behavior: 'allow' })).status).toBe(401);
      expect((await post('/api/permissions/pedido-1/decision', { behavior: 'allow' }, { 'X-Equipe-Chave': 'errada-errada-errada-errada' })).status).toBe(401);
      expect(decididos).toEqual([]);
      expect((await post('/api/permissions/pedido-1/decision', { behavior: 'allow' }, K)).status).toBe(200);
      expect(decididos).toEqual(['pedido-1']);
    } finally {
      hub.stop();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      cleanup();
      tmp.cleanup();
    }
  });

  it('sem chave criada no computador, a aprovação pela página vale como antes (sem chave)', () => {
    const tmp = tempDir();
    try {
      const semChave = new FilaDePedidos({ equipes: () => EQ, keyFile: join(tmp.dir, 'nao-existe') });
      expect(semChave.conferirChave(undefined)).toBe('desligado');
    } finally {
      tmp.cleanup();
    }
  });

  it('o recado vira um AppleScript que digita uma linha só na aba do terminal certo', () => {
    const script = cli.scriptDeDigitar('/dev/ttys004', 'Use "aspas" e barra \\ aqui\nsegunda linha') as string;
    expect(script).toContain('if tty of t is "/dev/ttys004" then');
    expect(script).toContain('do script "Use \\"aspas\\" e barra \\\\ aqui segunda linha" in t');
  });
});
