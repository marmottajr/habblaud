// Criar sala e agente pela tela (ver a seção "Equipe: agentes fixos" do README.md).
// Um "+" fica sobre a primeira vaga sem sala do prédio: abre "Nova sala" (nome + pasta escolhida na janela do Mac).
// Numa sala de equipe, "Novo agente" pede a função e uma descrição curta: o agente nasce fixo na sala e a primeira
// demanda dele é escrever a própria função completa. Quem cria de verdade é o serviço do Mac (equipe/equipe.mjs);
// a tela só manda o pedido, com a chave do escritório, e espera a resposta.
import type { AgentAiChange } from '../../../shared/ia';
import { roomCapacity } from '../../../shared/roomstyle';
import type { AgentInfo, RoomInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText } from './dom';
import { textoDaMudanca } from './ia';
import { ICONS } from './icons';

export const FUNCAO_MAX = 40;
export const SALA_MAX = 40;
export const DESCRICAO_MIN = 20;
export const DESCRICAO_MAX = 4_000;

/** O que falta para criar a sala, ou '' quando dá para criar. */
export function faltaNaSala(nome: string, pasta: string): string {
  if (nome.trim().length < 2) return 'Dê um nome para a sala.';
  if (!pasta) return 'Escolha a pasta em que a equipe vai trabalhar.';
  return '';
}

/** O que falta para criar o agente, ou '' quando dá para criar. */
export function faltaNoAgente(sala: string, funcao: string, descricao: string, cheia = ''): string {
  if (!sala) return 'Escolha a sala do agente.';
  if (cheia) return cheia;
  if (funcao.trim().length < 2) return 'Diga a função do agente (ex.: Designer).';
  if (descricao.trim().length < DESCRICAO_MIN) return 'Descreva em uma ou duas frases o que este agente faz.';
  return '';
}

/**
 * A lotação de uma sala de equipe: quantos agentes fixos ela tem, quantos pode ter (o limite das configurações da
 * sala, sem passar das mesas do layout), quantas mesas o layout tem e quantos agentes ainda cabem.
 */
export function lotacao(
  room: Pick<RoomInfo, 'id' | 'maxAgents' | 'style'>,
  agents: readonly Pick<AgentInfo, 'roomId' | 'staff' | 'kind'>[],
): { tem: number; limite: number; mesas: number; livres: number } {
  const tem = new Set(agents.filter((a) => a.roomId === room.id && a.kind === 'main' && a.staff).map((a) => a.staff)).size;
  const mesas = roomCapacity(room.style);
  const limite = room.maxAgents ?? mesas;
  return { tem, limite, mesas, livres: Math.max(0, limite - tem) };
}

/** O texto da lotação: "3 de 4 agentes", "Sala cheia: 4 de 4 agentes". */
export function textoDaLotacao(l: { tem: number; limite: number }): string {
  const base = `${l.tem} de ${l.limite} ${l.limite === 1 ? 'agente' : 'agentes'}`;
  return l.tem >= l.limite ? `Sala cheia: ${base}` : base;
}

/** Salas em que dá para criar agente: as de equipe (agentes fixos), na ordem do escritório. A do dono fica de fora. */
export function salasDeEquipe(rooms: readonly Pick<RoomInfo, 'id' | 'name' | 'team' | 'slot' | 'office'>[]): { id: string; name: string }[] {
  return rooms
    .filter((r) => r.team && !r.office)
    .sort((a, b) => a.slot - b.slot)
    .map((r) => ({ id: r.id, name: r.name }));
}

/** "Conversa com": as outras salas de equipe, cada uma dizendo se já conversa com esta. */
export function salasParaLigar(rooms: readonly Pick<RoomInfo, 'id' | 'name' | 'team' | 'slot' | 'office' | 'links'>[], atual: string): { id: string; name: string; ligada: boolean }[] {
  const eu = rooms.find((r) => r.id === atual);
  if (!eu?.team || eu.office) return [];
  return salasDeEquipe(rooms)
    .filter((r) => r.id !== atual)
    .map((r) => ({ ...r, ligada: !!eu.links?.includes(r.id) || !!rooms.find((x) => x.id === r.id)?.links?.includes(atual) }));
}

/** A pergunta de ligar ou desligar duas salas: diz o que muda para os agentes das duas. */
export function textoDeLigar(a: string, b: string, ligar: boolean): { titulo: string; texto: string; botao: string } {
  if (ligar)
    return {
      titulo: 'Ligar salas',
      texto: `Fazer a sala "${a}" conversar com a sala "${b}"? Os agentes das duas vão poder passar trabalho uns para os outros. Quem é chamado trabalha na pasta da sala que chamou, com as permissões dela, e continua morando na própria sala.`,
      botao: 'Sim, ligar as duas salas',
    };
  return {
    titulo: 'Desligar salas',
    texto: `Fazer a sala "${a}" parar de conversar com a sala "${b}"? Os agentes de uma deixam de receber trabalho da outra. Ninguém é apagado e as demandas já feitas continuam guardadas.`,
    botao: 'Sim, desligar as duas salas',
  };
}

/** A pergunta de "Excluir sala": diz o que sai (a sala e os agentes dela) e o que fica (a pasta). */
export function textoDeExcluirSala(nome: string, agentes: readonly string[]): { texto: string; botao: string } {
  const n = agentes.length;
  const fica = 'A pasta e os arquivos dela continuam onde estão, e as demandas já feitas continuam guardadas na pasta.';
  if (!n) return { texto: `Excluir a sala "${nome}" do escritório? Ela não tem agentes. ${fica}`, botao: 'Sim, excluir a sala' };
  const quem = n === 1 ? `o agente dela (${agentes[0]})` : `os ${n} agentes dela (${agentes.join(', ')})`;
  return {
    texto: `Excluir a sala "${nome}" e ${quem}? ${n === 1 ? 'Ele deixa' : 'Eles deixam'} de receber demandas. ${n === 1 ? 'O arquivo da função e o caderno dele' : 'Os arquivos de função e os cadernos'} vão para a lixeira da equipe (dá para recuperar). ${fica}`,
    botao: n === 1 ? 'Sim, excluir a sala e o agente' : `Sim, excluir a sala e os ${n} agentes`,
  };
}

/** Caminho curto para mostrar: a pasta pessoal vira "~". */
export function pastaCurta(pasta: string): string {
  return pasta.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

type Modo = 'sala' | 'agente' | 'funcao' | 'confirmar';

export const FUNCAO_TEXTO_MIN = 50;
export const FUNCAO_TEXTO_MAX = 40_000;

/** O que falta para salvar a função editada, ou '' quando dá para salvar. */
export function faltaNaFuncao(titulo: string, texto: string): string {
  if (titulo.trim().length < 2) return 'Diga a função do agente (ex.: Designer).';
  if (texto.trim().length < FUNCAO_TEXTO_MIN) return 'A função ficou curta demais: escreva o que o agente faz.';
  return '';
}

export class CriarPopover implements UiComponent {
  readonly el: HTMLElement;
  /** O "+" que fica sobre a vaga livre do prédio. */
  readonly plus: HTMLButtonElement;
  private titulo: HTMLElement;
  private dica: HTMLElement;
  private keyRow: HTMLElement;
  private keyInput: HTMLInputElement;
  private msg: HTMLElement;
  private formSala: HTMLElement;
  private formAgente: HTMLElement;
  private nomeSala: HTMLInputElement;
  private pastaTexto: HTMLElement;
  private pastaBtn: HTMLButtonElement;
  private criarSalaBtn: HTMLButtonElement;
  private salaSelect: HTMLSelectElement;
  private funcao: HTMLInputElement;
  private descricao: HTMLTextAreaElement;
  private visual: HTMLSelectElement;
  private criarAgenteBtn: HTMLButtonElement;
  private formFuncao: HTMLElement;
  private funcaoTitulo: HTMLInputElement;
  private funcaoTexto: HTMLTextAreaElement;
  private salvarFuncaoBtn: HTMLButtonElement;
  private formConfirmar: HTMLElement;
  private confirmarTexto: HTMLElement;
  private confirmarBtn: HTMLButtonElement;
  /** Agente cuja função está aberta no editor. */
  private alvo: { room: string; slug: string; nome: string } | null = null;
  /** O que o botão de confirmar faz (apagar agente, remover sala). */
  private aoConfirmar: (() => Promise<void>) | null = null;
  private modo: Modo = 'sala';
  private pasta = '';
  private ocupado = false;
  /** Sala recém-criada: o painel já a deixa escolhida, mesmo antes de o escritório mostrá-la. */
  private salaNova: { id: string; name: string } | null = null;
  private salasSig = '';
  /** Os "+" sobre as mesas livres da sala de equipe selecionada: cada um cria um agente nela. */
  readonly vagas = h('div', { class: 'ui-vagas', hidden: true });
  private vagaBtns: HTMLButtonElement[] = [];

  constructor(private ctx: UiContext) {
    const parar = (ev: Event) => ev.stopPropagation();
    this.plus = h(
      'button',
      { class: 'ui-novasala', type: 'button', hidden: true, title: 'Criar uma sala fixa aqui: uma equipe de agentes numa pasta sua', attrs: { 'aria-label': 'Nova sala' }, on: { click: () => this.abrirSala() } },
      h('span', { class: 'ui-novasala__mais', text: '+', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-novasala__texto', text: 'Nova sala' }),
    );

    this.keyInput = h('input', { class: 'ui-ask__key', type: 'password', attrs: { placeholder: 'Chave do escritório', 'aria-label': 'Chave do escritório', autocomplete: 'off', spellcheck: 'false' }, on: { keydown: parar } });
    const keyOk = h('button', { class: 'ui-btn', type: 'button', text: 'Entrar', on: { click: () => this.entrar() } });
    this.keyRow = h(
      'div',
      { class: 'ui-rotp__key', hidden: true },
      h('p', { class: 'ui-ask__dica', text: 'Para criar sala e agente, cole a chave do escritório (no terminal: equipe chave). Uma vez por navegador.' }),
      h('div', { class: 'ui-rotp__keyline' }, this.keyInput, keyOk),
    );

    // ---- Nova sala
    this.nomeSala = h('input', { class: 'ui-rotp__field', type: 'text', attrs: { placeholder: 'Ex.: Equipe de Vendas', 'aria-label': 'Nome da sala', maxlength: String(SALA_MAX), autocomplete: 'off' }, on: { keydown: parar, input: () => this.sync() } });
    this.pastaTexto = h('span', { class: 'ui-criar__pasta', text: 'Nenhuma pasta escolhida' });
    this.pastaBtn = h('button', { class: 'ui-btn', type: 'button', text: 'Escolher pasta…', title: 'Abre a janela do Mac para escolher (ou criar) a pasta. A janela pode abrir atrás do navegador', on: { click: () => void this.escolherPasta() } });
    this.criarSalaBtn = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Criar sala', on: { click: () => void this.criarSala() } });
    this.formSala = h(
      'div',
      { class: 'ui-criar__form' },
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Nome da sala' }), this.nomeSala),
      h('div', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Pasta em que a equipe vai trabalhar' }), h('div', { class: 'ui-criar__linha' }, this.pastaBtn, this.pastaTexto)),
      h('p', { class: 'ui-ask__dica', text: 'Os agentes desta sala trabalham dentro dessa pasta. Arquivos de senha (.env), as chaves do computador e as pastas que você marcou como protegidas ficam bloqueados para eles.' }),
      h('div', { class: 'ui-ask__row' }, this.criarSalaBtn),
    );

    // ---- Novo agente
    this.salaSelect = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Sala do agente' }, on: { change: () => this.sync() } });
    this.funcao = h('input', { class: 'ui-rotp__field', type: 'text', attrs: { placeholder: 'Ex.: Designer', 'aria-label': 'Função do agente', maxlength: String(FUNCAO_MAX), autocomplete: 'off' }, on: { keydown: parar, input: () => this.sync() } });
    this.descricao = h('textarea', {
      class: 'ui-ask__text',
      attrs: {
        rows: '6',
        maxlength: String(DESCRICAO_MAX),
        'aria-label': 'O que este agente faz',
        placeholder: 'Ex.: Cria as artes estáticas e os carrosséis da marca, seguindo a identidade visual. Recebe o texto do copywriter e entrega a arte pronta em PNG. Não escreve texto novo por conta própria.',
      },
      on: { keydown: parar, input: () => this.sync() },
    });
    this.visual = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Aparência do personagem' } }, h('option', { text: 'Sortear', attrs: { value: '' } }), h('option', { text: 'Feminina', attrs: { value: 'f' } }), h('option', { text: 'Masculina', attrs: { value: 'm' } }));
    this.criarAgenteBtn = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Criar agente', on: { click: () => void this.criarAgente() } });
    this.formAgente = h(
      'div',
      { class: 'ui-criar__form', hidden: true },
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Sala' }), this.salaSelect),
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Função (aparece ao lado do nome)' }), this.funcao),
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'O que ele faz, com as suas palavras' }), this.descricao),
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Aparência do personagem' }), this.visual),
      h('p', { class: 'ui-ask__dica', text: 'O agente entra na sala na hora, como agente fixo. A primeira demanda dele é escrever a própria função completa a partir da sua descrição: dá para acompanhar em Demandas.' }),
      h('div', { class: 'ui-ask__row' }, this.criarAgenteBtn),
    );

    // ---- Editar a função de um agente fixo
    this.funcaoTitulo = h('input', { class: 'ui-rotp__field', type: 'text', attrs: { 'aria-label': 'Função do agente', maxlength: String(FUNCAO_MAX), autocomplete: 'off' }, on: { keydown: parar, input: () => this.sync() } });
    this.funcaoTexto = h('textarea', { class: 'ui-ask__text ui-criar__funcao', attrs: { rows: '18', maxlength: String(FUNCAO_TEXTO_MAX), 'aria-label': 'Texto da função', spellcheck: 'false' }, on: { keydown: parar, input: () => this.sync() } });
    this.salvarFuncaoBtn = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Salvar função', on: { click: () => void this.salvarFuncao() } });
    this.formFuncao = h(
      'div',
      { class: 'ui-criar__form', hidden: true },
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'Função (aparece ao lado do nome)' }), this.funcaoTitulo),
      h('label', { class: 'ui-criar__campo' }, h('span', { class: 'ui-dem__rot', text: 'O que ele faz e como trabalha' }), this.funcaoTexto),
      h('p', { class: 'ui-ask__dica', text: 'É o texto que o agente lê em toda demanda. As regras da equipe (caderno, entrega, pedir o seu ok) continuam valendo por baixo e não aparecem aqui. A mudança vale a partir da próxima demanda dele.' }),
      h('div', { class: 'ui-ask__row' }, this.salvarFuncaoBtn),
    );

    // ---- Confirmar (apagar agente, remover sala)
    this.confirmarTexto = h('p', { class: 'ui-criar__confirmar' });
    this.confirmarBtn = h('button', { class: 'ui-btn ui-criar__perigo', type: 'button', text: 'Confirmar', on: { click: () => void this.confirmar() } });
    this.formConfirmar = h('div', { class: 'ui-criar__form', hidden: true }, this.confirmarTexto, h('div', { class: 'ui-ask__row' }, h('button', { class: 'ui-btn', type: 'button', text: 'Não, deixar como está', on: { click: () => this.hide() } }), this.confirmarBtn));

    this.titulo = h('h2', { text: 'Nova sala' });
    this.dica = h('p', { class: 'ui-hist__hint' });
    this.msg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });
    const close = iconButton(ICONS.close, 'Fechar', () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-rotp ui-criar', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': 'Criar sala ou agente', id: 'ui-criar', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, this.titulo, close),
      this.dica,
      this.keyRow,
      h('div', { class: 'ui-rotp__body' }, this.formSala, this.formAgente, this.formFuncao, this.formConfirmar, this.msg),
    );
    this.el.addEventListener('toggle', () => this.ctx.root.classList.toggle('has-popover', this.isOpen));
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  abrirSala(): void {
    this.trocar('sala');
    this.aviso('');
    this.show();
    queueMicrotask(() => this.nomeSala.focus());
  }

  abrirAgente(roomId?: string): void {
    this.trocar('agente');
    this.aviso('');
    this.syncSalas(true);
    if (roomId && [...this.salaSelect.options].some((o) => o.value === roomId)) this.salaSelect.value = roomId;
    this.sync();
    this.show();
    queueMicrotask(() => this.funcao.focus());
  }

  /** Abre o editor com a função de hoje do agente (quem lê o arquivo é o serviço do Mac). */
  async editarFuncao(room: string, slug: string, nome: string): Promise<void> {
    this.alvo = { room, slug, nome };
    this.trocar('funcao');
    this.funcaoTitulo.value = '';
    this.funcaoTexto.value = '';
    this.funcaoTexto.disabled = true;
    this.aviso('Buscando a função…');
    this.show();
    await this.rodar(async () => {
      const r = await this.ctx.store.criarNaEquipe('ler-funcao', { room, slug });
      if (this.alvo?.slug !== slug || this.alvo.room !== room) return;
      if (this.semChave(r.status)) return;
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível ler a função.', 'erro');
      this.funcaoTitulo.value = r.funcao ?? '';
      this.funcaoTexto.value = r.texto ?? '';
      this.funcaoTexto.disabled = false;
      this.aviso('');
    });
  }

  /** Pede a confirmação para apagar um agente fixo parado. */
  pedirApagarAgente(room: string, slug: string, nome: string): void {
    this.pedirConfirmacao(
      'Apagar agente',
      `Apagar ${nome}? Ele sai da sala e não recebe mais demandas. O arquivo da função e o caderno dele vão para a lixeira da equipe (dá para recuperar). As demandas que ele já fez continuam no histórico.`,
      'Sim, apagar o agente',
      async () => {
        const r = await this.ctx.store.criarNaEquipe('apagar-agente', { room, slug });
        if (this.semChave(r.status)) return;
        if (!r.ok) return this.aviso(r.error ?? 'Não foi possível apagar o agente.', 'erro');
        this.concluir(`${nome} foi apagado.`);
        // A gaveta dele não tem mais o que mostrar.
        if (this.ctx.selection()?.type === 'agent') this.ctx.select(null);
      },
    );
  }

  /** Pede a confirmação para excluir uma sala de equipe, com os agentes fixos que ela tiver. */
  pedirRemoverSala(room: string, nome: string): void {
    // Os agentes fixos da sala (parados ou trabalhando), uma vez cada.
    const fixos = new Map<string, string>();
    for (const a of this.ctx.store.snapshot?.agents ?? []) if (a.roomId === room && a.staff && !fixos.has(a.staff)) fixos.set(a.staff, a.job ? `${a.name} · ${a.job}` : a.name);
    const { texto, botao } = textoDeExcluirSala(nome, [...fixos.values()]);
    this.pedirConfirmacao('Excluir sala', texto, botao, async () => {
      const r = await this.ctx.store.criarNaEquipe('remover-sala', { room });
      if (this.semChave(r.status)) return;
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível excluir a sala.', 'erro');
      if (this.salaNova?.id === room) this.salaNova = null;
      this.concluir(`A sala "${nome}" foi excluída do escritório.`);
      if (this.ctx.selection()) this.ctx.select(null);
    });
  }

  /** Gaveta do agente fixo: pede a confirmação para mudar a IA, o nível, o mínimo ou a permissão dele. */
  pedirIA(room: string, slug: string, nome: string, mudanca: AgentAiChange): void {
    this.pedirConfirmacao(
      `IA de ${nome}`,
      `Mudar em ${nome}: ${textoDaMudanca(mudanca)}. Vale a partir do próximo trabalho dele.`,
      'Salvar',
      async () => {
        const r = await this.ctx.store.criarNaEquipe('ia', { room, slug, ia: mudanca });
        if (this.semChave(r.status)) return;
        if (!r.ok) return this.aviso(r.error ?? 'Não foi possível mudar a IA do agente.', 'erro');
        this.concluir(`Pronto: a IA de ${nome} foi atualizada.`);
      },
      false,
    );
  }

  /** Configurações da sala: pede a confirmação para mudar quantos agentes fixos ela pode ter. */
  pedirLimite(room: string, limite: number): void {
    const nome = this.ctx.store.room(room)?.name ?? 'sala';
    const n = `${limite} ${limite === 1 ? 'agente' : 'agentes'}`;
    this.pedirConfirmacao(
      'Limite de agentes',
      `A sala "${nome}" passa a aceitar até ${n}. Os agentes que ela já tem continuam.`,
      `Definir: até ${n}`,
      async () => {
        const r = await this.ctx.store.criarNaEquipe('limite', { room, limite });
        if (this.semChave(r.status)) return;
        if (!r.ok) return this.aviso(r.error ?? 'Não foi possível mudar o limite da sala.', 'erro');
        this.concluir(`Pronto: "${nome}" aceita até ${n}.`);
      },
      false,
    );
  }

  /** "Conversa com": pede a confirmação para ligar (ou desligar) esta sala e a outra. */
  pedirLigacao(room: string, outra: string, ligar: boolean): void {
    const nome = (id: string) => this.ctx.store.room(id)?.name ?? 'sala';
    const { titulo, texto, botao } = textoDeLigar(nome(room), nome(outra), ligar);
    this.pedirConfirmacao(
      titulo,
      texto,
      botao,
      async () => {
        const r = await this.ctx.store.criarNaEquipe('ligar-sala', { room, outra, ligar });
        if (this.semChave(r.status)) return;
        if (!r.ok) return this.aviso(r.error ?? (ligar ? 'Não foi possível ligar as salas.' : 'Não foi possível desligar as salas.'), 'erro');
        this.concluir(ligar ? `Pronto: "${nome(room)}" e "${nome(outra)}" já conversam. Vale a partir da próxima demanda.` : `Pronto: "${nome(room)}" e "${nome(outra)}" não conversam mais.`);
      },
      !ligar,
    );
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.ctx.root.classList.remove('has-popover');
  }

  /** A cada quadro: o "+" acompanha a vaga livre do prédio; a lista de salas acompanha o escritório. */
  render(): void {
    const snap = this.ctx.store.snapshot;
    const vaga = snap && !snap.meta.demo ? (this.ctx.world.freeSlotScreen?.() ?? null) : null;
    setHidden(this.plus, !vaga);
    if (vaga) {
      // A vaga pode estar além da borda (prédio cheio, câmera em outro canto): o "+" fica encostado na borda,
      // do lado em que a sala nova vai ser erguida, sem sair da tela nem entrar por baixo da barra de cima.
      const dentro = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));
      const cx = vaga.x + vaga.w / 2;
      const cy = vaga.y + vaga.h / 2;
      // Sem espaço para o texto (vaga além da borda, ou escritório visto de longe): só o "+", na beirada.
      const naBorda = cx > innerWidth - 80 || cx < 80;
      this.plus.style.left = `${Math.round(dentro(cx, naBorda ? 26 : 80, innerWidth - (naBorda ? 26 : 80)))}px`;
      this.plus.style.top = `${Math.round(dentro(cy, 110, innerHeight - 70))}px`;
      this.plus.classList.toggle('is-compacto', naBorda || vaga.w < 150);
    }
    if (this.isOpen && this.modo === 'agente') this.syncSalas(false);
    this.renderVagas();
  }

  /**
   * Sala de equipe selecionada (clicada): um "+" sobre cada mesa livre, até o limite de agentes da sala. Clicar
   * num deles abre "Novo agente" já nessa sala.
   */
  private renderVagas(): void {
    const snap = this.ctx.store.snapshot;
    const sel = this.ctx.selection();
    const room = sel?.type === 'room' && snap && !snap.meta.demo && !this.ctx.store.replaying ? snap.rooms.find((r) => r.id === sel.id) : undefined;
    const livres = room?.team && !room.office ? lotacao(room, snap!.agents).livres : 0;
    const onde = room && livres > 0 ? (this.ctx.world.freeDesksScreen?.(room.id, livres) ?? []) : [];
    setHidden(this.vagas, !onde.length);
    while (this.vagaBtns.length < onde.length) {
      const b = h('button', { class: 'ui-vaga', type: 'button', text: '+', title: 'Mesa livre: criar um agente de IA nesta sala', attrs: { 'aria-label': 'Novo agente nesta mesa' }, on: { click: () => this.abrirAgente(this.ctx.selection()?.id) } });
      this.vagaBtns.push(b);
      this.vagas.append(b);
    }
    this.vagaBtns.forEach((b, i) => {
      const p = onde[i];
      setHidden(b, !p);
      if (!p) return;
      // O "+" acompanha o tamanho do escritório na tela (entre 16 e 30 px).
      const lado = Math.round(Math.min(30, Math.max(16, p.tile * 0.8)));
      b.style.left = `${Math.round(p.x)}px`;
      b.style.top = `${Math.round(p.y)}px`;
      b.style.width = b.style.height = `${lado}px`;
      b.style.fontSize = `${Math.round(lado * 0.75)}px`;
    });
  }

  private show(): void {
    if (!this.isOpen) {
      if (typeof this.el.showPopover === 'function') this.el.showPopover();
      else this.el.classList.add('is-open');
    }
    this.ctx.root.classList.add('has-popover');
    setHidden(this.keyRow, !!this.ctx.store.equipeKey);
    this.sync();
  }

  private trocar(modo: Modo, titulo?: string): void {
    this.modo = modo;
    setHidden(this.formSala, modo !== 'sala');
    setHidden(this.formAgente, modo !== 'agente');
    setHidden(this.formFuncao, modo !== 'funcao');
    setHidden(this.formConfirmar, modo !== 'confirmar');
    this.el.classList.toggle('is-largo', modo === 'funcao');
    setText(this.titulo, titulo ?? (modo === 'sala' ? 'Nova sala' : modo === 'agente' ? 'Novo agente' : modo === 'funcao' ? `Função de ${this.alvo?.nome ?? 'agente'}` : 'Confirmar'));
    const dicas: Record<Modo, string> = {
      sala: 'Uma sala fixa é uma equipe de agentes que trabalha numa pasta sua, como uma equipe de marketing ou de suporte. Ela fica no escritório mesmo sem ninguém trabalhando.',
      agente: 'Descreva o agente como você descreveria a um colega. Ele vira um agente fixo da sala e recebe demandas como os outros.',
      funcao: 'Aqui você lê e muda a função do agente: o que ele faz, como trabalha, o que entrega e os limites.',
      confirmar: '',
    };
    setText(this.dica, dicas[modo]);
    setHidden(this.dica, !dicas[modo]);
  }

  private pedirConfirmacao(titulo: string, texto: string, botao: string, acao: () => Promise<void>, perigo = true): void {
    this.aoConfirmar = acao;
    this.trocar('confirmar', titulo);
    setText(this.confirmarTexto, texto);
    setText(this.confirmarBtn, botao);
    // Vermelho só no que apaga ou desfaz; o que só acrescenta usa o botão comum.
    this.confirmarBtn.classList.toggle('ui-criar__perigo', perigo);
    this.confirmarBtn.classList.toggle('ui-ask__send', !perigo);
    setHidden(this.confirmarBtn, false);
    this.aviso('');
    this.show();
  }

  private async confirmar(): Promise<void> {
    const acao = this.aoConfirmar;
    if (!acao) return;
    await this.rodar(async () => {
      this.aviso('Um instante…');
      await acao();
    });
  }

  /** Feito: some a pergunta e fica só o recado. */
  private concluir(texto: string): void {
    this.aoConfirmar = null;
    setText(this.confirmarTexto, '');
    setHidden(this.confirmarBtn, true);
    this.aviso(texto, 'ok');
  }

  private async salvarFuncao(): Promise<void> {
    const alvo = this.alvo;
    if (!alvo) return;
    const funcao = this.funcaoTitulo.value.trim();
    const texto = this.funcaoTexto.value.trim();
    const falta = faltaNaFuncao(funcao, texto);
    if (falta) return this.aviso(falta, 'erro');
    await this.rodar(async () => {
      this.aviso('Salvando…');
      const r = await this.ctx.store.criarNaEquipe('funcao', { room: alvo.room, slug: alvo.slug, funcao, texto });
      if (this.semChave(r.status)) return;
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível salvar a função.', 'erro');
      this.aviso(`Função de ${alvo.nome} salva. Vale a partir da próxima demanda dele.`, 'ok');
    });
  }

  private aviso(text: string, kind: 'ok' | 'erro' | 'info' = 'info'): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.className = `ui-ask__msg ui-ask__msg--${kind}`;
  }

  private entrar(): void {
    const k = this.keyInput.value.trim();
    if (!k) return;
    this.ctx.store.equipeKey = k;
    this.keyInput.value = '';
    setHidden(this.keyRow, true);
    this.aviso('');
  }

  /** O pedido voltou sem chave ou com chave errada: pede de novo. */
  private semChave(status: number | undefined): boolean {
    if (status !== 401 && status !== 403) return false;
    setHidden(this.keyRow, false);
    this.aviso(status === 403 ? 'Criar pela tela está desligado: crie a chave no computador com "equipe chave".' : 'Cole a chave do escritório acima e tente de novo.', 'erro');
    return true;
  }

  private syncSalas(forcar: boolean): void {
    const salas = salasDeEquipe(this.ctx.store.snapshot?.rooms ?? []);
    if (this.salaNova && !salas.some((s) => s.id === this.salaNova!.id)) salas.push(this.salaNova);
    const sig = salas.map((s) => `${s.id}\n${s.name}`).join('\n\n');
    if (!forcar && sig === this.salasSig) return;
    this.salasSig = sig;
    const antes = this.salaSelect.value;
    this.salaSelect.replaceChildren(...salas.map((s) => h('option', { text: s.name, attrs: { value: s.id } })));
    if (salas.some((s) => s.id === antes)) this.salaSelect.value = antes;
    this.sync();
  }

  /** O aviso de sala cheia (o limite de agentes das configurações da sala foi atingido), ou ''. */
  private salaCheia(id: string): string {
    const snap = this.ctx.store.snapshot;
    const room = snap?.rooms.find((r) => r.id === id);
    if (!room || !snap) return '';
    const l = lotacao(room, snap.agents);
    return l.livres > 0 ? '' : `${textoDaLotacao(l)}. Aumente o limite nas configurações da sala ou apague um agente.`;
  }

  private sync(): void {
    this.criarSalaBtn.disabled = this.ocupado || !!faltaNaSala(this.nomeSala.value, this.pasta);
    this.pastaBtn.disabled = this.ocupado;
    const falta = faltaNoAgente(this.salaSelect.value, this.funcao.value, this.descricao.value, this.salaCheia(this.salaSelect.value));
    this.criarAgenteBtn.disabled = this.ocupado || !!falta;
    setAttr(this.criarSalaBtn, 'title', faltaNaSala(this.nomeSala.value, this.pasta) || 'Cria a sala no escritório');
    setAttr(this.criarAgenteBtn, 'title', falta || 'Cria o agente fixo na sala');
    this.salvarFuncaoBtn.disabled = this.ocupado || this.funcaoTexto.disabled || !!faltaNaFuncao(this.funcaoTitulo.value, this.funcaoTexto.value);
    this.confirmarBtn.disabled = this.ocupado;
  }

  private async rodar<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.ocupado) return undefined;
    this.ocupado = true;
    this.sync();
    try {
      return await fn();
    } finally {
      this.ocupado = false;
      this.sync();
    }
  }

  private async escolherPasta(): Promise<void> {
    await this.rodar(async () => {
      this.aviso('A janela de escolher pasta abriu no Mac (pode estar atrás do navegador). Escolha a pasta, ou crie uma com "Nova Pasta".');
      const r = await this.ctx.store.criarNaEquipe('pasta');
      if (this.semChave(r.status)) return;
      if (!r.ok || !r.pasta) return this.aviso(r.error ?? 'Não foi possível escolher a pasta.', 'erro');
      this.pasta = r.pasta;
      setText(this.pastaTexto, pastaCurta(r.pasta));
      this.pastaTexto.title = r.pasta;
      this.pastaTexto.classList.add('is-ok');
      this.aviso('');
      // Sem nome ainda: sugere o da pasta.
      if (!this.nomeSala.value.trim()) this.nomeSala.value = (r.pasta.split('/').pop() ?? '').slice(0, SALA_MAX);
    });
  }

  private async criarSala(): Promise<void> {
    const nome = this.nomeSala.value.trim();
    const falta = faltaNaSala(nome, this.pasta);
    if (falta) return this.aviso(falta, 'erro');
    await this.rodar(async () => {
      this.aviso('Criando a sala…');
      const r = await this.ctx.store.criarNaEquipe('sala', { nome, pasta: this.pasta });
      if (this.semChave(r.status)) return;
      if (!r.ok || !r.sala) return this.aviso(r.error ?? 'Não foi possível criar a sala.', 'erro');
      this.salaNova = { id: r.sala, name: nome };
      this.nomeSala.value = '';
      this.pasta = '';
      setText(this.pastaTexto, 'Nenhuma pasta escolhida');
      this.pastaTexto.classList.remove('is-ok');
      // Sala criada: o passo seguinte é o primeiro agente dela.
      this.trocar('agente');
      this.syncSalas(true);
      this.salaSelect.value = r.sala;
      this.aviso(`Sala "${nome}" criada: ela já está no escritório. Agora crie o primeiro agente dela.`, 'ok');
      queueMicrotask(() => this.funcao.focus());
    });
  }

  private async criarAgente(): Promise<void> {
    const room = this.salaSelect.value;
    const funcao = this.funcao.value.trim();
    const descricao = this.descricao.value.trim();
    const falta = faltaNoAgente(room, funcao, descricao, this.salaCheia(room));
    if (falta) return this.aviso(falta, 'erro');
    await this.rodar(async () => {
      this.aviso('Criando o agente…');
      const visual = this.visual.value === 'f' || this.visual.value === 'm' ? this.visual.value : undefined;
      const r = await this.ctx.store.criarNaEquipe('agente', { room, funcao, descricao, ...(visual ? { visual } : {}) });
      if (this.semChave(r.status)) return;
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível criar o agente.', 'erro');
      this.funcao.value = '';
      this.descricao.value = '';
      this.visual.value = '';
      this.aviso(
        r.aviso
          ? `${funcao} criado e já está na sala. A função completa dele será escrita quando a demanda em andamento terminar (está na fila, em Demandas).`
          : `${funcao} criado e já está na sala. Ele está escrevendo a própria função agora: acompanhe em Demandas. Pode criar o próximo.`,
        'ok',
      );
    });
  }
}
