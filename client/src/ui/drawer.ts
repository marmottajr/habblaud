// Gaveta de detalhes (direita): agente ou sala selecionados. Agente do Codex: selo "Codex", textos dele (onde
// responder, o terminal, a aprovação no lugar do modo de permissão, sem custo) e a dica dos hooks do Codex.
import { aiLabel } from '../../../shared/ia';
import type { Activity, AgentInfo, FeedItem, RoomInfo, ShellJob, TaskItem } from '../../../shared/types';
import { createAvatarPlaceholder, updateAvatar } from './avatar';
import { CharacterEditor } from './character-editor';
import { MessageComposer } from './composer';
import type { UiComponent, UiContext } from './context';
import { lotacao, salasParaLigar, textoDaLotacao } from './criar';
import { AgentAiPicker } from './ia';
import { MesasPicker } from './mesas';
import { quandoTexto } from './rotinas';
import { copyText, h, iconButton, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatInt,
  formatTokens,
  formatUSD,
  permissionLabel,
  plural,
  prettyModel,
  relativeTime,
  shortPath,
} from './format';
import { ICONS } from './icons';
import {
  accountsOf,
  activityFallback,
  aggregateTasks,
  mergeHistory,
  roleLabel,
  shellBoxText,
  shellDoneKind,
  shellKindLabel,
  shellStage,
  shellWaitIn,
  sortByUrgency,
  statusLabel,
  taskProgress,
  visibleShells,
} from './model';
import { isLocalHostname, PermissionCard } from './permission';
import { canRenameRoom } from './roomrename';
import { accentOf, canStyleRoom, LAYOUT_ICONS, layoutOf, RoomStylePicker } from './roomstyle';
import { accountChipLabel, accountProvider, CODEX_LIVE_HINT, codexApprovalLabel, providerOf } from './provider';
import { createAgentRow, updateAgentRow } from './rows';
import { SocialSection } from './social';
import { TERMINAL_UNAVAILABLE_HINT, type TerminalControl } from './terminal';
import { Movable } from './movable';
import { richText } from './usage';
import {
  createAccountChip,
  createProgress,
  createProviderTag,
  createStatusDot,
  updateAccountChip,
  updateProgress,
  updateProviderTag,
  updateStatusDot,
} from './widgets';

/** Itens da linha do tempo mostrados de início; "Mostrar mais" acrescenta outro tanto. */
const TIMELINE_STEP = 15;
const ROOM_FEED_LIMIT = 15;

// ---------------------------------------------------------------- peças

function section(title: string, ...children: (Node | null)[]): { el: HTMLElement; title: HTMLElement; extra: HTMLElement } {
  const t = h('h3', { class: 'ui-sec__title', text: title });
  const extra = h('span', { class: 'ui-sec__extra' });
  const el = h('section', { class: 'ui-sec' }, h('div', { class: 'ui-sec__head' }, t, extra), ...children.filter((c): c is Node => !!c));
  return { el, title: t, extra };
}

function copyButton(getText: () => string, label: string): HTMLButtonElement {
  const b = iconButton(ICONS.copy, label, async () => {
    const ok = await copyText(getText());
    b.classList.toggle('is-done', ok);
    b.innerHTML = ok ? ICONS.check : ICONS.copy;
    setTitle(b, ok ? 'Copiado!' : 'Não foi possível copiar');
    setTimeout(() => {
      b.classList.remove('is-done');
      b.innerHTML = ICONS.copy;
      setTitle(b, label);
    }, 1400);
  }, 'ui-icon-btn--sm');
  return b;
}

const TASK_MARK: Record<TaskItem['status'], string> = { completed: '✓', in_progress: '◐', pending: '○' };
const TASK_STATE: Record<TaskItem['status'], string> = { completed: 'concluída', in_progress: 'em andamento', pending: 'pendente' };

function createTaskItem(): HTMLElement {
  return h('li', { class: 'ui-task' }, h('span', { class: 'ui-task__mark', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'ui-task__text' }), h('span', { class: 'ui-task__owner' }));
}

function updateTaskItem(li: HTMLElement, t: TaskItem, owner?: string): void {
  const [mark, text, ownerEl] = li.children as unknown as HTMLElement[];
  setText(mark, TASK_MARK[t.status]);
  setText(text, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.title);
  setText(ownerEl, owner ?? '');
  setHidden(ownerEl, !owner);
  setVariant(li, 'is-', t.status);
  setAttr(li, 'aria-label', `${t.title}: ${TASK_STATE[t.status]}`);
}

function createTimelineItem(): HTMLElement {
  return h(
    'li',
    { class: 'ui-tl' },
    h('span', { class: 'ui-tl__icon', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'ui-tl__text' }),
    h('time', { class: 'ui-tl__time' }),
  );
}

function updateTimelineItem(li: HTMLElement, a: Activity, now: number, who?: string): void {
  const [icon, text, time] = li.children as unknown as HTMLElement[];
  setText(icon, a.icon);
  setText(text, who ? `${who}: ${a.text}` : a.text);
  setText(time, relativeTime(a.at, now));
  setAttr(time, 'datetime', new Date(a.at).toISOString());
  setTitle(li, `${formatClock(a.at)} · ${a.text}${a.detail ? `\n${a.detail}` : ''}`);
  li.classList.toggle('is-error', !!a.error);
  const done = shellDoneKind(a);
  li.classList.toggle('is-shell-ok', done === 'ok');
  li.classList.toggle('is-shell-fail', done === 'fail');
}

// ---------------------------------------------------------------- shells rodando

interface ShellRefs {
  icon: HTMLElement;
  label: HTMLElement;
  time: HTMLElement;
  badge: HTMLElement;
  since: HTMLElement;
  details: HTMLDetailsElement;
  command: HTMLElement;
}

const shellRefs = new WeakMap<HTMLElement, ShellRefs>();

const SHELL_KIND_VARIANT = (j: ShellJob): string => (j.kind === 'monitor' ? 'monitor' : j.background ? 'bg' : 'fg');

function createShellItem(): HTMLElement {
  const icon = h('span', { class: 'ui-shell__icon', attrs: { 'aria-hidden': 'true' } });
  const label = h('span', { class: 'ui-shell__label' });
  const time = h('time', { class: 'ui-shell__time' });
  const badge = h('span', { class: 'ui-shell__badge' });
  const since = h('span', { class: 'ui-shell__since' });
  const command = h('pre', { class: 'ui-mono' });
  const details = h(
    'details',
    { class: 'ui-shell__cmd' },
    h('summary', { text: 'Comando' }),
    h('div', { class: 'ui-shell__cmd-body' }, command, copyButton(() => command.textContent ?? '', 'Copiar comando')),
  );
  const li = h('li', { class: 'ui-shell' }, h('div', { class: 'ui-shell__head' }, icon, label, time), h('div', { class: 'ui-shell__meta' }, badge, since), details);
  shellRefs.set(li, { icon, label, time, badge, since, details, command });
  return li;
}

function updateShellItem(li: HTMLElement, j: ShellJob, now: number): void {
  const r = shellRefs.get(li)!;
  setText(r.icon, j.kind === 'monitor' ? '📡' : '💻');
  setText(r.label, j.label);
  setTitle(r.label, j.label);
  const elapsed = Math.max(0, now - j.startedAt);
  setText(r.time, formatElapsed(elapsed));
  setAttr(r.time, 'datetime', new Date(j.startedAt).toISOString());
  setTitle(r.time, `Rodando há ${formatDuration(elapsed)} (desde ${formatClock(j.startedAt)})`);
  setText(r.badge, shellKindLabel(j));
  setVariant(r.badge, 'ui-shell__badge--', SHELL_KIND_VARIANT(j));
  setText(r.since, `desde ${formatClock(j.startedAt, false)}`);
  setTitle(r.since, `Iniciado em ${formatDateTime(j.startedAt)} · id ${j.id}`);
  setHidden(r.details, !j.command);
  setText(r.command, j.command ?? '');
  setAttr(li, 'aria-label', `${j.label}, ${shellKindLabel(j)}, rodando há ${formatDuration(elapsed)}`);
}


// ---------------------------------------------------------------- visão do agente

class AgentView {
  readonly el: HTMLElement;
  private id = '';
  private last: AgentInfo | null = null;
  private history: Activity[] = [];
  private historyReq = 0;

  private avatar: HTMLElement;
  private name: HTMLElement;
  private role: HTMLElement;
  private title: HTMLElement;
  private accChip: HTMLElement;
  private accName: HTMLElement;
  private accProv: HTMLElement;
  private accEmail: HTMLElement;
  /** Dica dos hooks do Codex (ao vivo e aprovar pelo escritório), na gaveta de um agente do Codex. */
  private codexHint: HTMLElement;
  private roomBtn: HTMLButtonElement;
  private roomName: HTMLElement;
  private gone: HTMLElement;
  private dot: HTMLElement;
  private statusText: HTMLElement;
  private statusSince: HTMLElement;
  private followBtn: HTMLButtonElement;
  private termBtn: HTMLButtonElement;
  private termLabel: HTMLElement;
  private alert: HTMLElement;
  private alertText: HTMLElement;
  /**
   * Perguntas e opções do AskUserQuestion pendente, só para leitura: com o pedido no escritório (hook de
   * permissão), quem aparece é o cartão de resposta, no lugar do alerta.
   */
  private alertQuestions: HTMLElement;
  private alertQuestionsKey = '';
  /** Dica de como responder as perguntas por aqui (o plugin de permissões). */
  private alertAnswerHint: HTMLElement;
  /** Pedido de permissão (ou pergunta) para responder por aqui (substitui o alerta genérico enquanto existe). */
  private perm: PermissionCard;
  private shellBox: HTMLElement;
  private shellText: HTMLElement;
  private shellMood: HTMLElement;
  private shellNext: HTMLElement;
  private shellsSec: ReturnType<typeof section>;
  private shells: KeyedList<ShellJob>;
  private actIcon: HTMLElement;
  private actText: HTMLElement;
  private actTime: HTMLElement;
  private actDetails: HTMLDetailsElement;
  private actDetail: HTMLElement;
  /** Mandar mensagem ao agente principal pelo Habblaud (plugin habblaud-mensagens). */
  private composer: MessageComposer;
  private msgSec: ReturnType<typeof section>;
  private tasksSec: ReturnType<typeof section>;
  private jobRow: HTMLElement;
  private jobBtn: HTMLButtonElement;
  private staffDel: HTMLButtonElement;
  private jobInput: HTMLInputElement;
  private jobList: HTMLDataListElement;
  private jobEditing = false;
  private jobFor: string | null = null;
  private ia!: AgentAiPicker;
  private iaSec!: ReturnType<typeof section>;
  private askSec: ReturnType<typeof section>;
  private askText: HTMLTextAreaElement;
  private askKey: HTMLInputElement;
  private askKeyRow: HTMLElement;
  private askBtn: HTMLButtonElement;
  private askMsg: HTMLElement;
  private askBusy = false;
  private askFor: string | null = null;
  private askAlt: HTMLButtonElement;
  private askLive = false;
  private rotRow: HTMLElement;
  private rotOn: HTMLInputElement;
  private rotOpts: HTMLElement;
  private rotDias: HTMLButtonElement[] = [];
  private rotHora: HTMLInputElement;
  private rotList: HTMLElement;
  private rotSec: ReturnType<typeof section>;
  private rotFor: string | null = null;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<TaskItem>;
  private teamSec: ReturnType<typeof section>;
  private team: KeyedList<AgentInfo>;
  private teamEmpty: HTMLElement;
  private timeline: KeyedList<Activity>;
  private timelineSec: ReturnType<typeof section>;
  private timelineMore: HTMLButtonElement;
  private timelineLess: HTMLButtonElement;
  /** Quantos itens da linha do tempo aparecem agora. */
  private timelineShown = TIMELINE_STEP;
  private stats: KvList<StatKey>;
  private social: SocialSection;
  readonly character: CharacterEditor;
  private sessionValue: HTMLElement;
  private linesPlus: HTMLElement;
  private linesMinus: HTMLElement;

  constructor(
    private ctx: UiContext,
    private terminal: TerminalControl,
  ) {
    this.avatar = createAvatarPlaceholder('lg');
    this.name = h('h2', { class: 'ui-hero__name' });
    this.role = h('span', { class: 'ui-role' });
    // Função dada pelo usuário: um botão que vira campo de texto (Enter grava, Esc desiste, vazio tira).
    this.jobBtn = h('button', { class: 'ui-job__btn', type: 'button', on: { click: () => this.editJob() } });
    // Agente fixo parado: apagar pela tela (ui/criar.ts confirma e manda o pedido).
    this.staffDel = h('button', { class: 'ui-btn ui-rot__mini ui-job__del', type: 'button', hidden: true, text: 'Apagar agente', title: 'Tira este agente fixo da sala. O arquivo e o caderno dele vão para a lixeira da equipe', on: { click: () => this.apagarFixo() } });
    this.jobList = h('datalist', { attrs: { id: 'ui-job-list' } });
    this.jobInput = h('input', {
      class: 'ui-job__input',
      type: 'text',
      hidden: true,
      attrs: { maxlength: 40, list: 'ui-job-list', placeholder: 'Ex.: Estrategista', 'aria-label': 'Função do agente', autocomplete: 'off' },
      on: {
        keydown: (ev) => {
          if (ev.key === 'Enter') void this.saveJob();
          else if (ev.key === 'Escape') this.closeJob();
          else return;
          ev.preventDefault();
          ev.stopPropagation();
        },
        blur: () => void this.saveJob(),
      },
    });
    this.jobRow = h('div', { class: 'ui-hero__where ui-job' }, h('span', { class: 'ui-muted', text: 'Função' }), this.jobBtn, this.jobInput, this.jobList, this.staffDel);
    this.title = h('p', { class: 'ui-hero__title' });
    this.accChip = createAccountChip('md');
    this.accName = h('span', { class: 'ui-hero__acc-name' });
    this.accProv = createProviderTag('ui-prov--xs');
    this.accEmail = h('span', { class: 'ui-hero__acc-email' });
    this.roomName = h('span');
    this.roomBtn = h('button', { class: 'ui-room-link', type: 'button', on: { click: () => this.last && ctx.select({ type: 'room', id: this.last.roomId }, { focus: true }) } }, this.roomName);
    this.character = new CharacterEditor(ctx);
    const heroText = h(
      'div',
      { class: 'ui-hero__text' },
      h('div', { class: 'ui-hero__line' }, this.name, this.character.button, this.role),
      h('div', { class: 'ui-hero__acc' }, this.accChip, this.accName, this.accProv, this.accEmail),
      h('div', { class: 'ui-hero__where' }, h('span', { class: 'ui-muted', text: 'Sala' }), this.roomBtn),
      this.jobRow,
    );
    this.gone = h('p', { class: 'ui-gone', text: 'Este agente já saiu do escritório.', hidden: true });

    this.dot = createStatusDot();
    this.statusText = h('span', { class: 'ui-status__text' });
    this.statusSince = h('span', { class: 'ui-status__since' });
    this.followBtn = h('button', { class: 'ui-btn', type: 'button', attrs: { 'aria-pressed': 'false' }, title: 'Câmera acompanha o agente (F)', on: { click: () => this.toggleFollow() } });
    this.followBtn.innerHTML = ICONS.follow;
    this.followBtn.append(h('span', { text: 'Seguir' }));
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: 'Levar a câmera até o agente', on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: 'Centralizar' }));
    const statusRow = h(
      'div',
      { class: 'ui-status' },
      h('span', { class: 'ui-status__label' }, this.dot, this.statusText, this.statusSince),
      h('span', { class: 'ui-status__actions' }, this.followBtn, centerBtn),
    );

    // Nova demanda (só agentes fixos da equipe): o texto vai para a fila do servidor e o serviço do computador
    // (`equipe servir`) abre o terminal do agente. Ctrl/Cmd+Enter envia.
    this.askText = h('textarea', {
      class: 'ui-ask__text',
      attrs: { rows: 4, maxlength: 8000, placeholder: 'Escreva a demanda para este agente…', 'aria-label': 'Demanda para o agente' },
      on: {
        keydown: (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault();
            void this.sendAsk();
          }
        },
      },
    });
    this.askKey = h('input', {
      class: 'ui-ask__key',
      type: 'password',
      attrs: { placeholder: 'Chave do escritório', 'aria-label': 'Chave do escritório', autocomplete: 'off', spellcheck: 'false' },
      on: { keydown: (ev) => ev.stopPropagation() },
    });
    this.askKeyRow = h(
      'div',
      { class: 'ui-ask__keyrow', hidden: true },
      this.askKey,
      h('p', { class: 'ui-ask__dica', text: 'Uma vez por navegador. Para ver a chave, rode no terminal: equipe chave' }),
    );
    this.askBtn = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Enviar demanda', title: 'Abre um terminal novo com este agente e a demanda (Ctrl/Cmd+Enter)', on: { click: () => void this.sendAsk() } });
    this.askMsg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });
    // Com o agente trabalhando, o botão principal manda um recado para a sessão dele; este abre outra demanda.
    this.askAlt = h('button', { class: 'ui-btn', type: 'button', text: 'Nova demanda', hidden: true, title: 'Abre outro terminal com este agente e este texto como demanda nova', on: { click: () => void this.sendAsk('demanda') } });
    // Rotina: a mesma demanda, repetida nos dias e na hora marcados.
    this.rotOn = h('input', { type: 'checkbox', attrs: { id: 'ui-rot-on' }, on: { change: () => this.syncRotina() } });
    this.rotHora = h('input', { class: 'ui-rot__hora', type: 'time', attrs: { value: '09:00', 'aria-label': 'Hora da rotina' }, on: { keydown: (ev) => ev.stopPropagation() } });
    const nomes = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    const cheios = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    this.rotDias = nomes.map((n, i) => {
      const b = h('button', { class: 'ui-rot__dia', type: 'button', text: n, title: cheios[i], attrs: { 'aria-pressed': i >= 1 && i <= 5 ? 'true' : 'false', 'aria-label': cheios[i] } });
      b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
      return b;
    });
    this.rotOpts = h('span', { class: 'ui-rot__opts', hidden: true }, h('span', { class: 'ui-rot__dias' }, ...this.rotDias), this.rotHora);
    this.rotRow = h('div', { class: 'ui-rot' }, h('label', { class: 'ui-rot__label', attrs: { for: 'ui-rot-on' } }, this.rotOn, h('span', { text: 'Repetir (rotina)' })), this.rotOpts);
    this.askSec = section('Nova demanda', this.askText, this.rotRow, this.askKeyRow, h('div', { class: 'ui-ask__row' }, this.askBtn, this.askAlt, this.askMsg));
    // Agente fixo: a IA e o nível dele, o mínimo e a permissão de escolher a IA do colega (ui/ia.ts).
    this.ia = new AgentAiPicker((mudanca) => {
      const a = this.last;
      if (a?.staff) this.ctx.definirIA?.(a.roomId, a.staff, a.name, mudanca);
    });
    this.iaSec = section('IA do agente', this.ia.el);
    this.rotList = h('div', { class: 'ui-rot__list' });
    this.rotSec = section('Rotinas', this.rotList);

    // Terminal: a conversa da sessão como o Claude Code mostra, ao vivo (só com acesso local).
    this.termLabel = h('span', { class: 'ui-term-cta__label', text: 'Abrir terminal' });
    const termIcon = h('span', { class: 'ui-term-cta__icon', attrs: { 'aria-hidden': 'true' } });
    termIcon.innerHTML = ICONS.terminal;
    this.termBtn = h(
      'button',
      { class: 'ui-btn ui-term-cta', type: 'button', attrs: { 'aria-pressed': 'false' }, on: { click: () => this.toggleTerminal() } },
      termIcon,
      this.termLabel,
      h('kbd', { class: 'ui-kbd', text: 'T', attrs: { 'aria-hidden': 'true' } }),
    );

    this.alertText = h('p', { class: 'ui-alert__text' });
    this.alertQuestions = h('div', { class: 'ui-ask', hidden: true });
    this.alertAnswerHint = h('p', { class: 'ui-ask__answer-hint', hidden: true, text: 'Com o plugin habblaud-permissoes (npm run mod:install), dá para responder as perguntas por aqui.' });
    const alertIcon = h('span', { class: 'ui-alert__icon', attrs: { 'aria-hidden': 'true' } });
    alertIcon.innerHTML = ICONS.hand;
    this.alert = h(
      'div',
      { class: 'ui-alert', role: 'alert', hidden: true },
      alertIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: 'Precisa de você' }), this.alertText, this.alertQuestions, this.alertAnswerHint),
    );

    // Esperando o shell: caixa de status (com a fase da espera no escritório) e a lista de comandos rodando.
    this.shellText = h('p', { class: 'ui-alert__text' });
    this.shellMood = h('span', { class: 'ui-shell-mood__text' });
    this.shellNext = h('span', { class: 'ui-shell-mood__next' });
    const shellIcon = h('span', { class: 'ui-alert__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
    shellIcon.innerHTML = ICONS.hourglass;
    this.shellBox = h(
      'div',
      { class: 'ui-alert ui-alert--shell', hidden: true },
      shellIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: 'Esperando o shell' }), this.shellText, h('p', { class: 'ui-shell-mood' }, this.shellMood, this.shellNext)),
    );
    const shellList = h('ul', { class: 'ui-shells' });
    this.shellsSec = section('Shells rodando', shellList);
    this.shells = new KeyedList<ShellJob>(shellList, { key: (j) => j.id, create: createShellItem, update: (li, j) => updateShellItem(li, j, ctx.now()) });

    this.actIcon = h('span', { class: 'ui-now__icon', attrs: { 'aria-hidden': 'true' } });
    this.actText = h('span', { class: 'ui-now__text' });
    this.actTime = h('span', { class: 'ui-now__time' });
    this.actDetail = h('pre', { class: 'ui-mono' });
    this.actDetails = h('details', { class: 'ui-now__details' }, h('summary', { text: 'Detalhes' }), this.actDetail);
    const nowSec = section('Agora', h('div', { class: 'ui-now' }, this.actIcon, h('div', { class: 'ui-now__body' }, this.actText, this.actTime)), this.actDetails);
    this.composer = new MessageComposer(ctx, 'drawer');
    this.msgSec = section('Mandar mensagem', this.composer.el);
    this.social = new SocialSection(ctx);
    this.perm = new PermissionCard(ctx);

    this.tasksBar = createProgress('Progresso das tarefas');
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section('Tarefas', this.tasksBar, tasksList);
    this.tasks = new KeyedList<TaskItem>(tasksList, { key: (t) => t.id, create: createTaskItem, update: (li, t) => updateTaskItem(li, t) });

    const teamList = h('div', { class: 'ui-team' });
    this.teamEmpty = h('p', { class: 'ui-muted ui-small', text: 'Nenhum subagente no momento.' });
    this.teamSec = section('Subagentes', teamList, this.teamEmpty);
    this.team = new KeyedList<AgentInfo>(teamList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    const tl = h('ol', { class: 'ui-timeline' });
    this.timelineMore = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', on: { click: () => this.showTimeline(this.timelineShown + TIMELINE_STEP) } });
    this.timelineLess = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: 'Mostrar menos', on: { click: () => this.showTimeline(TIMELINE_STEP) } });
    this.timelineSec = section('Linha do tempo', tl, h('div', { class: 'ui-timeline__more' }, this.timelineMore, this.timelineLess));
    this.timeline = new KeyedList<Activity>(tl, { key: (a) => a.id, create: createTimelineItem, update: (li, a) => updateTimelineItem(li, a, ctx.now()) });

    this.sessionValue = h('span', { class: 'ui-mono-inline' });
    this.linesPlus = h('span', { class: 'ui-plus' });
    this.linesMinus = h('span', { class: 'ui-minus' });
    this.stats = new KvList<StatKey>([
      ['tools', 'Chamadas de ferramenta'],
      ['tokensIn', 'Tokens de entrada'],
      ['tokensOut', 'Tokens de saída'],
      ['cost', 'Custo estimado'],
      ['lines', 'Linhas', h('span', { class: 'ui-lines' }, this.linesPlus, this.linesMinus)],
      ['subs', 'Subagentes disparados'],
      ['model', 'Modelo'],
      ['branch', 'Branch'],
      ['perm', 'Permissões'],
      ['session', 'Sessão', h('span', { class: 'ui-copy-row' }, this.sessionValue, copyButton(() => this.last?.sessionId ?? '', 'Copiar id da sessão'))],
      ['start', 'Início'],
      ['duration', 'Duração'],
      ['bg', 'Execução'],
    ]);
    const statsSec = section('Estatísticas', this.stats.el);
    this.codexHint = h('p', { class: 'ui-codex-hint', hidden: true }, ...richText(CODEX_LIVE_HINT));

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-agent-view' },
      h('div', { class: 'ui-hero' }, this.avatar, heroText),
      this.character.el,
      this.title,
      this.gone,
      statusRow,
      this.termBtn,
      this.askSec.el,
      this.iaSec.el,
      this.rotSec.el,
      this.alert,
      this.perm.el,
      this.shellBox,
      this.shellsSec.el,
      nowSec.el,
      this.msgSec.el,
      this.social.el,
      this.tasksSec.el,
      this.teamSec.el,
      this.timelineSec.el,
      statsSec.el,
      this.codexHint,
    );
  }

  get agentId(): string {
    return this.id;
  }

  open(id: string): void {
    if (this.id === id) return;
    this.character.open(id);
    this.id = id;
    this.last = null;
    this.history = [];
    this.timelineShown = TIMELINE_STEP;
    this.timeline.clear();
    this.tasks.clear();
    this.team.clear();
    this.shells.clear();
    this.actDetails.open = false;
    const req = ++this.historyReq;
    this.ctx.store
      .agentHistory(id)
      .then((hist) => {
        if (req !== this.historyReq) return;
        this.history = mergeHistory(hist, this.history);
        this.ctx.invalidate();
      })
      .catch(() => {
        // Sem histórico longo: a linha do tempo usa as atividades recentes do snapshot.
      });
  }

  /** Abre (ou fecha) o terminal deste agente; desligado sem acesso local ou depois que ele saiu. */
  toggleTerminal(): void {
    if (!this.id || this.termBtn.getAttribute('aria-disabled') === 'true') return;
    // Agente fixo parado: abre a conversa do último trabalho dele (o terminal somente leitura do Histórico).
    const a = this.ctx.agent(this.id);
    if (a?.parked && a.lastSessionId) {
      return this.terminal.openSession({ account: a.account, sessionId: a.lastSessionId, project: a.roomId, projectDir: '', title: a.title, lastAt: a.lastEndedAt ?? Date.now(), size: 0, open: false }, this.termBtn);
    }
    this.terminal.toggle(this.id, this.termBtn);
  }

  private showTimeline(n: number): void {
    this.timelineShown = Math.max(TIMELINE_STEP, n);
    this.ctx.invalidate();
  }

  toggleFollow(): void {
    const follow = !this.ctx.world.getOptions().followSelected;
    this.ctx.world.setOptions({ followSelected: follow });
    // Foca de novo com a opção nova: ligar começa a seguir; desligar mantém o agente no centro, parado.
    if (this.id) this.ctx.focusSelection();
    this.ctx.invalidate();
  }

  render(): void {
    const live = this.ctx.agent(this.id);
    // Agente fixo: o personagem parado e a sessão da demanda são entradas diferentes do escritório. Quando um
    // dá lugar ao outro (pegou a demanda, ou terminou), a gaveta acompanha o mesmo agente em vez de ficar no
    // que saiu.
    const antes = live ?? this.last;
    if (antes?.staff && (!live || live.status === 'offline')) {
      const outro = (this.ctx.store.snapshot?.agents ?? []).find((x) => x.id !== antes.id && x.staff === antes.staff && x.roomId === antes.roomId && x.status !== 'offline');
      if (outro) {
        this.ctx.select({ type: 'agent', id: outro.id });
        return;
      }
    }
    if (live) this.last = live;
    const a = this.last;
    if (!a) return;
    const now = this.ctx.now();
    const account = this.ctx.account(a.account);
    const room = this.ctx.store.room(a.roomId);
    const provider = providerOf(a);
    const codex = provider === 'codex';

    updateAvatar(this.avatar, a, 'lg');
    setStyleVar(this.avatar, '--acc', account?.color ?? '#8b98b3');
    setText(this.name, a.name);
    this.character.render(a, !!live);
    setText(this.role, roleLabel(a));
    setVariant(this.role, 'ui-role--', a.kind === 'main' && a.job ? 'job' : a.kind);
    // Função: só agentes principais de verdade, ao vivo (o servidor recusa os do modo demonstração).
    setHidden(this.jobRow, a.kind !== 'main' || !live || this.ctx.store.replaying);
    // Agente fixo: a função é o arquivo dele na equipe. O botão abre o editor da função (ui/criar.ts).
    // O dono do escritório vem com o Habblaud: a função dele não se edita nem ele se apaga pela tela.
    const doEscritorio = !!a.staff && !!this.ctx.store.room(a.roomId)?.office;
    this.jobBtn.disabled = !!a.staff && (!this.ctx.editarFuncao || doEscritorio);
    if (a.staff && this.jobEditing) this.closeJob();
    setHidden(this.staffDel, !a.staff || !a.parked || doEscritorio || !this.ctx.apagarAgente || this.ctx.store.replaying);
    if (!this.jobEditing) {
      setText(this.jobBtn, a.job ?? 'Dar função');
      setVariant(this.jobBtn, 'ui-job__btn--', a.staff ? 'fixed' : a.job ? 'set' : 'empty');
      setTitle(
        this.jobBtn,
        a.staff
          ? `Agente fixo da equipe (${a.staff})${a.parked ? ': parado, esperando demanda' : ''}. Clique para ver e editar a função dele`
          : a.job
            ? 'Editar a função deste agente'
            : 'Dar uma função a este agente',
      );
    }
    setText(this.title, a.title ?? '');
    setHidden(this.title, !a.title);
    setTitle(this.title, a.title ?? '');
    updateAccountChip(this.accChip, account, a.account, a.provider);
    setText(this.accName, account?.name ?? a.account);
    updateProviderTag(this.accProv, provider, account?.name ?? '');
    // E-mail (Claude Code) ou, no Codex (sem e-mail), o plano.
    const accSub = account?.email ?? (codex && account?.plan ? `plano ${account.plan}` : '');
    setText(this.accEmail, accSub);
    setHidden(this.accEmail, !accSub);
    setText(this.roomName, room?.name ?? a.roomId);
    setTitle(this.roomBtn, room ? `${room.path}\nClique para ver a sala` : '');
    setHidden(this.gone, !!live);
    this.el.classList.toggle('is-gone', !live);

    // Status (quem está parado num comando longo aparece como "Esperando o shell", como no escritório).
    const wait = live ? shellWaitIn(a, this.ctx.store.snapshot?.agents ?? [], now) : null;
    const status = wait ? 'shell' : a.status;
    updateStatusDot(this.dot, status);
    setText(this.statusText, statusLabel(status));
    // Parado num comando longo: o "desde" é o início do comando (o status do servidor continua 'working').
    const since = wait?.foreground ? wait.since : a.statusSince;
    // Agente ocioso: só "Ocioso", sem o "há X"; nos outros estados o tempo importa.
    const ocioso = status === 'idle';
    setText(this.statusSince, ocioso ? '' : relativeTime(since, now));
    setTitle(this.statusSince, ocioso ? '' : `Desde ${formatClock(since)}`);
    const following = this.ctx.world.getOptions().followSelected;
    setAttr(this.followBtn, 'aria-pressed', String(following));
    this.followBtn.classList.toggle('is-on', following);
    this.renderTerminalButton(!!live, !!a.parked, !!a.lastSessionId);
    // Demanda pela tela: só agente fixo, ao vivo. Trocar de agente limpa o aviso (o texto digitado fica).
    setHidden(this.askSec.el, !a.staff || !live || this.ctx.store.replaying);
    const mostrarIA = !!a.staff && a.kind === 'main' && !!live && !this.ctx.store.replaying && !!this.ctx.definirIA && !this.ctx.store.snapshot?.meta.demo;
    setHidden(this.iaSec.el, !mostrarIA);
    if (mostrarIA) {
      this.ia.render(`${a.roomId}\n${a.staff}`, a.ai);
      setText(this.iaSec.extra, aiLabel(a.ai) || 'automática');
    }
    // Parado: o texto vira demanda (ou rotina). Trabalhando: vira recado para a sessão dele, lido no meio do trabalho.
    this.askLive = !!a.staff && !a.parked && a.status !== 'offline';
    setText(this.askSec.title, this.askLive ? `Falar com ${a.name}` : 'Nova demanda');
    this.askText.placeholder = this.askLive ? `Recado ou pergunta para ${a.name}: ele lê no meio do trabalho…` : 'Escreva a demanda para este agente…';
    setHidden(this.askAlt, !this.askLive);
    setHidden(this.rotRow, this.askLive);
    this.syncRotina();
    setHidden(this.rotSec.el, !a.staff || !live || this.ctx.store.replaying || !this.rotList.childElementCount);
    const rotKey = a.staff ? `${a.roomId}:${a.staff}` : '';
    if (rotKey && this.rotFor !== rotKey) {
      this.rotFor = rotKey;
      this.rotList.replaceChildren();
      void this.loadRotinas();
    }
    // A chave é o agente fixo, não a entrada: o aviso continua quando o parado dá lugar à sessão da demanda.
    const askKey = a.staff ? `${a.roomId}:${a.staff}` : a.id;
    if (this.askFor !== askKey) {
      this.askFor = askKey;
      if (!this.askBusy) this.setAskMsg('');
      setHidden(this.askKeyRow, !!this.ctx.store.equipeKey);
    }

    // Alerta.
    const waiting = a.status === 'waiting' && !!live;
    this.perm.render(live);
    setHidden(this.alert, !waiting || this.perm.visible);
    if (waiting) {
      const accName = account?.name ?? a.account;
      // Codex: "Vá ao Codex (Conta X)"; sem repetir quando a conta já se chama "Codex".
      const where = codex ? `ao Codex${/codex/i.test(accName) ? '' : ` (${accName})`}` : `ao terminal da ${accName}`;
      setText(this.alertText, `Vá ${where} em ${room?.name ?? 'seu projeto'} para responder${a.waitingFor ? `: ${a.waitingFor}` : '.'}`);
    }
    // Perguntas do AskUserQuestion (só leitura): o Codex não pergunta pelo escritório.
    const asking = waiting && !codex && a.activity?.kind === 'ask' ? a.activity : undefined;
    this.renderQuestions(asking);
    // Sem o pedido no escritório: dá para responder por aqui com o plugin (só com a trava local, como o cartão). O Codex
    // não responde perguntas pelo escritório.
    const answerable =
      !codex && !!asking?.questions?.length && !this.perm.visible && !this.ctx.store.mock && !!this.ctx.store.snapshot?.meta.terminal && isLocalHostname(location.hostname);
    setHidden(this.alertAnswerHint, !answerable);

    // Esperando o shell.
    setHidden(this.shellBox, !wait);
    if (wait) {
      setText(this.shellText, shellBoxText(wait));
      const stage = shellStage(now - wait.since);
      setText(this.shellMood, `${stage.emoji} ${stage.text}`);
      setText(this.shellNext, stage.nextIn !== null ? `Próxima fase em ${formatDuration(Math.max(1_000, stage.nextIn))}` : '');
      setHidden(this.shellNext, stage.nextIn === null);
      setTitle(this.shellNext, 'Quanto falta para o personagem mudar o que faz enquanto espera (veja a Ajuda)');
    }
    // Sem shells próprios, mostra os que ele espera de um subagente.
    const own = live ? visibleShells(a, now) : [];
    const jobs = own.length || !wait ? own : wait.jobs;
    setHidden(this.shellsSec.el, jobs.length === 0);
    setText(this.shellsSec.extra, jobs.length > 1 ? String(jobs.length) : '');
    this.shells.sync(jobs);

    // Atividade atual.
    const act = a.activity;
    setText(this.actIcon, act?.icon ?? '·');
    setText(this.actText, act?.text ?? activityFallback(a));
    // A duração só entra quando o texto ainda não a traz ("Concluiu em 33s" já diz quanto levou).
    const showDuration = !!act?.durationMs && act.kind !== 'done' && !/\d\s?(?:ms|s|min|h)\b/.test(act.text);
    setText(this.actTime, act ? `${relativeTime(act.at, now)}${showDuration ? ` · levou ${formatDuration(act.durationMs!)}` : ''}` : '');
    this.actText.classList.toggle('is-error', !!act?.error);
    const detail = act?.detail ?? '';
    setHidden(this.actDetails, !detail);
    setText(this.actDetail, detail);

    // Mandar mensagem: só para principais presentes (com o recurso ligado e a página local; sem o plugin, a dica).
    setHidden(this.msgSec.el, this.composer.render(live, this.id) === 'off');

    // Vida social (personalidade, carteira, rodas): só de quem está no escritório.
    if (live) this.social.render(a.id, now);
    else setHidden(this.social.el, true);

    // Tarefas.
    const tp = taskProgress(a.tasks);
    setHidden(this.tasksSec.el, a.tasks.length === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(a.tasks);

    // Equipe: subagentes (principal) ou responsável (sub).
    if (a.kind === 'main') {
      const subs = sortByUrgency((this.ctx.store.snapshot?.agents ?? []).filter((s) => s.parentId === a.id));
      setText(this.teamSec.title, 'Subagentes');
      setText(this.teamSec.extra, subs.length ? String(subs.length) : '');
      setText(this.teamEmpty, a.stats.subagents ? `Nenhum ativo agora (${plural(a.stats.subagents, 'disparado', 'disparados')} nesta sessão).` : 'Nenhum subagente disparado ainda.');
      setHidden(this.teamEmpty, subs.length > 0);
      this.team.sync(subs);
    } else {
      const parent = a.parentId ? this.ctx.agent(a.parentId) : undefined;
      setText(this.teamSec.title, 'Responsável');
      setText(this.teamSec.extra, '');
      setText(this.teamEmpty, 'O agente principal já não está no escritório.');
      setHidden(this.teamEmpty, !!parent);
      this.team.sync(parent ? [parent] : []);
    }

    // Linha do tempo (mais recente primeiro).
    this.history = mergeHistory(this.history, a.recent);
    const items = this.history.slice(-this.timelineShown).reverse();
    const hiddenCount = Math.max(0, this.history.length - this.timelineShown);
    setHidden(this.timelineMore, hiddenCount === 0);
    setText(this.timelineMore, `Mostrar mais ${Math.min(TIMELINE_STEP, hiddenCount)}`);
    setHidden(this.timelineLess, this.timelineShown <= TIMELINE_STEP || this.history.length <= TIMELINE_STEP);
    this.timeline.sync(items);
    setText(this.timelineSec.extra, this.history.length ? String(this.history.length) : '');

    this.renderStats(a, now);

    // Codex: como ter o ao vivo e as aprovações por aqui (o servidor ainda não diz se os hooks dele estão ligados).
    setHidden(this.codexHint, !codex || a.kind !== 'main' || !live || this.ctx.store.replaying);
  }

  private setAskMsg(text: string, kind: 'ok' | 'erro' | 'info' = 'info'): void {
    setText(this.askMsg, text);
    setHidden(this.askMsg, !text);
    setVariant(this.askMsg, 'ui-ask__msg--', kind);
  }

  /** Texto do botão principal conforme o que ele vai fazer. */
  private syncRotina(): void {
    const rotina = !this.askLive && this.rotOn.checked;
    setHidden(this.rotOpts, !rotina);
    setText(this.askBtn, this.askLive ? 'Enviar recado' : rotina ? 'Salvar rotina' : 'Enviar demanda');
  }

  /** Lista as rotinas deste agente (precisa da chave já guardada no navegador). */
  private async loadRotinas(): Promise<void> {
    const a = this.last;
    if (!a?.staff) return;
    const chave = `${a.roomId}:${a.staff}`;
    const todas = await this.ctx.store.rotinas(a.roomId);
    if (this.rotFor !== chave) return;
    const minhas = (todas ?? []).filter((r) => r.slug === a.staff);
    this.rotList.replaceChildren(
      ...minhas.map((r) => {
        const quando = quandoTexto(r);
        const liga = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: r.ativa ? 'Ligada' : 'Desligada', title: r.ativa ? 'Clique para desligar' : 'Clique para ligar', attrs: { 'aria-pressed': String(r.ativa) } });
        liga.addEventListener('click', () => void this.ctx.store.mudarRotina(r.id, { ativa: !r.ativa }).then(() => this.loadRotinas()));
        const apaga = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: 'Apagar' });
        apaga.addEventListener('click', () => void this.ctx.store.mudarRotina(r.id, { apagar: true }).then(() => this.loadRotinas()));
        return h(
          'div',
          { class: `ui-rot__item${r.ativa ? '' : ' is-off'}` },
          h('div', { class: 'ui-rot__head' }, h('strong', { text: quando }), liga, apaga),
          h('p', { class: 'ui-rot__texto', text: r.pedido, title: r.pedido }),
          r.ultimoAviso ? h('p', { class: 'ui-rot__aviso', text: `Última vez: ${r.ultimoAviso}` }) : null,
        );
      }),
    );
    this.ctx.invalidate();
  }

  /**
   * Envia o texto: demanda nova (abre terminal), rotina (se "Repetir" estiver marcado) ou, com o agente
   * trabalhando, recado para a sessão dele. `forcar: 'demanda'` abre demanda nova mesmo com ele trabalhando.
   */
  private async sendAsk(forcar?: 'demanda'): Promise<void> {
    const a = this.last;
    const store = this.ctx.store;
    if (!a?.staff || this.askBusy) return;
    const recado = this.askLive && forcar !== 'demanda';
    const rotina = !this.askLive && this.rotOn.checked;
    const pedido = this.askText.value.trim();
    if (!pedido) return this.setAskMsg(recado ? 'Escreva o recado antes de enviar.' : 'Escreva a demanda antes de enviar.', 'erro');
    const digitada = this.askKey.value.trim();
    const chave = digitada || store.equipeKey;
    if (!chave) {
      setHidden(this.askKeyRow, false);
      this.askKey.focus();
      return this.setAskMsg('Cole a chave do escritório para enviar.', 'erro');
    }
    this.askBusy = true;
    this.askBtn.disabled = true;
    this.askAlt.disabled = true;
    this.setAskMsg('Enviando…');
    const chaveErrada = () => {
      store.equipeKey = '';
      setHidden(this.askKeyRow, false);
      this.askKey.value = '';
      this.askKey.focus();
      this.setAskMsg('A chave não confere. Cole de novo (no terminal: equipe chave).', 'erro');
    };
    const guardarChave = () => {
      if (!digitada) return;
      store.equipeKey = digitada;
      this.askKey.value = '';
      setHidden(this.askKeyRow, true);
    };
    try {
      if (rotina) {
        const dias = this.rotDias.map((b, i) => (b.getAttribute('aria-pressed') === 'true' ? i : -1)).filter((i) => i >= 0);
        if (digitada) store.equipeKey = digitada;
        const r = await store.criarRotina({ room: a.roomId, slug: a.staff, pedido, dias, hora: this.rotHora.value });
        if (r.status === 401) return chaveErrada();
        if (!r.ok) return this.setAskMsg(r.error ?? 'Não foi possível salvar a rotina.', 'erro');
        guardarChave();
        this.askText.value = '';
        this.rotOn.checked = false;
        this.syncRotina();
        this.setAskMsg('Rotina salva.', 'ok');
        return void this.loadRotinas();
      }
      if (recado) {
        const r = await store.enviarRecado(a.id, pedido, chave);
        if (r.status === 401) return chaveErrada();
        if (!r.id) return this.setAskMsg(r.error ?? 'Não foi possível enviar o recado.', 'erro');
        guardarChave();
        this.setAskMsg(`Enviando o recado para ${a.name}…`);
        for (let i = 0; i < 65; i++) {
          await new Promise((ok) => setTimeout(ok, 1_000));
          const s = await store.recadoEstado(r.id, chave);
          if (!s || s.estado === 'pendente') continue;
          if (s.estado === 'entregue') {
            this.askText.value = '';
            return this.setAskMsg(`Recado entregue. A resposta de ${a.name} aparece em "Abrir terminal".`, 'ok');
          }
          return this.setAskMsg(s.erro ?? 'O recado não foi entregue.', 'erro');
        }
        return this.setAskMsg('A sessão do agente não buscou o recado.', 'erro');
      }
      const r = await store.enviarDemanda(a.roomId, a.staff, pedido, chave);
      if (r.status === 401) {
        store.equipeKey = '';
        setHidden(this.askKeyRow, false);
        this.askKey.value = '';
        this.askKey.focus();
        return this.setAskMsg('A chave não confere. Cole de novo (no terminal: equipe chave).', 'erro');
      }
      if (!r.id) return this.setAskMsg(r.error ?? 'Não foi possível enviar a demanda.', 'erro');
      if (digitada) {
        store.equipeKey = digitada;
        this.askKey.value = '';
        setHidden(this.askKeyRow, true);
      }
      this.setAskMsg(r.servico ? `Enviada. Abrindo o terminal de ${a.name}…` : 'Enviada, mas o serviço da equipe não está respondendo. Esperando…');
      for (let i = 0; i < 70; i++) {
        await new Promise((ok) => setTimeout(ok, 1_000));
        const s = await store.demandaEstado(r.id, chave);
        if (!s || s.estado === 'pendente') continue;
        if (s.estado === 'aberta') {
          this.askText.value = '';
          return this.setAskMsg(s.aviso ? `Demanda criada. ${s.aviso}` : `Demanda aberta: ${a.name} começou a trabalhar.`, 'ok');
        }
        return this.setAskMsg(s.erro ?? 'A demanda não abriu.', 'erro');
      }
      this.setAskMsg('O serviço da equipe não buscou a demanda. No terminal: equipe servico status', 'erro');
    } finally {
      this.askBusy = false;
      this.askBtn.disabled = false;
      this.askAlt.disabled = false;
    }
  }

  /** Apagar o agente fixo parado (a confirmação e o pedido ficam em ui/criar.ts). */
  private apagarFixo(): void {
    const a = this.last;
    if (a?.staff && a.parked) this.ctx.apagarAgente?.(a.roomId, a.staff, a.job ? `${a.name} · ${a.job}` : a.name);
  }

  private editJob(): void {
    const a = this.last;
    if (!a || this.jobEditing) return;
    // Agente fixo: a função é o arquivo dele; abre o editor da função.
    if (a.staff) return void this.ctx.editarFuncao?.(a.roomId, a.staff, a.name);
    this.jobEditing = true;
    this.jobFor = a.id;
    this.jobList.replaceChildren(...(this.ctx.store.room(a.roomId)?.jobs ?? []).map((j) => h('option', { attrs: { value: j } })));
    this.jobInput.value = a.job ?? '';
    setHidden(this.jobBtn, true);
    setHidden(this.jobInput, false);
    this.jobInput.focus();
    this.jobInput.select();
  }

  private closeJob(): void {
    if (!this.jobEditing) return;
    this.jobEditing = false;
    setHidden(this.jobInput, true);
    setHidden(this.jobBtn, false);
  }

  private async saveJob(): Promise<void> {
    if (!this.jobEditing) return;
    const id = this.jobFor;
    const value = this.jobInput.value;
    this.closeJob();
    const current = id ? this.ctx.agent(id)?.job : undefined;
    if (!id || value.trim() === (current ?? '')) return;
    let ok = false;
    try {
      ok = await this.ctx.store.setJob(id, value);
    } catch {
      ok = false;
    }
    if (!ok && this.last?.id === id) {
      setText(this.jobBtn, 'Não foi possível gravar');
      setVariant(this.jobBtn, 'ui-job__btn--', 'empty');
    }
  }

  /** Lista as perguntas pendentes com as opções, só para leitura (sem o pedido no escritório, a resposta é no Claude Code). */
  private renderQuestions(act: Activity | undefined): void {
    const qs = act?.questions ?? [];
    setHidden(this.alertQuestions, qs.length === 0);
    const key = qs.length ? `${act!.id}|${qs.length}` : '';
    if (key === this.alertQuestionsKey) return;
    this.alertQuestionsKey = key;
    this.alertQuestions.replaceChildren(
      ...qs.map((q) =>
        h(
          'div',
          { class: 'ui-ask__q' },
          q.header ? h('span', { class: 'ui-ask__tag', text: q.header }) : null,
          h('p', { class: 'ui-ask__question', text: q.question }),
          q.multiSelect ? h('p', { class: 'ui-ask__hint', text: 'Pode escolher mais de uma' }) : null,
          h(
            'ol',
            { class: 'ui-ask__opts' },
            ...q.options.map((o) =>
              h('li', {}, h('strong', { text: o.label }), o.description ? h('span', { class: 'ui-ask__desc', text: o.description }) : null),
            ),
          ),
        ),
      ),
    );
  }

  private renderTerminalButton(live: boolean, parked = false, ultimo = false, provider = providerOf(this.last)): void {
    const temTerminal = !!this.ctx.store.snapshot?.meta.terminal;
    const available = temTerminal && !parked;
    const open = this.terminal.agentId === this.id;
    // Parado com um trabalho guardado: o botão abre a conversa desse último trabalho.
    const verUltimo = temTerminal && parked && ultimo;
    // aria-disabled (e não disabled): o botão continua focável e a dica do porquê aparece no hover.
    const enabled = open || (available && live) || verUltimo;
    setAttr(this.termBtn, 'aria-disabled', enabled ? null : 'true');
    this.termBtn.classList.toggle('is-disabled', !enabled);
    setAttr(this.termBtn, 'aria-pressed', String(open));
    this.termBtn.classList.toggle('is-on', open);
    setText(this.termLabel, open ? 'Fechar terminal' : verUltimo ? 'Ver o último trabalho' : 'Abrir terminal');
    setTitle(
      this.termBtn,
      open
        ? 'Fechar o terminal (T)'
        : verUltimo
          ? 'Agente parado: abre a conversa do último trabalho dele, só para leitura. A linha do tempo abaixo também é a desse trabalho.'
          : parked
            ? 'Agente fixo parado: ele abre uma sessão nova a cada demanda, e aí o terminal aparece aqui.'
          : !available
            ? this.ctx.store.replaying
              ? 'Sem terminal no timelapse: a conversa é a de agora, não a do momento reproduzido.'
              : TERMINAL_UNAVAILABLE_HINT
            : !live
              ? 'O agente já saiu do escritório.'
              : `Ver a conversa desta sessão como no ${provider === 'codex' ? 'Codex' : 'terminal do Claude Code'}, ao vivo (T)`,
    );
  }

  private renderStats(a: AgentInfo, now: number): void {
    const s = a.stats;
    const st = this.stats;
    st.set('tools', formatInt(s.toolCalls));
    st.set('tokensIn', formatTokens(s.tokensIn));
    st.set('tokensOut', formatTokens(s.tokensOut));
    st.set('cost', s.costUSD !== undefined ? formatUSD(s.costUSD) : null);
    const codex = providerOf(a) === 'codex';
    const hasLines = s.linesAdded !== undefined || s.linesRemoved !== undefined;
    st.show('lines', hasLines);
    setText(this.linesPlus, `+${formatInt(s.linesAdded ?? 0)}`);
    setText(this.linesMinus, `−${formatInt(s.linesRemoved ?? 0)}`);
    st.set('subs', a.kind === 'main' ? formatInt(s.subagents) : null);
    st.set('model', prettyModel(a.model));
    st.set('branch', a.gitBranch ?? null);
    // Codex: a política de aprovação (quando o servidor a manda) no lugar do modo de permissão do Claude Code.
    st.label('perm', codex ? 'Aprovações' : 'Permissões');
    st.set('perm', a.kind !== 'main' ? null : codex ? (a.permissionMode ? codexApprovalLabel(a.permissionMode) : null) : permissionLabel(a.permissionMode));

    setText(this.sessionValue, a.sessionId);
    setTitle(this.sessionValue, a.sessionId);
    st.set('start', formatDateTime(a.startedAt));
    st.set('duration', formatDuration(now - a.startedAt));
    st.set('bg', a.background ? 'Em segundo plano' : null);
  }
}

type StatKey = 'tools' | 'tokensIn' | 'tokensOut' | 'cost' | 'lines' | 'subs' | 'model' | 'branch' | 'perm' | 'session' | 'start' | 'duration' | 'bg';

/** Lista chave/valor de linhas fixas: cada linha é criada uma vez e só tem o texto/visibilidade atualizados. */
class KvList<K extends string> {
  readonly el: HTMLElement;
  private rows = new Map<K, { dt: HTMLElement; dd: HTMLElement }>();

  constructor(defs: readonly [K, string, Node?][]) {
    this.el = h('dl', { class: 'ui-kv ui-stats' });
    for (const [key, label, content] of defs) {
      const dt = h('dt', { text: label });
      const dd = h('dd');
      if (content) dd.append(content);
      this.rows.set(key, { dt, dd });
      this.el.append(dt, dd);
    }
  }

  /** Troca o rótulo da linha (ex.: "Aprovações" no Codex). */
  label(key: K, text: string): void {
    setText(this.rows.get(key)!.dt, text);
  }

  /** Define o texto da linha; `null` oculta a linha. */
  set(key: K, value: string | null): void {
    const r = this.rows.get(key)!;
    this.show(key, value !== null);
    if (value !== null) setText(r.dd, value);
  }

  show(key: K, visible: boolean): void {
    const r = this.rows.get(key)!;
    setHidden(r.dt, !visible);
    setHidden(r.dd, !visible);
  }
}

// ---------------------------------------------------------------- visão da sala

class RoomView {
  readonly el: HTMLElement;
  private id = '';
  private last: RoomInfo | null = null;
  private swatch: HTMLElement;
  private name: HTMLElement;
  private renameBtn: HTMLButtonElement;
  /** Sala de equipe: criar agente e excluir a sala (ui/criar.ts confirma). Aparecem ao clicar na sala. */
  private teamRow: HTMLElement;
  private novoAgenteBtn!: HTMLButtonElement;
  private lotacaoSec!: ReturnType<typeof section>;
  private lotacaoTexto!: HTMLElement;
  private limiteInput!: HTMLInputElement;
  private limiteBtn!: HTMLButtonElement;
  private limiteDica!: HTMLElement;
  private limiteDe = '';
  private mesas = new MesasPicker();
  /** Sala do dono: daqui se abre a conversa com ele. */
  private officeRow: HTMLElement;
  /** "Conversa com": as outras salas de equipe; clicar liga ou desliga (ui/criar.ts confirma). */
  private linksSec: ReturnType<typeof section>;
  private links: KeyedList<{ id: string; name: string; ligada: boolean }>;
  private linksEmpty: HTMLElement;
  /** "Aparência da sala": layout (com ícone), cor e lado das mesas (ui/roomstyle.ts). */
  private estilo = new RoomStylePicker();
  private estiloSec: ReturnType<typeof section>;
  private iconeDoLayout = '';
  private path: HTMLElement;
  private gone: HTMLElement;
  private accs: KeyedList<string>;
  private agents: KeyedList<AgentInfo>;
  private agentsSec: ReturnType<typeof section>;
  private agentsEmpty: HTMLElement;
  private tasksSec: ReturnType<typeof section>;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<{ task: TaskItem; owner: string; key: string }>;
  private feed: KeyedList<FeedItem>;
  private feedSec: ReturnType<typeof section>;

  constructor(private ctx: UiContext) {
    this.swatch = h('span', { class: 'ui-room-hero__swatch', attrs: { 'aria-hidden': 'true' } });
    this.name = h('h2', { class: 'ui-hero__name' });
    // Lápis: o mesmo campo do botão direito na sala (ui/roomrename.ts), aberto embaixo do nome.
    this.renameBtn = iconButton(
      ICONS.pencil,
      'Renomear sala',
      () => {
        const r = this.name.getBoundingClientRect();
        ctx.renameRoom?.(this.id, { x: r.left, y: r.bottom + 6 });
      },
      'ui-icon-btn--sm ui-room-hero__rename',
    );
    this.path = h('span', { class: 'ui-room-hero__path' });
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: 'Levar a câmera até a sala', on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: 'Centralizar' }));
    this.gone = h('p', { class: 'ui-gone', text: 'Esta sala foi fechada: todos os agentes saíram.', hidden: true });
    // Sala de equipe: os botões dela ficam aqui, no painel que abre ao clicar na sala.
    this.novoAgenteBtn = h('button', { class: 'ui-btn', type: 'button', text: '+ Novo agente', title: 'Criar um agente fixo nesta sala a partir de uma descrição', on: { click: () => ctx.novoAgente?.(this.id) } });
    // Configurações da sala: quantos agentes fixos ela pode ter (até o número de mesas do layout).
    this.lotacaoTexto = h('strong', { class: 'ui-room-lotacao__tem' });
    this.limiteInput = h('input', { class: 'ui-rotp__field ui-room-lotacao__num', attrs: { type: 'number', min: '1', max: '12', step: '1', inputmode: 'numeric', 'aria-label': 'Limite de agentes desta sala' }, on: { input: () => this.syncLimite(), keydown: (ev: Event) => ev.stopPropagation() } });
    this.limiteBtn = h('button', { class: 'ui-btn', type: 'button', text: 'Definir limite', on: { click: () => ctx.definirLimite?.(this.id, Number(this.limiteInput.value)) } });
    this.limiteDica = h('p', { class: 'ui-muted ui-small' });
    this.lotacaoSec = section(
      'Agentes da sala',
      h('div', { class: 'ui-room-lotacao' }, this.lotacaoTexto, h('label', { class: 'ui-room-lotacao__campo' }, h('span', { text: 'Limite' }), this.limiteInput), this.limiteBtn),
      this.limiteDica,
      this.mesas.el,
    );
    this.teamRow = h(
      'div',
      { class: 'ui-room-team', hidden: true },
      this.novoAgenteBtn,
      h('button', {
        class: 'ui-btn ui-criar__perigo',
        type: 'button',
        text: 'Excluir sala',
        title: 'Exclui esta sala do escritório, com os agentes dela. A pasta e os arquivos continuam onde estão',
        on: { click: () => ctx.removerSala?.(this.id, this.last?.name ?? '') },
      }),
    );

    this.officeRow = h(
      'div',
      { class: 'ui-room-team', hidden: true },
      h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Conversar com o dono', title: 'Peça uma mudança no escritório ou mande um recado a qualquer agente: o dono faz por você', on: { click: () => ctx.abrirEscritorio?.() } }),
    );
    const linksList = h('div', { class: 'ui-room-links' });
    this.linksEmpty = h('p', { class: 'ui-muted ui-small', text: 'Não há outra sala de equipe para ligar. Crie uma em "+ Nova sala".' });
    this.linksSec = section(
      'Conversa com',
      h('p', { class: 'ui-muted ui-small ui-room-links__dica', text: 'Clique numa sala para os agentes desta e os dela poderem passar trabalho uns para os outros. Clique de novo para desligar.' }),
      linksList,
      this.linksEmpty,
    );
    this.links = new KeyedList(linksList, {
      animate: false,
      key: (s) => s.id,
      create: (s) => {
        const b = h('button', { class: 'ui-room-link', type: 'button' }, h('span', { class: 'ui-room-link__marca', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'ui-room-link__nome' }));
        b.addEventListener('click', () => ctx.ligarSalas?.(this.id, s.id, b.getAttribute('aria-pressed') !== 'true'));
        return b;
      },
      update: (el, s) => {
        setAttr(el, 'aria-pressed', String(s.ligada));
        setText(el.lastElementChild!, s.name);
        setText(el.firstElementChild!, s.ligada ? '✓' : '+');
        setTitle(el, s.ligada ? `Esta sala conversa com "${s.name}". Clique para desligar` : `Clique para esta sala conversar com "${s.name}"`);
      },
    });

    this.estiloSec = section('Aparência da sala', this.estilo.el);

    const accsEl = h('div', { class: 'ui-acc-list' });
    this.accs = new KeyedList<string>(accsEl, {
      animate: false,
      key: (id) => id,
      create: () => h('span', { class: 'ui-acc-item' }, createAccountChip('sm'), h('span')),
      update: (el, id) => {
        const acc = ctx.account(id);
        updateAccountChip(el.firstElementChild as HTMLElement, acc, id);
        // "Conta C · dev@x.com"; no Codex, "Codex · plano Team".
        setText(el.lastElementChild!, accountChipLabel(acc, id, accountProvider(acc, id)).replace(/ \((.+)\)$/, ' · $1'));
      },
    });

    const agentsList = h('div', { class: 'ui-team' });
    this.agentsEmpty = h('p', { class: 'ui-muted ui-small', text: 'Ninguém na sala agora.' });
    this.agentsSec = section('Agentes', agentsList, this.agentsEmpty);
    this.agents = new KeyedList<AgentInfo>(agentsList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    this.tasksBar = createProgress('Progresso das tarefas da sala');
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section('Tarefas', this.tasksBar, tasksList);
    this.tasks = new KeyedList(tasksList, { key: (t) => t.key, create: createTaskItem, update: (li, t) => updateTaskItem(li, t.task, t.owner) });

    const feedList = h('ol', { class: 'ui-timeline' });
    this.feedSec = section('Atividade recente', feedList);
    this.feed = new KeyedList<FeedItem>(feedList, { key: (f) => f.id, create: createTimelineItem, update: (li, f) => updateTimelineItem(li, f.activity, ctx.now(), f.agentName) });

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-room-view' },
      h(
        'div',
        { class: 'ui-room-hero' },
        this.swatch,
        h('div', { class: 'ui-hero__text' }, h('div', { class: 'ui-room-hero__title' }, this.name, this.renameBtn), h('span', { class: 'ui-copy-row' }, this.path, copyButton(() => this.last?.path ?? '', 'Copiar caminho'))),
      ),
      this.gone,
      h('div', { class: 'ui-status' }, accsEl, h('span', { class: 'ui-status__actions' }, centerBtn)),
      this.teamRow,
      this.officeRow,
      this.lotacaoSec.el,
      this.linksSec.el,
      this.estiloSec.el,
      this.agentsSec.el,
      this.tasksSec.el,
      this.feedSec.el,
    );
  }

  /** O botão "Definir limite" só acende com um número novo, dentro do que a sala aceita. */
  private syncLimite(): void {
    const n = Number(this.limiteInput.value);
    const min = Number(this.limiteInput.min) || 1;
    const max = Number(this.limiteInput.max) || 12;
    const atual = Number(this.limiteDe.split('|')[1]);
    this.limiteBtn.disabled = !Number.isInteger(n) || n < min || n > max || n === atual;
  }

  get roomId(): string {
    return this.id;
  }

  open(id: string): void {
    if (this.id === id) return;
    this.id = id;
    this.last = null;
    this.agents.clear();
    this.links.clear();
    this.tasks.clear();
    this.feed.clear();
  }

  render(): void {
    const live = this.ctx.store.room(this.id);
    if (live) this.last = live;
    const r = this.last;
    if (!r) return;
    setText(this.name, r.name);
    setText(this.path, shortPath(r.path));
    setTitle(this.path, r.path);
    try {
      setStyleVar(this.swatch, '--room', accentOf(r));
    } catch {
      // Sem tema: cor padrão.
    }
    // O ícone do layout da sala, ao lado do nome.
    const layout = layoutOf(r);
    if (layout !== this.iconeDoLayout) {
      this.iconeDoLayout = layout;
      this.swatch.innerHTML = LAYOUT_ICONS[layout];
    }
    setHidden(this.gone, !!live);
    setHidden(this.renameBtn, !live || !canRenameRoom(this.ctx, r.id));
    const personalizar = !!live && canStyleRoom(this.ctx, r.id);
    setHidden(this.estiloSec.el, !personalizar);
    if (personalizar) this.estilo.render(r, this.ctx.store.snapshot?.meta.officeStyle, this.ctx.store.snapshot?.meta.officeColors);
    const gerir = !!live && !!r.team && !this.ctx.store.replaying;
    setHidden(this.teamRow, !gerir || !!r.office || !this.ctx.removerSala);
    setHidden(this.officeRow, !gerir || !r.office || !this.ctx.abrirEscritorio);
    // Lotação: quantos agentes fixos a sala tem e quantos pode ter; cheia, não se cria mais agente nela.
    const mostrarLotacao = gerir && !r.office && !!this.ctx.definirLimite;
    setHidden(this.lotacaoSec.el, !mostrarLotacao);
    if (gerir && !r.office) {
      const l = lotacao(r, this.ctx.store.snapshot?.agents ?? []);
      setText(this.lotacaoTexto, textoDaLotacao(l));
      this.novoAgenteBtn.disabled = l.livres === 0;
      setTitle(this.novoAgenteBtn, l.livres === 0 ? `${textoDaLotacao(l)}. Aumente o limite abaixo, ou apague um agente` : 'Criar um agente fixo nesta sala a partir de uma descrição');
      // O campo acompanha o limite em vigor; enquanto a pessoa digita outro número, ele fica como ela deixou.
      const de = `${r.id}|${l.limite}|${l.mesas}|${l.tem}`;
      if (de !== this.limiteDe) {
        this.limiteDe = de;
        this.limiteInput.value = String(l.limite);
        setAttr(this.limiteInput, 'min', String(Math.max(1, l.tem)));
        setAttr(this.limiteInput, 'max', String(l.mesas));
        setText(this.limiteDica, `O layout desta sala tem ${l.mesas} ${l.mesas === 1 ? 'mesa' : 'mesas'}: o limite vai até aí. Para mais agentes, escolha um layout com mais mesas em "Aparência da sala".`);
      }
      this.syncLimite();
      // Mesas: quem senta onde se organiza arrastando o agente no escritório (ui/mesas.ts); aqui, a dica e o desfazer.
      setHidden(this.mesas.el, !personalizar || !this.ctx.world.roomDesks);
      if (personalizar && this.ctx.world.roomDesks) this.mesas.render(r, l.tem > 0);
    }
    const outras = gerir && this.ctx.ligarSalas ? salasParaLigar(this.ctx.store.snapshot?.rooms ?? [], r.id) : [];
    setHidden(this.linksSec.el, !gerir || !!r.office || !this.ctx.ligarSalas);
    setHidden(this.linksEmpty, outras.length > 0);
    setText(this.linksSec.extra, outras.some((s) => s.ligada) ? String(outras.filter((s) => s.ligada).length) : '');
    this.links.sync(outras);

    const snap = this.ctx.store.snapshot;
    const agents = (snap?.agents ?? []).filter((a) => a.roomId === r.id);
    this.accs.sync(accountsOf(agents, snap?.accounts ?? []));
    const ordered = sortByUrgency(agents);
    setText(this.agentsSec.extra, agents.length ? String(agents.length) : '');
    setHidden(this.agentsEmpty, agents.length > 0);
    this.agents.sync(ordered);

    const tp = aggregateTasks(agents);
    setHidden(this.tasksSec.el, tp.total === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(agents.flatMap((a) => a.tasks.map((task) => ({ task, owner: a.name, key: `${a.id}#${task.id}` }))));

    const feed = this.ctx.store.feed.filter((f) => f.roomId === r.id).slice(-ROOM_FEED_LIMIT).reverse();
    setHidden(this.feedSec.el, feed.length === 0);
    this.feed.sync(feed);
  }
}

// ---------------------------------------------------------------- gaveta

export class Drawer implements UiComponent {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private agentView: AgentView;
  private roomView: RoomView;
  private mode: 'agent' | 'room' | null = null;
  private heading: HTMLElement;
  private movable: Movable;
  /** Avisado quando a gaveta é solta ou volta ao lugar (a área livre do escritório muda). */
  onLayoutChange: (() => void) | null = null;

  constructor(
    private ctx: UiContext,
    terminal: TerminalControl,
  ) {
    this.agentView = new AgentView(ctx, terminal);
    this.roomView = new RoomView(ctx);
    this.heading = h('span', { class: 'ui-drawer__kind' });
    const close = iconButton(ICONS.close, 'Fechar detalhes (Esc)', () => ctx.select(null));
    this.body = h('div', { class: 'ui-drawer__body' });
    const bar = h('div', { class: 'ui-drawer__bar' }, this.heading, close);
    this.el = h(
      'aside',
      { class: 'ui-panel ui-drawer', attrs: { 'aria-label': 'Detalhes', id: 'ui-drawer', 'aria-hidden': 'true' } },
      bar,
      this.body,
    );
    // Arrastar pela barra solta a gaveta: flutuante, ela não cobre mais a lateral do escritório.
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.drawer', enabled: () => !ctx.isNarrow(), onChange: () => this.onLayoutChange?.() });
    this.el.inert = true;
  }

  get isOpen(): boolean {
    return this.mode !== null;
  }

  /** Solta do lugar (arrastada pela barra). */
  get floating(): boolean {
    return this.movable.floating;
  }

  toggleFollow(): void {
    if (this.mode === 'agent') this.agentView.toggleFollow();
  }

  render(): void {
    const sel = this.ctx.selection();
    const mode = sel?.type ?? null;
    if (mode !== this.mode) {
      // Gaveta fechada ou fora do agente: o editor fecha, e ao reabrir começa do estado atual do agente.
      if (this.mode === 'agent') this.agentView.character.close();
      this.mode = mode;
      this.body.replaceChildren(...(mode === 'agent' ? [this.agentView.el] : mode === 'room' ? [this.roomView.el] : []));
      this.body.scrollTop = 0;
      this.el.classList.toggle('is-open', mode !== null);
      setAttr(this.el, 'aria-hidden', mode ? 'false' : 'true');
      this.el.inert = mode === null;
    }
    if (sel?.type === 'agent') {
      if (this.agentView.agentId !== sel.id) this.body.scrollTop = 0;
      this.agentView.open(sel.id);
      setText(this.heading, this.ctx.agent(sel.id)?.kind === 'sub' ? 'Subagente' : 'Agente');
      this.agentView.render();
    } else if (sel?.type === 'room') {
      if (this.roomView.roomId !== sel.id) this.body.scrollTop = 0;
      this.roomView.open(sel.id);
      setText(this.heading, 'Sala');
      this.roomView.render();
    }
  }
}
