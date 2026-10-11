// Painel "Demandas" (equipe de agentes fixos; ver o README.md): o histórico das demandas da equipe. Mostra o que
// está em andamento, o que foi concluído e o que foi arquivado; em cada demanda, quem fez cada etapa, a instrução
// que recebeu, o resultado que entregou e o terminal daquela etapa (o mesmo terminal somente leitura do
// Histórico). Demanda concluída é conferida aqui e depois arquivada ou excluída.
//
// O servidor não enxerga a pasta dos projetos: quem publica o histórico é o serviço do Mac (`equipe servir`), e
// arquivar, excluir e trazer a janela do terminal para a frente também são feitos por ele (fila de pedidos).
import { aiLabel, textoDaEscolha } from '../../../shared/ia';
import type { AgentInfo, RecentSession } from '../../../shared/types';
import type { DemandaInfo, EtapaInfo, ProjetoHistorico } from '../net/store';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { formatTokens } from './format';
import { HISTORY_URL, parseRecentSessions } from './history';
import { ICONS } from './icons';
import type { RotinasPainel } from './rotinas';
import type { TerminalControl } from './terminal';

const REOPEN_GUARD_MS = 250;
const REFRESH_MS = 5_000;

export type Aba = 'andamento' | 'concluidas' | 'arquivadas';
/** As abas do painel: as três das demandas e o bloco onde se define uma demanda de rotina. */
export type AbaDoPainel = Aba | 'rotinas';

/** Em que aba a demanda aparece: arquivada vale por cima do estado; fila, rodando e parada são "em andamento". */
export function abaDe(d: Pick<DemandaInfo, 'estado' | 'arquivadaEm' | 'aguardando'>): Aba {
  if (d.arquivadaEm) return 'arquivadas';
  if (d.aguardando) return 'andamento';
  return d.estado === 'concluida' ? 'concluidas' : 'andamento';
}

const ESTADOS: Record<string, string> = { fila: 'Na fila', rodando: 'Em andamento', parada: 'Parada', concluida: 'Concluída' };
export const estadoTexto = (estado: string): string => ESTADOS[estado] ?? estado;

/** "1,2 mi tokens", ou vazio quando o servidor não sabe quanto a etapa gastou. */
export const tokensTexto = (n: number | undefined): string => (n && n > 0 ? `${formatTokens(n)} tokens` : '');

/** "Ana · Vendedora" vira "Ana". */
export const nomeCurto = (quem: string): string => quem.split(' · ')[0];

/** "12 s", "4 min", "1 h 05 min". */
export function duracaoTexto(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "09/10 13:12". */
export function dataTexto(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Em que pé está: "etapa 3 de 5 · Roteirista trabalhando" ou "5 etapas · 42 min". */
export function progressoTexto(d: Pick<DemandaInfo, 'estado' | 'etapas' | 'criadaEm' | 'terminadaEm' | 'aguardando'>, quem: (e: EtapaInfo) => string): string {
  const total = d.etapas.length;
  // Uma demanda por vez: esta espera a que está trabalhando terminar e começa sozinha.
  if (d.aguardando && d.estado !== 'rodando') return 'na fila: começa quando a demanda em andamento terminar';
  const atual = d.etapas.find((e) => e.estado === 'rodando') ?? d.etapas.find((e) => e.estado === 'parada') ?? d.etapas.find((e) => e.estado === 'fila');
  if (d.estado === 'concluida' || !atual) {
    const tempo = d.terminadaEm ? duracaoTexto(d.terminadaEm - d.criadaEm) : '';
    return `${total} ${total === 1 ? 'etapa' : 'etapas'}${tempo ? ` · ${tempo}` : ''}`;
  }
  // Sessão aberta mas travada num erro (login, limite do plano): não está trabalhando de verdade.
  const verbo = atual.estado === 'rodando' ? (atual.parada ? 'travou e espera você' : 'trabalhando') : atual.estado === 'parada' ? 'parou sem entregar' : 'é o próximo';
  return `etapa ${atual.n} de ${total} · ${quem(atual)} ${verbo}`;
}

/**
 * O motivo de a demanda estar sem andar, quando há: o da etapa parada (a sessão fechou sem entregar) ou o da
 * etapa em andamento que travou num erro. `comando` é o que retoma uma demanda parada, pelo Terminal.
 */
export function motivoDaDemanda(d: Pick<DemandaInfo, 'id' | 'estado' | 'etapas' | 'arquivadaEm' | 'aguardando'>): { texto: string; fazer: string; comando: string } | undefined {
  if (d.arquivadaEm || (d.estado !== 'parada' && d.estado !== 'rodando')) return undefined;
  // Já mandaram retomar e ela espera a vez na fila: o que havia a fazer foi feito.
  if (d.aguardando && d.estado !== 'rodando') return undefined;
  const e = d.etapas.find((x) => (x.estado === 'parada' || x.estado === 'rodando') && x.parada);
  if (!e?.parada) return undefined;
  return { texto: e.parada.texto, fazer: e.parada.fazer ?? '', comando: e.estado === 'parada' ? `equipe retomar ${d.id}` : '' };
}

/**
 * Dá para retomar pela tela? Só a demanda parada, fora do arquivo e fora da fila. A que está "em andamento" com
 * a sessão travada num erro não entra: ali a sessão continua aberta e o caminho é o recado "continue".
 */
export function podeRetomar(d: Pick<DemandaInfo, 'estado' | 'arquivadaEm' | 'aguardando'>): boolean {
  return d.estado === 'parada' && !d.arquivadaEm && !d.aguardando;
}

/**
 * A sessão do terminal de uma etapa: pelo id gravado na etapa; nas etapas antigas (sem id), a sessão do mesmo
 * projeto que começou junto com a etapa.
 */
export function sessaoDaEtapa(e: Pick<EtapaInfo, 'sessao' | 'iniciadaEm'>, projeto: string, sessoes: readonly RecentSession[]): RecentSession | undefined {
  if (e.sessao) return sessoes.find((s) => s.sessionId === e.sessao);
  if (!e.iniciadaEm) return undefined;
  const ini = e.iniciadaEm;
  return sessoes
    .filter((s) => s.project === projeto && s.firstAt !== undefined && s.firstAt >= ini - 5_000 && s.firstAt <= ini + 180_000)
    .sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))[0];
}

export class DemandasPopover implements UiComponent {
  readonly el: HTMLElement;
  /** Botão da barra superior (index.ts o coloca no grupo dos painéis). */
  readonly button: HTMLButtonElement;
  private keyRow: HTMLElement;
  private keyInput: HTMLInputElement;
  private tabs: Record<AbaDoPainel, HTMLButtonElement>;
  private msg: HTMLElement;
  private list: HTMLElement;
  private projetos: ProjetoHistorico[] = [];
  private sessoes: RecentSession[] = [];
  private aba: AbaDoPainel = 'andamento';
  /** Demanda aberta (projeto + id) e o detalhe dela (pedido, instruções e resultados). */
  private aberta: string | null = null;
  private detalhe: DemandaInfo | null = null;
  /** Etapas com o texto à mostra, da demanda aberta. */
  private etapasAbertas = new Set<number>();
  private closedAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ocupado = false;
  /** Etapa (da demanda aberta) com a caixa de pergunta à mostra, e o texto que está sendo escrito. */
  private perguntando: number | null = null;
  private rascunho = '';
  private sig = '';

  constructor(
    private ctx: UiContext,
    private terminal: TerminalControl,
    /** O bloco "Rotinas" (ui/rotinas.ts), mostrado na aba ao lado de "Arquivadas". */
    private rotinas: RotinasPainel,
  ) {
    this.button = h('button', { class: 'ui-btn ui-rotp-btn ui-dem-btn', type: 'button', text: 'Demandas', title: 'Demandas da equipe: em andamento, concluídas, arquivadas e as rotinas (demandas que se repetem)', on: { click: () => this.toggle() } });
    setAttr(this.button, 'aria-haspopup', 'dialog');
    setAttr(this.button, 'aria-expanded', 'false');

    const parar = (ev: Event) => ev.stopPropagation();
    this.keyInput = h('input', { class: 'ui-ask__key', type: 'password', attrs: { placeholder: 'Chave do escritório', 'aria-label': 'Chave do escritório', autocomplete: 'off', spellcheck: 'false' }, on: { keydown: parar } });
    const keyOk = h('button', { class: 'ui-btn', type: 'button', text: 'Entrar', on: { click: () => void this.entrar() } });
    this.keyRow = h(
      'div',
      { class: 'ui-rotp__key', hidden: true },
      h('p', { class: 'ui-ask__dica', text: 'Para ver as demandas e as rotinas, cole a chave do escritório (no terminal: equipe chave). Uma vez por navegador.' }),
      h('div', { class: 'ui-rotp__keyline' }, this.keyInput, keyOk),
    );
    const aba = (id: AbaDoPainel) => h('button', { class: 'ui-btn ui-dem__tab', type: 'button', attrs: { 'aria-pressed': 'false' }, on: { click: () => this.trocarAba(id) } });
    this.tabs = { andamento: aba('andamento'), concluidas: aba('concluidas'), arquivadas: aba('arquivadas'), rotinas: aba('rotinas') };
    setTitle(this.tabs.rotinas, 'Defina uma demanda de rotina: ela se repete sozinha em dias e hora, a cada intervalo ou quando chega item novo');
    rotinas.onSemChave = () => setHidden(this.keyRow, false);
    rotinas.onMudou = () => this.rotulos();
    this.msg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });
    this.list = h('div', { class: 'ui-dem__list' });
    const close = iconButton(ICONS.close, 'Fechar demandas', () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-rotp ui-dem', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': 'Demandas da equipe', id: 'ui-demandas', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: 'Demandas da equipe' }), close),
      h('p', { class: 'ui-hist__hint', text: 'Tudo o que foi pedido à equipe. Abra uma demanda para ver quem fez cada etapa, o que entregou e o terminal dela. Conferiu a concluída? Arquive ou exclua. Em "Rotinas" você define a demanda que se repete sozinha.' }),
      this.keyRow,
      h('div', { class: 'ui-rotp__body' }, h('div', { class: 'ui-dem__tabs' }, this.tabs.andamento, this.tabs.concluidas, this.tabs.arquivadas, this.tabs.rotinas), this.msg, this.list, rotinas.el),
    );
    this.el.addEventListener('toggle', () => {
      setAttr(this.button, 'aria-expanded', String(this.isOpen));
      this.button.classList.toggle('is-on', this.isOpen);
      if (!this.isOpen) {
        this.closedAt = performance.now();
        this.parar();
      }
      this.ctx.root.classList.toggle('has-popover', this.isOpen);
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(): void {
    if (this.isOpen) return this.hide();
    if (performance.now() - this.closedAt < REOPEN_GUARD_MS) return;
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    this.ctx.root.classList.add('has-popover');
    void this.load(true);
    this.parar();
    this.timer = setInterval(() => void this.load(false), REFRESH_MS);
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.classList.remove('is-on');
    this.ctx.root.classList.remove('has-popover');
    this.parar();
  }

  render(): void {
    // A lista se atualiza sozinha enquanto o painel está aberto (timer); nada a fazer a cada quadro.
  }

  private parar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private aviso(text: string, kind: 'ok' | 'erro' | 'info' = 'info'): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.className = `ui-ask__msg ui-ask__msg--${kind}`;
  }

  private async entrar(): Promise<void> {
    const k = this.keyInput.value.trim();
    if (!k) return;
    this.ctx.store.equipeKey = k;
    this.keyInput.value = '';
    await this.load(true);
  }

  private trocarAba(aba: AbaDoPainel): void {
    this.aba = aba;
    this.aberta = null;
    this.detalhe = null;
    this.etapasAbertas.clear();
    this.perguntando = null;
    this.aviso('');
    this.renderList(true);
  }

  /** O nome e o número de cada aba, e qual está escolhida. */
  private rotulos(): void {
    const todas = this.todas();
    const conta = (aba: Aba) => todas.filter((x) => abaDe(x.d) === aba).length;
    const nomes: Record<AbaDoPainel, string> = { andamento: 'Em andamento', concluidas: 'Concluídas', arquivadas: 'Arquivadas', rotinas: 'Rotinas' };
    for (const aba of Object.keys(this.tabs) as AbaDoPainel[]) {
      setText(this.tabs[aba], `${nomes[aba]} (${aba === 'rotinas' ? this.rotinas.total : conta(aba)})`);
      setAttr(this.tabs[aba], 'aria-pressed', String(this.aba === aba));
    }
  }

  private async load(primeira: boolean): Promise<void> {
    const store = this.ctx.store;
    if (!store.equipeKey) {
      setHidden(this.keyRow, false);
      this.projetos = [];
      return this.renderList(true);
    }
    const [lista, sessoes] = await Promise.all([store.historico(), primeira || !this.sessoes.length ? this.lerSessoes() : Promise.resolve(this.sessoes)]);
    this.sessoes = sessoes;
    if (lista === null) {
      // Chave que não confere (ou escritório fora do ar): pede de novo.
      setHidden(this.keyRow, false);
      this.projetos = [];
    } else {
      setHidden(this.keyRow, true);
      this.projetos = lista;
      // Na primeira abertura, a aba que tem o que ver: em andamento, senão as concluídas.
      if (primeira && !this.todas().some((x) => abaDe(x.d) === 'andamento') && this.todas().some((x) => abaDe(x.d) === 'concluidas')) this.aba = 'concluidas';
    }
    if (this.aberta) await this.lerDetalhe();
    this.renderList(false);
    // O número da aba "Rotinas" (e a lista dela, depois que a chave entra). Com a aba aberta, não mexe a cada 5 s.
    if (primeira) void this.rotinas.load();
  }

  private async lerSessoes(): Promise<RecentSession[]> {
    try {
      const res = await fetch(HISTORY_URL, { cache: 'no-store' });
      return res.ok ? parseRecentSessions(await res.json()) : [];
    } catch {
      return [];
    }
  }

  private todas(): { p: ProjetoHistorico; d: DemandaInfo }[] {
    return this.projetos.flatMap((p) => p.demandas.map((d) => ({ p, d }))).sort((a, b) => b.d.criadaEm - a.d.criadaEm);
  }

  private chaveDe(p: ProjetoHistorico, d: DemandaInfo): string {
    return `${p.projeto}\n${d.id}`;
  }

  /** O personagem do escritório que é este agente nesta equipe (ou numa sala que conversa com ela). */
  private agenteDe(p: ProjetoHistorico, slug: string): AgentInfo | undefined {
    const salas = [p.projeto, p.diretoria, ...(p.ligadas ?? [])];
    const todos = (this.ctx.store.snapshot?.agents ?? []).filter((a) => a.kind === 'main' && a.staff === slug && salas.includes(a.roomId));
    return todos.find((a) => !a.parked) ?? todos[0];
  }

  private quem(p: ProjetoHistorico, e: Pick<EtapaInfo, 'agente' | 'funcao' | 'quem'>): string {
    const a = this.agenteDe(p, e.quem ?? e.agente);
    const funcao = e.funcao ?? a?.job ?? e.agente;
    return a ? `${a.name} · ${funcao}` : funcao;
  }

  private async lerDetalhe(): Promise<void> {
    const alvo = this.todas().find((x) => this.chaveDe(x.p, x.d) === this.aberta);
    if (!alvo) {
      this.aberta = null;
      this.detalhe = null;
      return;
    }
    this.detalhe = (await this.ctx.store.demandaDetalhe(alvo.p.projeto, alvo.d.id)) ?? this.detalhe;
  }

  private async abrir(p: ProjetoHistorico, d: DemandaInfo): Promise<void> {
    const chave = this.chaveDe(p, d);
    this.etapasAbertas.clear();
    this.perguntando = null;
    this.detalhe = null;
    this.aberta = this.aberta === chave ? null : chave;
    this.renderList(true);
    if (!this.aberta) return;
    await this.lerDetalhe();
    // Abre já com a última entrega à mostra: é o que se confere primeiro.
    const lido = this.detalhe as DemandaInfo | null;
    const ultima = [...(lido?.etapas ?? [])].reverse().find((e) => e.resultado);
    if (ultima) this.etapasAbertas.add(ultima.n);
    this.renderList(true);
  }

  private async agir(p: ProjetoHistorico, d: DemandaInfo, acao: 'arquivar' | 'desarquivar' | 'excluir' | 'mostrar' | 'retomar', sucesso: string): Promise<void> {
    if (this.ocupado) return;
    if (acao === 'excluir' && !globalThis.confirm?.(`Excluir a demanda "${d.titulo}"?\n\nA pasta dela vai para a lixeira da equipe (.equipe/lixeira/demandas).`)) return;
    this.ocupado = true;
    this.aviso(acao === 'mostrar' ? 'Trazendo a janela do terminal…' : acao === 'retomar' ? 'Retomando a demanda…' : 'Um instante…');
    try {
      const r = await this.ctx.store.acaoDaDemanda(p.projeto, d.id, acao);
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível.', 'erro');
      // Retomar com outra demanda trabalhando: o serviço avisa que ela ficou na fila.
      this.aviso(r.aviso ?? sucesso, 'ok');
      if (acao !== 'mostrar' && acao !== 'retomar') {
        this.aberta = null;
        this.detalhe = null;
      }
      await this.load(false);
    } finally {
      this.ocupado = false;
    }
  }

  /** Manda a pergunta a quem fez a etapa: a demanda reabre com uma etapa de resposta e vai para "Em andamento". */
  private async perguntar(p: ProjetoHistorico, d: DemandaInfo, e: EtapaInfo, continuar: boolean): Promise<void> {
    if (this.ocupado) return;
    const texto = this.rascunho.trim();
    if (!texto) return this.aviso(continuar ? 'Escreva o que ele deve fazer.' : 'Escreva a pergunta.', 'erro');
    this.ocupado = true;
    this.aviso(continuar ? 'Reabrindo o trabalho…' : 'Enviando a pergunta…');
    try {
      const r = await this.ctx.store.acaoDaDemanda(p.projeto, d.id, 'perguntar', { etapa: e.n, texto, continuar });
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível enviar a pergunta.', 'erro');
      this.perguntando = null;
      this.rascunho = '';
      this.aba = 'andamento';
      if (r.aviso) this.aviso(r.aviso, 'ok');
      else this.aviso(continuar ? `Trabalho reaberto. ${nomeCurto(this.quem(p, e))} volta a trabalhar nesta demanda e pode chamar colegas.` : `Pergunta enviada. ${nomeCurto(this.quem(p, e))} vai responder aqui, numa etapa nova desta demanda (e pode chamar colegas, se precisar).`, 'ok');
      await this.load(false);
      this.renderList(true);
    } finally {
      this.ocupado = false;
    }
  }

  private verTerminal(p: ProjetoHistorico, e: EtapaInfo, opener: HTMLElement): void {
    // Sessão ainda aberta: o terminal ao vivo do agente.
    const vivo = (this.ctx.store.snapshot?.agents ?? []).find((a) => a.kind === 'main' && !a.parked && !!e.sessao && a.sessionId === e.sessao);
    if (vivo) {
      this.hide();
      return this.terminal.open(vivo.id, this.button);
    }
    const abrir = (sessoes: readonly RecentSession[]): boolean => {
      const s = sessaoDaEtapa(e, p.projeto, sessoes);
      if (!s) return false;
      this.hide();
      this.terminal.openSession(s, this.button);
      return true;
    };
    if (abrir(this.sessoes)) return;
    // A lista de sessões pode estar velha (etapa que acabou de fechar): busca de novo antes de desistir.
    opener.setAttribute('disabled', '');
    void this.lerSessoes().then((sessoes) => {
      opener.removeAttribute('disabled');
      this.sessoes = sessoes;
      if (!abrir(sessoes)) this.aviso('O terminal desta etapa não está mais guardado (ficam os dos últimos 7 dias). O resultado dela continua aqui.', 'erro');
    });
  }

  private renderEtapa(p: ProjetoHistorico, d: DemandaInfo, e: EtapaInfo): HTMLElement {
    const cheia = this.detalhe?.etapas.find((x) => x.n === e.n) ?? e;
    const aberta = this.etapasAbertas.has(e.n);
    const tempo = e.iniciadaEm ? duracaoTexto((e.terminadaEm ?? Date.now()) - e.iniciadaEm) : '';
    const head = h(
      'button',
      { class: 'ui-dem__etapa-head', type: 'button', attrs: { 'aria-expanded': String(aberta) }, title: aberta ? 'Esconder o que ele recebeu e entregou' : 'Ver o que ele recebeu e entregou' },
      h('span', { class: 'ui-dem__n', text: `${e.n}.` }),
      h('span', { class: 'ui-dem__quem', text: this.quem(p, e) }),
      h('span', { class: `ui-dem__chip ui-dem__chip--${e.estado}`, text: e.pergunta ? (e.estado === 'concluida' ? 'Respondeu' : 'Pergunta') : estadoTexto(e.estado) }),
      // A IA e o nível com que a etapa rodou (o motivo aparece ao passar o mouse e dentro da etapa).
      aiLabel(e.ia) ? h('span', { class: 'ui-dem__ia', text: aiLabel(e.ia), title: textoDaEscolha(e.ia) }) : null,
      h('span', { class: 'ui-dem__tempo', text: [e.iniciadaEm ? dataTexto(e.iniciadaEm) : '', tempo, tokensTexto(e.tokens)].filter(Boolean).join(' · '), title: e.tokens ? 'Tokens de entrada (com a releitura do contexto) e de saída gastos nesta etapa' : '' }),
    );
    head.addEventListener('click', () => {
      if (aberta) this.etapasAbertas.delete(e.n);
      else this.etapasAbertas.add(e.n);
      this.renderList(true);
    });
    const corpo = h('div', { class: 'ui-dem__etapa-body', hidden: !aberta });
    if (aberta) {
      if (e.pergunta) corpo.append(h('p', { class: 'ui-dem__rot', text: e.sobre ? `Sua pergunta sobre a etapa ${e.sobre}` : 'Sua pergunta' }), h('pre', { class: 'ui-dem__texto', text: cheia.instrucao ?? '' }));
      else if (e.continuacao) corpo.append(h('p', { class: 'ui-dem__rot', text: e.sobre ? `Você reabriu o trabalho a partir da etapa ${e.sobre}, com este pedido` : 'Você reabriu o trabalho com este pedido' }), h('pre', { class: 'ui-dem__texto', text: cheia.instrucao ?? '' }));
      else {
        if (e.passadaPor) corpo.append(h('p', { class: 'ui-dem__rot', text: e.subida ? 'Continuação da etapa anterior, que pediu mais capacidade' : `Quem passou o trabalho: ${this.quem(p, { agente: e.passadaPor })}` }));
        if (cheia.instrucao) corpo.append(h('p', { class: 'ui-dem__rot', text: 'O que recebeu para fazer' }), h('pre', { class: 'ui-dem__texto', text: cheia.instrucao }));
      }
      if (e.ia && (aiLabel(e.ia) || e.ia.motivo)) corpo.append(h('p', { class: 'ui-dem__rot', text: 'IA e nível' }), h('p', { class: 'ui-muted ui-small', text: textoDaEscolha(e.ia) }));
      corpo.append(h('p', { class: 'ui-dem__rot', text: e.pergunta ? 'Resposta' : 'O que entregou' }));
      corpo.append(cheia.resultado ? h('pre', { class: 'ui-dem__texto', text: cheia.resultado }) : h('p', { class: 'ui-rotp__vazio', text: this.detalhe ? (e.estado === 'fila' ? 'Ainda não começou.' : 'Ainda sem resultado gravado.') : 'Carregando…' }));
      if (e.iniciadaEm) {
        const ver = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: e.estado === 'rodando' ? 'Ver o terminal ao vivo' : 'Ver o terminal desta etapa', title: 'Abre a conversa do agente nesta etapa: tudo o que ele leu, rodou e escreveu' });
        ver.addEventListener('click', () => this.verTerminal(p, e, ver));
        const acoes = h('div', { class: 'ui-rotp__acoes' }, ver);
        // Demanda concluída: dá para perguntar a quem fez a etapa. Ele responde numa etapa nova, só de resposta.
        if (d.estado === 'concluida' && e.estado === 'concluida') {
          const nome = nomeCurto(this.quem(p, e));
          const perguntar = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: `Perguntar ou reabrir com ${nome}`, title: 'Tirar uma dúvida ou mandar reabrir o trabalho. Nos dois casos ele pode chamar colegas se precisar' });
          perguntar.addEventListener('click', () => {
            this.perguntando = this.perguntando === e.n ? null : e.n;
            this.rascunho = '';
            this.renderList(true);
          });
          acoes.append(perguntar);
        }
        corpo.append(acoes);
        if (this.perguntando === e.n) {
          const caixa = h('textarea', { class: 'ui-ask__text', attrs: { rows: 3, maxlength: 8000, placeholder: `Sua pergunta ou o que você quer que ${nomeCurto(this.quem(p, e))} faça…`, 'aria-label': 'Pergunta' }, on: { keydown: (ev: Event) => ev.stopPropagation() } });
          caixa.value = this.rascunho;
          caixa.addEventListener('input', () => (this.rascunho = caixa.value));
          const enviar = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Enviar pergunta', title: 'Ele responde. Se a pergunta pedir, ele mesmo decide reabrir o trabalho e chamar colegas' });
          enviar.addEventListener('click', () => void this.perguntar(p, d, e, false));
          const reabrir = h('button', { class: 'ui-btn', type: 'button', text: 'Reabrir o trabalho', title: 'Ele volta a trabalhar nesta demanda com o que você escreveu: pode refazer e chamar os colegas que precisar' });
          reabrir.addEventListener('click', () => void this.perguntar(p, d, e, true));
          corpo.append(
            h('div', { class: 'ui-dem__pergunta' }, caixa, h('div', { class: 'ui-ask__row' }, enviar, reabrir)),
            h('p', { class: 'ui-ask__dica', text: 'Enviar pergunta: ele responde e, se a pergunta pedir, pode reabrir o trabalho e chamar colegas por conta própria. Reabrir o trabalho: você manda ele voltar a trabalhar na demanda.' }),
          );
          queueMicrotask(() => caixa.focus());
        }
      }
    }
    return h('div', { class: `ui-dem__etapa${aberta ? ' is-open' : ''}` }, head, corpo);
  }

  private renderDemanda(p: ProjetoHistorico, d: DemandaInfo): HTMLElement {
    const chave = this.chaveDe(p, d);
    const aberta = this.aberta === chave;
    const head = h(
      'button',
      { class: 'ui-dem__head', type: 'button', attrs: { 'aria-expanded': String(aberta) } },
      h('span', { class: 'ui-dem__titulo', text: d.titulo }),
      h(
        'span',
        { class: 'ui-dem__meta' },
        h('span', { class: `ui-dem__chip ui-dem__chip--${d.aguardando && d.estado !== 'rodando' ? 'fila' : d.estado}`, text: d.arquivadaEm ? 'Arquivada' : d.aguardando && d.estado !== 'rodando' ? 'Na fila' : estadoTexto(d.estado) }),
        h('span', { text: [p.nome, dataTexto(d.criadaEm), progressoTexto(d, (e) => this.quem(p, e)), tokensTexto(d.etapas.reduce((soma, e) => soma + (e.tokens ?? 0), 0))].filter(Boolean).join(' · ') }),
      ),
    );
    head.addEventListener('click', () => void this.abrir(p, d));
    const item = h('div', { class: `ui-rot__item ui-dem__item${aberta ? ' is-open' : ''}` }, head);
    const acao = (texto: string, titulo: string, fn: () => void) => h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: texto, title: titulo, on: { click: fn } });
    // Retomar: o agente da etapa que parou abre de novo (sessão nova) e continua de onde parou.
    const daVez = d.etapas.find((e) => e.estado === 'parada') ?? d.etapas.find((e) => e.estado === 'fila');
    const retomar = () => acao('Retomar', 'Abre de novo o terminal do agente que parou: o trabalho continua de onde parou. Com outra demanda trabalhando, esta entra na fila', () => void this.agir(p, d, 'retomar', daVez ? `Terminal aberto para ${nomeCurto(this.quem(p, daVez))}: o trabalho continua de onde parou.` : 'Demanda retomada.'));
    // Demanda sem andar: o porquê fica à vista, mesmo com ela fechada na lista.
    const motivo = motivoDaDemanda(d);
    if (motivo) {
      item.append(
        h(
          'div',
          { class: 'ui-dem__motivo', attrs: { role: 'status' } },
          h('strong', { text: d.estado === 'parada' ? 'Por que parou: ' : 'Travou: ' }),
          h('span', { text: motivo.texto }),
          motivo.fazer ? h('span', { class: 'ui-dem__motivo-fazer', text: ` ${motivo.fazer}` }) : null,
          podeRetomar(d) ? h('div', { class: 'ui-dem__motivo-acoes' }, retomar()) : null,
          motivo.comando ? h('span', { class: 'ui-dem__motivo-cmd', text: `Ou, no Terminal: ${motivo.comando}`, title: 'O comando que retoma esta demanda, de onde ela parou' }) : null,
        ),
      );
    }
    if (!aberta) return item;
    const acoes = h('div', { class: 'ui-rotp__acoes' });
    // Parada sem motivo à vista (demanda antiga): o botão fica aqui.
    if (podeRetomar(d) && !motivo) acoes.append(retomar());
    if (d.estado === 'rodando') acoes.append(acao('Mostrar a janela do terminal', 'Traz para a frente a janela do Terminal em que o agente está trabalhando', () => void this.agir(p, d, 'mostrar', 'A janela do terminal está na frente.')));
    else if (d.arquivadaEm) acoes.append(acao('Desarquivar', 'Volta para a lista de concluídas', () => void this.agir(p, d, 'desarquivar', 'Demanda de volta à lista.')));
    else if (d.estado === 'concluida') acoes.append(acao('Conferi: arquivar', 'Tira da lista de concluídas; continua guardada em Arquivadas', () => void this.agir(p, d, 'arquivar', 'Demanda arquivada.')));
    else acoes.append(acao(d.aguardando ? 'Tirar da fila e arquivar' : 'Arquivar', d.aguardando ? 'Ela não vai mais começar sozinha; fica guardada em Arquivadas' : 'Tira da lista; continua guardada em Arquivadas', () => void this.agir(p, d, 'arquivar', 'Demanda arquivada.')));
    if (d.estado !== 'rodando') acoes.append(acao('Excluir', 'Manda a pasta da demanda para a lixeira da equipe', () => void this.agir(p, d, 'excluir', 'Demanda excluída.')));
    item.append(
      h('p', { class: 'ui-dem__rot', text: 'Pedido completo' }),
      h('pre', { class: 'ui-dem__texto', text: this.detalhe?.pedido || d.pedido || '(sem texto)' }),
      h('p', { class: 'ui-dem__rot', text: 'Etapas (clique numa para ver o que foi entregue)' }),
      ...d.etapas.map((e) => this.renderEtapa(p, d, e)),
      acoes,
    );
    return item;
  }

  private renderList(forcar: boolean): void {
    const todas = this.todas();
    this.rotulos();
    // A aba "Rotinas" é outro bloco (ui/rotinas.ts): a lista de demandas dá lugar a ele.
    const emRotinas = this.aba === 'rotinas';
    setHidden(this.list, emRotinas);
    if (emRotinas) {
      if (forcar) this.rotinas.mostrar();
      this.sig = '';
      return;
    }
    this.rotinas.esconder();
    const aba: Aba = this.aba as Aba;
    const visiveis = todas.filter((x) => abaDe(x.d) === aba);
    // Só redesenha quando algo mudou: redesenhar a cada 5 s tiraria o foco e a rolagem de quem está lendo.
    const nomes = (this.ctx.store.snapshot?.agents ?? []).filter((a) => a.staff).map((a) => `${a.staff}=${a.name}`).join(',');
    const sig = JSON.stringify([this.aba, this.aberta, this.perguntando, [...this.etapasAbertas], visiveis.map((x) => [x.p.projeto, x.d.id, x.d.estado, x.d.arquivadaEm, x.d.aguardando, x.d.etapas.map((e) => [e.n, e.agente, e.estado, e.temResultado, e.pergunta, e.continuacao, e.parada?.tipo, e.parada?.texto, Math.round((e.tokens ?? 0) / 200_000), e.ia?.modelo, e.ia?.nivel, e.ia?.motivo])]), this.detalhe, nomes, !!this.ctx.store.equipeKey]);
    if (!forcar && sig === this.sig) return;
    this.sig = sig;
    if (!visiveis.length) {
      const vazio: Record<Aba, string> = {
        andamento: 'Nenhuma demanda em andamento. Para mandar uma, clique num agente e escreva em "Nova demanda".',
        concluidas: 'Nenhuma demanda concluída esperando a sua conferência.',
        arquivadas: 'Nada arquivado ainda.',
      };
      this.list.replaceChildren(h('p', { class: 'ui-rotp__vazio', text: this.ctx.store.equipeKey ? vazio[aba] : '' }));
      return;
    }
    const topo = this.el.scrollTop;
    this.list.replaceChildren(...visiveis.map((x) => this.renderDemanda(x.p, x.d)));
    this.el.scrollTop = topo;
  }
}
