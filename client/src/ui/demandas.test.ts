import { describe, expect, it } from 'vitest';
import type { RecentSession } from '../../../shared/types';
import { abaDe, dataTexto, duracaoTexto, estadoTexto, motivoDaDemanda, podeRetomar, progressoTexto, sessaoDaEtapa } from './demandas';
import { quandoTexto } from './rotinas';

describe('painel de demandas', () => {
  it('cada demanda cai numa aba: arquivada vale por cima do estado', () => {
    expect(abaDe({ estado: 'rodando' })).toBe('andamento');
    expect(abaDe({ estado: 'fila' })).toBe('andamento');
    expect(abaDe({ estado: 'parada' })).toBe('andamento');
    expect(abaDe({ estado: 'concluida' })).toBe('concluidas');
    expect(abaDe({ estado: 'concluida', arquivadaEm: 5 })).toBe('arquivadas');
    expect(abaDe({ estado: 'parada', arquivadaEm: 5 })).toBe('arquivadas');
  });

  it('textos: estado, duração e data', () => {
    expect(estadoTexto('concluida')).toBe('Concluída');
    expect(estadoTexto('outro')).toBe('outro');
    expect(duracaoTexto(12_000)).toBe('12 s');
    expect(duracaoTexto(4 * 60_000)).toBe('4 min');
    expect(duracaoTexto(65 * 60_000)).toBe('1 h 05 min');
    expect(duracaoTexto(-1)).toBe('');
    expect(dataTexto(new Date(2026, 9, 9, 13, 12).getTime())).toBe('09/10 13:12');
    expect(dataTexto(undefined)).toBe('');
  });

  it('diz em que pé a demanda está', () => {
    const quem = (e: { agente: string }) => e.agente;
    const etapas = [
      { n: 1, agente: 'cto', estado: 'concluida' },
      { n: 2, agente: 'roteirista', estado: 'rodando' },
      { n: 3, agente: 'cmo', estado: 'fila' },
    ];
    expect(progressoTexto({ estado: 'rodando', etapas, criadaEm: 0 }, quem)).toBe('etapa 2 de 3 · roteirista trabalhando');
    etapas[1].estado = 'parada';
    expect(progressoTexto({ estado: 'parada', etapas, criadaEm: 0 }, quem)).toBe('etapa 2 de 3 · roteirista parou sem entregar');
    etapas[1].estado = 'concluida';
    expect(progressoTexto({ estado: 'rodando', etapas, criadaEm: 0 }, quem)).toBe('etapa 3 de 3 · cmo é o próximo');
    etapas[2].estado = 'concluida';
    expect(progressoTexto({ estado: 'concluida', etapas, criadaEm: 0, terminadaEm: 42 * 60_000 }, quem)).toBe('3 etapas · 42 min');
  });

  it('mostra por que a demanda não anda: etapa parada (com o comando de retomar) ou sessão travada', () => {
    const quem = (e: { agente: string }) => e.agente;
    const limite = { tipo: 'limite', texto: 'O limite de uso do plano acabou (o da sessão de 5 horas) e volta às 15h40.', fazer: 'Quando o limite voltar, retome a demanda.' };
    const etapas = [
      { n: 1, agente: 'cto', estado: 'concluida' },
      { n: 2, agente: 'roteirista', estado: 'parada', parada: limite },
    ];
    expect(motivoDaDemanda({ id: 'd1', estado: 'parada', etapas })).toEqual({ texto: limite.texto, fazer: limite.fazer, comando: 'equipe retomar d1' });
    // Sessão aberta, travada no erro: a demanda consta em andamento, sem comando de retomar.
    etapas[1].estado = 'rodando';
    expect(motivoDaDemanda({ id: 'd1', estado: 'rodando', etapas })?.comando).toBe('');
    expect(progressoTexto({ estado: 'rodando', etapas, criadaEm: 0 }, quem)).toBe('etapa 2 de 2 · roteirista travou e espera você');
    // Sem motivo, arquivada ou concluída: nada a mostrar.
    expect(motivoDaDemanda({ id: 'd1', estado: 'parada', etapas: [{ n: 1, agente: 'cto', estado: 'parada' }] })).toBeUndefined();
    expect(motivoDaDemanda({ id: 'd1', estado: 'parada', etapas, arquivadaEm: 5 })).toBeUndefined();
    expect(motivoDaDemanda({ id: 'd1', estado: 'concluida', etapas })).toBeUndefined();
    // Já mandaram retomar e ela espera a vez: a faixa some (o selo passa a ser "Na fila").
    etapas[1].estado = 'parada';
    expect(motivoDaDemanda({ id: 'd1', estado: 'parada', etapas, aguardando: 7 })).toBeUndefined();
  });

  it('botão Retomar: só na demanda parada, fora do arquivo e fora da fila', () => {
    expect(podeRetomar({ estado: 'parada' })).toBe(true);
    expect(podeRetomar({ estado: 'parada', aguardando: 7 })).toBe(false);
    expect(podeRetomar({ estado: 'parada', arquivadaEm: 5 })).toBe(false);
    // Sessão aberta e travada num erro consta "rodando": ali é o recado "continue", não o Retomar.
    expect(podeRetomar({ estado: 'rodando' })).toBe(false);
    expect(podeRetomar({ estado: 'concluida' })).toBe(false);
    expect(podeRetomar({ estado: 'fila' })).toBe(false);
  });

  it('acha a sessão do terminal de uma etapa: pelo id; nas antigas, pela hora e pelo projeto', () => {
    const s = (sessionId: string, project: string, firstAt: number): RecentSession => ({ account: '.claude', sessionId, project, projectDir: 'x', firstAt, lastAt: firstAt + 1, size: 1, open: false });
    const sessoes = [s('aaa', '/p/social', 1_000_000), s('bbb', '/p/social', 2_000_000), s('ccc', '/p/outro', 2_000_500)];
    expect(sessaoDaEtapa({ sessao: 'bbb', iniciadaEm: 1 }, '/p/social', sessoes)?.sessionId).toBe('bbb');
    expect(sessaoDaEtapa({ sessao: 'zzz', iniciadaEm: 2_000_000 }, '/p/social', sessoes)).toBeUndefined();
    expect(sessaoDaEtapa({ iniciadaEm: 1_999_000 }, '/p/social', sessoes)?.sessionId).toBe('bbb');
    expect(sessaoDaEtapa({ iniciadaEm: 2_000_000 }, '/p/outro', sessoes)?.sessionId).toBe('ccc');
    expect(sessaoDaEtapa({ iniciadaEm: 9_000_000 }, '/p/social', sessoes)).toBeUndefined();
    expect(sessaoDaEtapa({}, '/p/social', sessoes)).toBeUndefined();
  });

  it('rotina por gatilho diz o caminho que ela vigia', () => {
    expect(quandoTexto({ dias: [], hora: '', gatilho: '~/Pedidos/novos.csv' })).toBe('quando chegar item novo em ~/Pedidos/novos.csv');
  });
});
