// Criar sala e agente pela tela: as regras de formulário, sem DOM.
import { describe, expect, it } from 'vitest';
import { textoDaEscolha } from '../../../shared/ia';
import { escolhasDe, mudancaDeIA, textoDaMudanca } from './ia';
import { fixosDaSala, mesaSobCursor, moverParaMesa } from './mesas';
import { faltaNaFuncao, faltaNaSala, faltaNoAgente, lotacao, pastaCurta, salasDeEquipe, salasParaLigar, textoDaLotacao, textoDeExcluirSala, textoDeLigar } from './criar';

describe('criar sala e agente pela tela', () => {
  it('a sala precisa de nome e de pasta escolhida', () => {
    expect(faltaNaSala('', '')).toMatch(/nome/);
    expect(faltaNaSala(' V ', '/Users/v/Vendas')).toMatch(/nome/);
    expect(faltaNaSala('Vendas', '')).toMatch(/pasta/);
    expect(faltaNaSala('Vendas', '/Users/v/Vendas')).toBe('');
  });

  it('o agente precisa de sala, função e uma descrição de verdade', () => {
    const descricao = 'Atende os leads do WhatsApp e passa os quentes.';
    expect(faltaNoAgente('', 'Designer', descricao)).toMatch(/sala/);
    expect(faltaNoAgente('/p', 'D', descricao)).toMatch(/função/);
    expect(faltaNoAgente('/p', 'Designer', 'faz arte')).toMatch(/Descreva/);
    expect(faltaNoAgente('/p', 'Designer', descricao)).toBe('');
  });

  it('lotação da sala: conta os agentes fixos dela; o limite é o da sala, ou as mesas do layout; cheia, não cabe mais ninguém', () => {
    const gente = [
      { roomId: '/p/dir', staff: 'cmo', kind: 'main' as const },
      { roomId: '/p/dir', staff: 'cto', kind: 'main' as const },
      // a mesma pessoa não conta duas vezes; subagente, sessão solta e gente de outra sala não contam
      { roomId: '/p/dir', staff: 'cto', kind: 'main' as const },
      { roomId: '/p/dir', staff: 'cto', kind: 'sub' as const },
      { roomId: '/p/dir', kind: 'main' as const },
      { roomId: '/p/mkt', staff: 'copy', kind: 'main' as const },
    ];
    expect(lotacao({ id: '/p/dir', maxAgents: 4, style: { layout: 'diretoria' } }, gente)).toEqual({ tem: 2, limite: 4, mesas: 4, livres: 2 });
    expect(lotacao({ id: '/p/dir', maxAgents: 2, style: { layout: 'diretoria' } }, gente)).toEqual({ tem: 2, limite: 2, mesas: 4, livres: 0 });
    // Sem limite informado, valem as mesas do layout (seis na sala sorteada, doze na de equipe).
    expect(lotacao({ id: '/p/mkt' }, gente)).toEqual({ tem: 1, limite: 6, mesas: 6, livres: 5 });
    expect(lotacao({ id: '/p/mkt', style: { layout: 'equipe' } }, gente)).toMatchObject({ limite: 12, mesas: 12, livres: 11 });
    // Mais gente do que o limite (limite antigo, layout menor): não cabe ninguém, e a conta não fica negativa.
    expect(lotacao({ id: '/p/dir', maxAgents: 1 }, gente).livres).toBe(0);
    expect(textoDaLotacao({ tem: 2, limite: 4 })).toBe('2 de 4 agentes');
    expect(textoDaLotacao({ tem: 1, limite: 1 })).toBe('Sala cheia: 1 de 1 agente');
    expect(faltaNoAgente('/p', 'Designer', 'Atende os leads do WhatsApp e passa os quentes.', 'Sala cheia: 4 de 4 agentes.')).toMatch(/Sala cheia/);
  });

  it('só as salas de equipe aceitam agente novo, na ordem do escritório', () => {
    const rooms = [
      { id: '/p/solta', name: 'Meus projetos', slot: 0 },
      { id: '/p/dir', name: 'Diretoria', slot: 2, team: true },
      { id: '/p/mkt', name: 'Equipe de Marketing', slot: 1, team: true },
    ];
    expect(salasDeEquipe(rooms)).toEqual([
      { id: '/p/mkt', name: 'Equipe de Marketing' },
      { id: '/p/dir', name: 'Diretoria' },
    ]);
  });

  it('a função editada precisa de título e de texto de verdade', () => {
    expect(faltaNaFuncao('', 'x'.repeat(80))).toMatch(/função/);
    expect(faltaNaFuncao('Designer', 'faz arte')).toMatch(/curta/);
    expect(faltaNaFuncao('Designer', 'x'.repeat(80))).toBe('');
  });

  it('excluir sala: a pergunta diz quem sai junto e o que fica', () => {
    const vazia = textoDeExcluirSala('teste', []);
    expect(vazia.texto).toContain('Ela não tem agentes');
    expect(vazia.botao).toBe('Sim, excluir a sala');
    const um = textoDeExcluirSala('Vendas', ['Caio · Vendedor']);
    expect(um.texto).toContain('o agente dela (Caio · Vendedor)? Ele deixa de receber demandas. O arquivo da função e o caderno dele vão');
    expect(um.botao).toBe('Sim, excluir a sala e o agente');
    const varios = textoDeExcluirSala('Equipe de Vendas', ['Ana · Vendedora', 'Caio · Suporte', 'Lia · Financeiro']);
    expect(varios.texto).toContain('os 3 agentes dela (Ana · Vendedora, Caio · Suporte, Lia · Financeiro)');
    expect(varios.texto).toContain('lixeira da equipe');
    expect(varios.texto).toContain('A pasta e os arquivos dela continuam onde estão');
    expect(varios.botao).toBe('Sim, excluir a sala e os 3 agentes');
  });

  it('mostra a pasta com a pasta pessoal abreviada', () => {
    expect(pastaCurta('/Users/ana/Documents/Vendas')).toBe('~/Documents/Vendas');
    expect(pastaCurta('/Volumes/Disco/Vendas')).toBe('/Volumes/Disco/Vendas');
  });

  it('"Conversa com": lista as outras salas de equipe e diz quais já conversam; a sala do dono fica de fora', () => {
    const rooms = [
      { id: '/mkt', name: 'Marketing', team: true, slot: 1, links: ['/dir'] },
      { id: '/dir', name: 'Diretoria', team: true, slot: 0 },
      { id: '/vendas', name: 'Vendas', team: true, slot: 2 },
      { id: '/esc', name: 'Sala do dono', team: true, slot: 3, office: true },
      { id: '/solta', name: 'Conversa solta', slot: 4 },
    ];
    expect(salasParaLigar(rooms, '/mkt')).toEqual([
      { id: '/dir', name: 'Diretoria', ligada: true },
      { id: '/vendas', name: 'Vendas', ligada: false },
    ]);
    // A ligação vale nos dois sentidos, mesmo que só um lado a traga.
    expect(salasParaLigar(rooms, '/dir').find((s) => s.id === '/mkt')?.ligada).toBe(true);
    // Sala comum e sala do dono não se ligam a ninguém.
    expect(salasParaLigar(rooms, '/solta')).toEqual([]);
    expect(salasParaLigar(rooms, '/esc')).toEqual([]);
    expect(salasDeEquipe(rooms).map((s) => s.id)).toEqual(['/dir', '/mkt', '/vendas']);
  });

  it('a pergunta de ligar diz o que muda; a de desligar diz que ninguém é apagado', () => {
    const ligar = textoDeLigar('Marketing', 'Vendas', true);
    expect(ligar.titulo).toBe('Ligar salas');
    expect(ligar.texto).toContain('"Marketing" conversar com a sala "Vendas"');
    expect(ligar.texto).toContain('na pasta da sala que chamou');
    expect(ligar.botao).toBe('Sim, ligar as duas salas');
    const desligar = textoDeLigar('Marketing', 'Vendas', false);
    expect(desligar.titulo).toBe('Desligar salas');
    expect(desligar.texto).toContain('Ninguém é apagado');
    expect(desligar.botao).toBe('Sim, desligar as duas salas');
  });
});

describe('mesas da sala: quem senta onde', () => {
  const mesas = [{ n: 1, staff: 'cmo' }, { n: 2, staff: 'cto' }, { n: 3 }, { n: 4 }];

  it('mandar para mesa livre só muda quem foi; os outros ficam marcados onde estão', () => {
    expect(moverParaMesa(mesas, 'cmo', 4)).toEqual({ cmo: 4, cto: 2 });
  });

  it('mandar para a mesa de outro troca os dois de lugar', () => {
    expect(moverParaMesa(mesas, 'cmo', 2)).toEqual({ cmo: 2, cto: 1 });
  });

  it('quem não tinha mesa fica com a escolhida; se era de alguém, esse fica sem mesa marcada', () => {
    expect(moverParaMesa(mesas, 'cfo', 3)).toEqual({ cmo: 1, cto: 2, cfo: 3 });
    expect(moverParaMesa(mesas, 'cfo', 1)).toEqual({ cfo: 1, cto: 2 });
  });

  it('ao soltar o agente: vale a mesa mais perto do cursor, a até um quadrado e meio; longe de todas, nenhuma', () => {
    const naTela = [
      { n: 1, x: 100, y: 100, tile: 32 },
      { n: 2, x: 200, y: 100, tile: 32 },
    ];
    expect(mesaSobCursor(naTela, 110, 95)?.n).toBe(1);
    expect(mesaSobCursor(naTela, 160, 100)?.n).toBe(2);
    expect(mesaSobCursor(naTela, 148, 100)?.n).toBe(1);
    // exatamente no meio das duas, a mais de um quadrado e meio de cada: nenhuma
    expect(mesaSobCursor(naTela, 150, 100)).toBeUndefined();
    expect(mesaSobCursor(naTela, 150, 200)).toBeUndefined();
    expect(mesaSobCursor([], 0, 0)).toBeUndefined();
  });

  it('os agentes fixos da sala entram uma vez só, com o nome da tela', () => {
    const gente = [
      { roomId: '/p/dir', staff: 'cmo', kind: 'main' as const, name: 'Otávio', job: 'CMO' },
      { roomId: '/p/dir', staff: 'cmo', kind: 'main' as const, name: 'Otávio' },
      { roomId: '/p/dir', staff: 'cmo', kind: 'sub' as const, name: 'ajudante' },
      { roomId: '/p/dir', kind: 'main' as const, name: 'Sessão solta' },
      { roomId: '/p/mkt', staff: 'copy', kind: 'main' as const, name: 'Lia' },
    ];
    expect(fixosDaSala('/p/dir', gente)).toEqual([{ slug: 'cmo', nome: 'Otávio', funcao: 'CMO' }]);
  });
});


describe('IA do agente: os campos da gaveta', () => {
  it('sem nada guardado, tudo é automático e a permissão é a padrão', () => {
    expect(escolhasDe(undefined)).toEqual({ modelo: 'auto', nivel: 'auto', pisoModelo: 'auto', pisoNivel: 'auto', pode: 'padrao' });
    expect(escolhasDe({ modelo: 'sonnet', piso: { nivel: 'medio' }, pode: true, podeMarcado: true })).toEqual({ modelo: 'sonnet', nivel: 'auto', pisoModelo: 'auto', pisoNivel: 'medio', pode: 'sim' });
    expect(escolhasDe({ pode: true }).pode).toBe('padrao');
    expect(escolhasDe({ pode: false, podeMarcado: false }).pode).toBe('nao');
  });

  it('só vai para o servidor o que mudou; nada mudou, nada vai', () => {
    const guardado = { modelo: 'sonnet' as const, pode: true };
    expect(mudancaDeIA(guardado, escolhasDe(guardado))).toBeUndefined();
    expect(mudancaDeIA(guardado, { ...escolhasDe(guardado), modelo: 'auto', nivel: 'alto' })).toEqual({ modelo: 'auto', nivel: 'alto' });
    expect(mudancaDeIA(guardado, { ...escolhasDe(guardado), pode: 'nao' })).toEqual({ pode: false });
    expect(mudancaDeIA({ pode: false, podeMarcado: false }, { ...escolhasDe({ pode: false, podeMarcado: false }), pode: 'padrao' })).toEqual({ pode: 'padrao' });
    expect(mudancaDeIA(undefined, { modelo: 'opus', nivel: 'auto', pisoModelo: 'sonnet', pisoNivel: 'auto', pode: 'sim' })).toEqual({ modelo: 'opus', pisoModelo: 'sonnet', pode: true });
  });

  it('a confirmação diz em palavras o que muda; o painel de Demandas diz quem escolheu e por quê', () => {
    expect(textoDaMudanca({ modelo: 'opus', nivel: 'auto' })).toBe('IA: Opus; nível: automático (a triagem escolhe)');
    expect(textoDaMudanca({ pisoModelo: 'auto', pisoNivel: 'alto' })).toBe('IA mínima: sem mínimo; nível mínimo: alto');
    expect(textoDaMudanca({ pode: true })).toContain('pode escolher a IA');
    expect(textoDaMudanca({ pode: 'padrao' })).toContain('volta ao padrão');
    expect(textoDaEscolha({ modelo: 'sonnet', nivel: 'medio', por: 'triagem', motivo: 'roteiro curto' })).toBe('Sonnet · médio. Escolhido pela triagem: roteiro curto.');
    expect(textoDaEscolha({ por: 'padrao', motivo: 'a triagem não respondeu: ficou o padrão do Claude Code' })).toBe('O padrão do Claude Code. Sem escolha: a triagem não respondeu: ficou o padrão do Claude Code.');
    expect(textoDaEscolha(undefined)).toBe('');
  });
});
