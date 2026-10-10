// Conversa com o dono do escritório (o ícone de balão na barra de cima; ver "Equipe: agentes fixos" no README.md).
// O dono é um agente fixo que representa quem usa o escritório: leva o nome da pessoa (o do usuário do computador,
// ou o que ela escolher aqui), tem uma sala só dele e fala com qualquer agente de qualquer sala
// (equipe/skills/dono-do-escritorio/SKILL.md). A pessoa escreve como numa conversa: cada mensagem vira uma demanda
// para ele, e o que ele responde (o `resultado.md`) aparece embaixo, como a fala dele.
// A tela só manda o pedido, com a chave do escritório; quem age é o serviço do computador.
import type { AgentInfo, RoomInfo } from '../../../shared/types';
import type { DemandaInfo, DonoInfo, ProjetoHistorico } from '../net/store';
import type { UiComponent, UiContext } from './context';
import { dataTexto, estadoTexto } from './demandas';
import { h, iconButton, setAttr, setHidden, setText } from './dom';
import { ICONS } from './icons';

/** O nome de arquivo do agente que é o dono (equipe/equipe.mjs, DONO). */
export const DONO = 'dono';
export const DONO_MAX = 40;
export const PEDIDO_MIN = 2;
export const PEDIDO_MAX = 4_000;
const ULTIMOS = 8;
const REFRESH_MS = 5_000;
const REOPEN_GUARD_MS = 250;

/** Como os agentes chamam quem usa: "o João", "a Marina"; sem nome nenhum, "o usuário". */
export function tratamentoDoDono(d: Pick<DonoInfo, 'nome' | 'feminino'> | undefined): string {
  const nome = d?.nome.trim();
  if (!nome) return d?.feminino ? 'a usuária' : 'o usuário';
  return `${d?.feminino ? 'a' : 'o'} ${nome}`;
}

/** O nome do personagem do dono na conversa: o da pessoa, ou "Dono" quando o computador não informou. */
export const nomeDoDono = (d: Pick<DonoInfo, 'nome'> | undefined): string => d?.nome.trim() || 'Dono';

/** De onde o nome veio, para a pessoa saber que pode trocar. */
export function origemDoDono(d: DonoInfo | undefined): string {
  if (!d?.nome.trim()) return 'Este computador não informou o nome do usuário. Clique para dar um nome ao dono.';
  return d.escolhido ? 'Nome escolhido por você. Clique para trocar.' : 'É o nome do usuário deste computador. Clique para trocar.';
}

/** O que impede de salvar o nome, ou '' quando dá. Vazio vale: volta ao nome do usuário do computador. */
export function faltaNoDono(nome: string): string {
  const n = nome.trim();
  if (!n) return '';
  if (n.length > DONO_MAX) return `Use até ${DONO_MAX} letras.`;
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(n)) return 'Use só letras no nome: ele entra nas regras que os agentes leem.';
  return '';
}

/** O que falta para mandar a mensagem ao dono, ou '' quando dá. */
export function faltaNoPedido(texto: string, temSala: boolean): string {
  if (!temSala) return 'A sala do dono ainda não existe neste computador. No terminal, rode: equipe escritorio';
  if (texto.trim().length < PEDIDO_MIN) return 'Escreva a mensagem.';
  return '';
}

/** A sala do dono (a que o servidor marca como `office`). */
export function salaDoEscritorio<T extends Pick<RoomInfo, 'id' | 'office'>>(rooms: readonly T[]): T | undefined {
  return rooms.find((r) => r.office);
}

/** As últimas mensagens da conversa, da mais antiga para a mais nova (as arquivadas ficam de fora). */
export function ultimosPedidos(projetos: readonly ProjetoHistorico[], sala: string | undefined, n = ULTIMOS): DemandaInfo[] {
  const p = projetos.find((x) => x.projeto === sala);
  return [...(p?.demandas ?? [])].filter((d) => !d.arquivadaEm).sort((a, b) => a.criadaEm - b.criadaEm).slice(-n);
}

/** Em que pé a mensagem está enquanto a resposta não chega, com o nome do dono. */
export function situacaoDoPedido(d: Pick<DemandaInfo, 'estado' | 'aguardando'>, esperandoResposta = false, nome = 'O dono'): string {
  if (esperandoResposta) return `${nome} tem uma dúvida e espera a sua resposta`;
  if (d.aguardando || d.estado === 'fila') return `Na fila: ${nome} começa quando terminar a mensagem anterior`;
  if (d.estado === 'rodando') return `${nome} está cuidando disso…`;
  if (d.estado === 'concluida') return 'Respondido';
  if (d.estado === 'parada') return 'Parou sem responder: veja o motivo em Demandas';
  return estadoTexto(d.estado);
}

/** A resposta do dono sem as marcas de formatação (título "# Resultado", negrito, crases): texto para ler. */
export function respostaLimpa(texto: string): string {
  return texto
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}\s*Resultado\s*\n+/i, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class EscritorioPopover implements UiComponent {
  readonly el: HTMLElement;
  /** O balão de conversa da barra de cima. */
  readonly button: HTMLButtonElement;
  private titulo: HTMLElement;
  private keyRow: HTMLElement;
  private keyInput: HTMLInputElement;
  private donoBtn: HTMLButtonElement;
  private donoNome: HTMLElement;
  private donoOrigem: HTMLElement;
  private donoForm: HTMLElement;
  private donoInput: HTMLInputElement;
  private donoArtigo: HTMLSelectElement;
  private donoSalvar: HTMLButtonElement;
  private donoMsg: HTMLElement;
  private conversa: HTMLElement;
  private pedido: HTMLTextAreaElement;
  private enviar: HTMLButtonElement;
  private msg: HTMLElement;
  private responder: HTMLButtonElement;
  private dono: DonoInfo | undefined;
  private projetos: ProjetoHistorico[] = [];
  /** A resposta de cada mensagem respondida, lida uma vez (id -> texto). */
  private resultados = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closedAt = -Infinity;
  private ocupado = false;
  private sig = '';

  constructor(private ctx: UiContext) {
    this.button = iconButton(ICONS.chat, 'Conversar com o dono do escritório: peça uma mudança ou mande um recado a qualquer agente', () => this.toggle(), 'ui-esc-btn');
    setAttr(this.button, 'aria-haspopup', 'dialog');
    setAttr(this.button, 'aria-expanded', 'false');

    const parar = (ev: Event) => ev.stopPropagation();
    this.keyInput = h('input', { class: 'ui-ask__key', type: 'password', attrs: { placeholder: 'Chave do escritório', 'aria-label': 'Chave do escritório', autocomplete: 'off', spellcheck: 'false' }, on: { keydown: parar } });
    const keyOk = h('button', { class: 'ui-btn', type: 'button', text: 'Entrar', on: { click: () => void this.entrar() } });
    this.keyRow = h(
      'div',
      { class: 'ui-rotp__key', hidden: true },
      h('p', { class: 'ui-ask__dica', text: 'Para conversar com o dono, cole a chave do escritório (no terminal: equipe chave). Uma vez por navegador.' }),
      h('div', { class: 'ui-rotp__keyline' }, this.keyInput, keyOk),
    );

    // ---- O nome do dono
    this.donoNome = h('span', { class: 'ui-esc__nome' });
    this.donoBtn = h('button', { class: 'ui-esc__dono', type: 'button', title: 'Trocar o nome do dono (é também como os agentes chamam você)', on: { click: () => this.editarDono() } }, this.donoNome);
    this.donoBtn.insertAdjacentHTML('beforeend', ICONS.pencil);
    this.donoOrigem = h('p', { class: 'ui-ask__dica' });
    this.donoInput = h('input', { class: 'ui-rotp__field', type: 'text', attrs: { placeholder: 'Seu nome', 'aria-label': 'Nome do dono do escritório', maxlength: String(DONO_MAX), autocomplete: 'off' }, on: { keydown: parar, input: () => this.sync() } });
    this.donoArtigo = h('select', { class: 'ui-rotp__field ui-esc__artigo', attrs: { 'aria-label': 'Como tratar' } }, h('option', { text: 'o (masculino)', attrs: { value: 'o' } }), h('option', { text: 'a (feminino)', attrs: { value: 'a' } }));
    this.donoSalvar = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Salvar nome', on: { click: () => void this.salvarDono(this.donoInput.value) } });
    this.donoMsg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });
    this.donoForm = h(
      'div',
      { class: 'ui-esc__form', hidden: true },
      h('div', { class: 'ui-esc__linha' }, this.donoArtigo, this.donoInput),
      h(
        'div',
        { class: 'ui-ask__row' },
        this.donoSalvar,
        h('button', { class: 'ui-btn', type: 'button', text: 'Usar o nome do computador', title: 'Volta ao nome do usuário deste computador', on: { click: () => void this.salvarDono('') } }),
        h('button', { class: 'ui-btn', type: 'button', text: 'Cancelar', on: { click: () => this.fecharDono() } }),
      ),
    );

    // ---- A conversa
    this.conversa = h('div', { class: 'ui-esc__conversa', role: 'log', attrs: { 'aria-label': 'Conversa com o dono do escritório' } });
    this.pedido = h('textarea', {
      class: 'ui-ask__text ui-esc__texto',
      attrs: {
        rows: '3',
        maxlength: String(PEDIDO_MAX),
        'aria-label': 'Mensagem para o dono do escritório',
        placeholder: 'Escreva como numa conversa. Ex.: "Crie uma sala Vendas na pasta ~/Documents/Vendas", "Pergunte à Ana como foi a campanha de ontem", "Deixe Vendas conversar com Marketing". Enter envia.',
      },
      on: {
        keydown: (ev: KeyboardEvent) => {
          ev.stopPropagation();
          // Enter envia, como numa conversa; Shift+Enter quebra a linha.
          if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
            ev.preventDefault();
            void this.mandar();
          }
        },
        input: () => this.sync(),
      },
    });
    this.enviar = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Enviar', on: { click: () => void this.mandar() } });
    this.msg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });
    this.responder = h('button', { class: 'ui-btn ui-esc__responder', type: 'button', text: 'Responder a dúvida', hidden: true, on: { click: () => this.irAoDono() } });

    this.titulo = h('h2', { text: 'Conversa com o dono' });
    const close = iconButton(ICONS.close, 'Fechar', () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-rotp ui-esc', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': 'Conversa com o dono do escritório', id: 'ui-escritorio', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, this.titulo, close),
      h('p', { class: 'ui-hist__hint', text: 'O dono do escritório age por você: muda o escritório (salas, agentes, ligações entre salas) e fala com qualquer agente de qualquer sala. Antes de apagar qualquer coisa, ele pergunta.' }),
      this.keyRow,
      h(
        'div',
        { class: 'ui-rotp__body' },
        h('div', { class: 'ui-esc__donolinha' }, h('span', { class: 'ui-muted', text: 'Nome do dono:' }), this.donoBtn),
        this.donoOrigem,
        this.donoForm,
        this.donoMsg,
        this.conversa,
        this.responder,
        this.pedido,
        h('div', { class: 'ui-ask__row' }, this.enviar, this.msg),
      ),
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
    this.abrir();
  }

  /** Abre a conversa (o balão da barra e o botão "Conversar com o dono" da sala dele). */
  abrir(): void {
    if (!this.isOpen) {
      const r = this.button.getBoundingClientRect();
      this.el.style.top = `${Math.round(r.bottom + 8)}px`;
      this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
      if (typeof this.el.showPopover === 'function') this.el.showPopover();
      else this.el.classList.add('is-open');
    }
    this.ctx.root.classList.add('has-popover');
    this.sig = '';
    void this.load();
    this.parar();
    this.timer = setInterval(() => void this.load(), REFRESH_MS);
    queueMicrotask(() => this.pedido.focus());
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.classList.remove('is-on');
    this.ctx.root.classList.remove('has-popover');
    this.parar();
  }

  /** A cada quadro: o botão de responder acompanha o dono (ele levanta a mão quando tem dúvida). */
  render(): void {
    if (!this.isOpen) return;
    setHidden(this.responder, !this.donoEsperando());
  }

  private parar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sala(): RoomInfo | undefined {
    return salaDoEscritorio(this.ctx.store.snapshot?.rooms ?? []);
  }

  /** O personagem do dono: o que está trabalhando, senão o parado na sala. */
  private agente(): AgentInfo | undefined {
    const sala = this.sala();
    if (!sala) return undefined;
    const todos = (this.ctx.store.snapshot?.agents ?? []).filter((a) => a.kind === 'main' && a.roomId === sala.id && a.staff === DONO);
    return todos.find((a) => !a.parked) ?? todos[0];
  }

  private donoEsperando(): boolean {
    const g = this.agente();
    return !!g && !g.parked && g.status === 'waiting';
  }

  private irAoDono(): void {
    const g = this.agente();
    if (!g) return;
    this.hide();
    this.ctx.select({ type: 'agent', id: g.id }, { focus: true });
  }

  private aviso(el: HTMLElement, text: string, kind: 'ok' | 'erro' | 'info' = 'info'): void {
    setText(el, text);
    setHidden(el, !text);
    el.className = `ui-ask__msg ui-ask__msg--${kind}`;
  }

  private async entrar(): Promise<void> {
    const k = this.keyInput.value.trim();
    if (!k) return;
    this.ctx.store.equipeKey = k;
    this.keyInput.value = '';
    await this.load();
  }

  private sync(): void {
    this.enviar.disabled = this.ocupado || !!faltaNoPedido(this.pedido.value, !!this.sala());
    this.donoSalvar.disabled = this.ocupado || !!faltaNoDono(this.donoInput.value) || !this.donoInput.value.trim();
    const falta = this.donoForm.hidden ? '' : faltaNoDono(this.donoInput.value);
    if (falta) this.aviso(this.donoMsg, falta, 'erro');
    else if (this.donoMsg.classList.contains('ui-ask__msg--erro') && !this.ocupado && !this.donoForm.hidden) this.aviso(this.donoMsg, '');
  }

  private async load(): Promise<void> {
    const store = this.ctx.store;
    const [estado, lista] = await Promise.all([store.equipeEstado(), store.equipeKey ? store.historico() : Promise.resolve(null)]);
    if (estado) this.dono = estado.dono;
    setHidden(this.keyRow, !!store.equipeKey && lista !== null);
    this.projetos = lista ?? [];
    // A resposta de cada mensagem respondida vem do detalhe da demanda, uma vez só.
    const sala = this.sala();
    for (const d of ultimosPedidos(this.projetos, sala?.id)) {
      if (d.estado !== 'concluida' || this.resultados.has(d.id) || !sala) continue;
      const cheia = await store.demandaDetalhe(sala.id, d.id);
      const texto = [...(cheia?.etapas ?? [])].reverse().find((e) => e.resultado)?.resultado;
      if (texto) this.resultados.set(d.id, texto);
    }
    this.renderTudo();
  }

  private renderTudo(): void {
    const nome = nomeDoDono(this.dono);
    setText(this.titulo, `Conversa com ${this.dono?.nome.trim() ? `${nome}, o dono` : 'o dono'}`);
    setText(this.donoNome, nome);
    setText(this.donoOrigem, origemDoDono(this.dono));
    const sala = this.sala();
    const ultimos = ultimosPedidos(this.projetos, sala?.id);
    const esperando = this.donoEsperando();
    setHidden(this.responder, !esperando);
    const sig = JSON.stringify([sala?.id, nome, esperando, !!this.ctx.store.equipeKey, ultimos.map((d) => [d.id, d.estado, d.aguardando, this.resultados.has(d.id)])]);
    if (sig !== this.sig) {
      this.sig = sig;
      const falas = ultimos.flatMap((d, i) => this.renderTroca(d, nome, i === ultimos.length - 1 && esperando));
      this.conversa.replaceChildren(...(falas.length ? falas : [h('p', { class: 'ui-rotp__vazio', text: sala ? `Nenhuma conversa ainda. Escreva abaixo o que você quer: ${nome} responde aqui.` : faltaNoPedido('', false) })]));
      // A conversa acompanha a fala mais nova.
      this.conversa.scrollTop = this.conversa.scrollHeight;
    }
    this.sync();
  }

  /** Uma troca da conversa: a mensagem da pessoa e, embaixo, a resposta do dono (ou em que pé está). */
  private renderTroca(d: DemandaInfo, nome: string, esperando: boolean): HTMLElement[] {
    const minha = h('div', { class: 'ui-esc__fala ui-esc__fala--eu' }, h('span', { class: 'ui-esc__quem', text: `Você · ${dataTexto(d.criadaEm)}` }), h('p', { class: 'ui-esc__balao', text: d.pedido || d.titulo }));
    const resposta = d.estado === 'concluida' ? this.resultados.get(d.id) : undefined;
    const viva = d.estado === 'rodando' && !d.aguardando;
    const dele = h(
      'div',
      { class: `ui-esc__fala ui-esc__fala--dono${resposta ? '' : ' is-espera'}` },
      h('span', { class: 'ui-esc__quem', text: nome }),
      h('p', { class: 'ui-esc__balao', text: resposta ? respostaLimpa(resposta) : d.estado === 'concluida' ? 'Carregando a resposta…' : situacaoDoPedido(d, viva && esperando, nome) }),
    );
    return [minha, dele];
  }

  private editarDono(): void {
    setHidden(this.donoForm, false);
    this.donoInput.value = this.dono?.nome ?? '';
    this.donoArtigo.value = this.dono?.feminino ? 'a' : 'o';
    this.aviso(this.donoMsg, '');
    this.sync();
    queueMicrotask(() => {
      this.donoInput.focus();
      this.donoInput.select();
    });
  }

  private fecharDono(): void {
    setHidden(this.donoForm, true);
    this.aviso(this.donoMsg, '');
  }

  private semChave(status: number | undefined): boolean {
    if (status !== 401 && status !== 403) return false;
    if (status === 401) this.ctx.store.equipeKey = '';
    setHidden(this.keyRow, false);
    this.keyInput.focus();
    return true;
  }

  /** Grava o nome (vazio = o do usuário do computador). O personagem do dono, a sala dele e as regras de todos os agentes passam a usar o novo. */
  private async salvarDono(nome: string): Promise<void> {
    if (this.ocupado || faltaNoDono(nome)) return;
    this.ocupado = true;
    this.sync();
    this.aviso(this.donoMsg, 'Um instante: avisando os agentes…');
    try {
      const r = await this.ctx.store.criarNaEquipe('dono', { nome: nome.trim(), feminino: this.donoArtigo.value === 'a' });
      if (this.semChave(r.status)) return this.aviso(this.donoMsg, r.status === 401 ? 'A chave não confere. Cole de novo (no terminal: equipe chave).' : (r.error ?? 'Crie a chave do escritório primeiro (no terminal: equipe chave).'), 'erro');
      if (!r.ok) return this.aviso(this.donoMsg, r.error ?? 'Não foi possível trocar o nome.', 'erro');
      setHidden(this.donoForm, true);
      const estado = await this.ctx.store.equipeEstado();
      if (estado) this.dono = estado.dono;
      this.aviso(this.donoMsg, `Pronto: o dono agora é ${nomeDoDono(this.dono)}, e a partir da próxima demanda os agentes chamam você de ${tratamentoDoDono(this.dono)}.`, 'ok');
      this.renderTudo();
    } finally {
      this.ocupado = false;
      this.sync();
    }
  }

  /** Manda a mensagem como demanda para o dono e acompanha até o terminal dele abrir (ou entrar na fila). */
  private async mandar(): Promise<void> {
    const sala = this.sala();
    const texto = this.pedido.value.trim();
    if (this.ocupado || !sala || faltaNoPedido(texto, true)) return;
    const store = this.ctx.store;
    const chave = store.equipeKey;
    if (!chave) {
      setHidden(this.keyRow, false);
      this.keyInput.focus();
      return this.aviso(this.msg, 'Cole a chave do escritório para enviar (no terminal: equipe chave).', 'erro');
    }
    const nome = nomeDoDono(this.dono);
    this.ocupado = true;
    this.sync();
    try {
      const r = await store.enviarDemanda(sala.id, DONO, texto, chave);
      if (this.semChave(r.status)) return this.aviso(this.msg, 'A chave não confere. Cole de novo (no terminal: equipe chave).', 'erro');
      if (!r.id) return this.aviso(this.msg, r.error ?? 'Não foi possível enviar a mensagem.', 'erro');
      this.aviso(this.msg, r.servico ? `Enviando para ${nome}…` : 'Enviada, mas o serviço da equipe não está respondendo. Esperando…');
      for (let i = 0; i < 70; i++) {
        await new Promise((ok) => setTimeout(ok, 1_000));
        const s = await store.demandaEstado(r.id, chave);
        if (!s || s.estado === 'pendente') continue;
        if (s.estado === 'aberta') {
          this.pedido.value = '';
          this.aviso(this.msg, s.aviso ?? '');
          return void this.load();
        }
        return this.aviso(this.msg, s.erro ?? 'A mensagem não chegou.', 'erro');
      }
      this.aviso(this.msg, 'O serviço da equipe não buscou a mensagem. No terminal: equipe servico status', 'erro');
    } finally {
      this.ocupado = false;
      this.sync();
    }
  }
}
