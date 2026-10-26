// Bate-papo paralelo: a janela lateral do terminal de um agente (server/asides/*). Perguntas sobre o que o
// agente está fazendo, sem entrar na conversa dele e sem esperar o turno acabar. A lógica pura fica em
// ui/aside-model.ts; a rede, em OfficeStore (asides/askAside/cancelAside/deleteAside). A página consulta o servidor
// (nada de evento novo no SSE: o fluxo vai a qualquer página, e a conversa só vale para quem pode ler o terminal).
import { ASIDE_QUESTION_MAX, isFinalAside, type AsideTopic } from '../../../shared/asides';
import { tr } from '../../../shared/i18n';
import type { AgentInfo } from '../../../shared/types';
import { enterSends } from './composer-model';
import { asidePollMs, asideRunning, asideStatusText, currentTopic, topicLabel } from './aside-model';
import type { UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';

/** Uma pergunta já desenhada: só o corpo da resposta e a linha de situação mudam enquanto ela chega. */
interface TurnRefs {
  answerBox: HTMLElement;
  statusEl: HTMLElement;
  answer: string;
  status: string;
}

/** Quanto antes do fim da rolagem ainda conta como "no fim" (px). */
const AT_END_PX = 24;
/** Nova tentativa depois de uma consulta que falhou, com pergunta em andamento. */
const RETRY_MS = 2_000;

export class AsideChat {
  readonly el: HTMLElement;
  /** O terminal ajusta a largura quando a janela abre ou fecha. */
  onToggle?: (open: boolean) => void;
  /** O usuário fechou a janela (Esc ou o botão): o terminal devolve o foco à caixa dele. */
  onDismiss?: () => void;

  private agentId: string | null = null;
  private topics: AsideTopic[] = [];
  /** Conversa escolhida por agente (só na memória). */
  private readonly chosen = new Map<string, string>();
  /** Agentes em "Nova conversa": a próxima pergunta cria a conversa. */
  private readonly fresh = new Set<string>();
  private readonly drafts = new Map<string, string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Número da consulta mais recente: respostas antigas (ou de outro agente) são ignoradas. */
  private seq = 0;
  private sending = false;

  private readonly picker: HTMLSelectElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly delBtn: HTMLButtonElement;
  private readonly log: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly box: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;

  private shownTopic: string | null = null;
  private turns = new Map<string, TurnRefs>();
  private pickerSig = '';

  constructor(private readonly ctx: UiContext) {
    this.picker = h('select', { class: 'ui-chat__picker', attrs: { 'aria-label': tr('Conversas') } });
    this.picker.addEventListener('change', () => this.pick(this.picker.value));
    this.newBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Nova conversa'), on: { click: () => this.startFresh() } });
    this.delBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Apagar conversa'), on: { click: () => void this.remove() } });
    const closeBtn = iconButton(ICONS.close, tr('Fechar o bate-papo paralelo (Esc)'), () => this.dismiss(), 'ui-icon-btn--sm ui-chat__close');

    this.list = h('div', { class: 'ui-chat__list' });
    this.empty = h('p', {
      class: 'ui-chat__empty',
      text: tr('Pergunte algo sobre o que o agente está fazendo. Ele não para o que está fazendo para responder.'),
    });
    this.log = h('div', { class: 'ui-chat__log', role: 'log', tabIndex: 0, attrs: { 'aria-live': 'polite', 'aria-label': tr('Bate-papo paralelo') } }, this.empty, this.list);

    this.errorEl = h('p', { class: 'ui-chat__error', role: 'status', hidden: true });
    this.box = h('textarea', {
      class: 'ui-chat__input',
      attrs: { rows: 2, maxlength: ASIDE_QUESTION_MAX, autocomplete: 'off', placeholder: tr('Mensagem para o bate-papo paralelo'), 'aria-label': tr('Mensagem para o bate-papo paralelo') },
    });
    this.box.addEventListener('input', () => {
      if (this.agentId) this.drafts.set(this.agentId, this.box.value);
      this.syncButton();
    });
    this.box.addEventListener('keydown', (e) => {
      if (enterSends(e)) {
        e.preventDefault();
        void this.submit(true);
      }
    });
    this.sendBtn = h('button', { class: 'ui-btn ui-btn--sm ui-chat__send', type: 'button', text: tr('Enviar'), on: { click: () => void this.submit() } });

    this.el = h(
      'aside',
      { class: 'ui-chat', hidden: true, attrs: { 'aria-label': tr('Bate-papo paralelo') } },
      h(
        'div',
        { class: 'ui-chat__head' },
        h(
          'div',
          { class: 'ui-chat__title' },
          h('strong', { text: tr('Bate-papo paralelo') }),
          h('span', { class: 'ui-chat__hint', text: tr('Não entra na conversa do agente nem espera ele terminar') }),
        ),
        closeBtn,
      ),
      h('div', { class: 'ui-chat__bar' }, this.picker, this.newBtn, this.delBtn),
      this.log,
      this.errorEl,
      h('div', { class: 'ui-chat__foot' }, this.box, this.sendBtn),
    );
    // Esc fecha só a janela (o terminal continua aberto): o terminal escuta o mesmo evento mais acima.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.dismiss();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Abre a janela para o agente (ou a fecha, se já estava aberta para ele). */
  toggle(agentId: string): void {
    if (this.isOpen && this.agentId === agentId) return this.dismiss();
    this.agentId = agentId;
    this.topics = [];
    this.resetView();
    this.el.hidden = false;
    this.box.value = this.drafts.get(agentId) ?? '';
    this.setError('');
    this.draw();
    this.onToggle?.(true);
    this.box.focus({ preventScroll: true });
    void this.refresh();
  }

  close(): void {
    if (!this.isOpen) return;
    this.clearPoll();
    this.seq++;
    this.el.hidden = true;
    this.agentId = null;
    this.topics = [];
    this.resetView();
    this.onToggle?.(false);
  }

  private dismiss(): void {
    this.close();
    this.onDismiss?.();
  }

  /** O terminal chama a cada quadro: a janela só vale para o agente ao vivo que responde perguntas paralelas (canAside) e está pronto para receber mensagens. */
  render(agent: AgentInfo | undefined, ready: boolean): void {
    if (!this.isOpen) return;
    if (!agent || agent.id !== this.agentId || agent.kind !== 'main' || !agent.canAside || !ready) this.close();
  }

  // ---------------------------------------------------------------- dados

  private async refresh(): Promise<void> {
    const agentId = this.agentId;
    if (!agentId || !this.isOpen) return;
    const seq = ++this.seq;
    this.clearPoll();
    try {
      const r = await this.ctx.store.asides(agentId);
      if (seq !== this.seq) return;
      if ('error' in r) {
        this.setError(r.error);
        this.schedule(RETRY_MS);
        return;
      }
      this.setError('');
      this.topics = r.topics;
    } catch {
      if (seq !== this.seq) return;
      this.setError(tr('sem conexão com o Habblaud'));
      this.schedule(RETRY_MS);
      return;
    }
    this.draw();
    this.schedule(asidePollMs(this.topics, this.isOpen));
  }

  private schedule(ms: number | null): void {
    this.clearPoll();
    if (ms === null || !this.isOpen || (ms === RETRY_MS && !asideRunning(this.topics))) return;
    this.pollTimer = setTimeout(() => void this.refresh(), ms);
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private setError(text: string): void {
    setText(this.errorEl, text);
    setHidden(this.errorEl, !text);
  }

  // ---------------------------------------------------------------- ações

  private pick(topicId: string): void {
    const id = this.agentId;
    if (!id) return;
    if (topicId) {
      this.chosen.set(id, topicId);
      this.fresh.delete(id);
    } else {
      this.chosen.delete(id);
      this.fresh.add(id);
    }
    this.draw();
  }

  private startFresh(): void {
    const id = this.agentId;
    if (!id) return;
    this.fresh.add(id);
    this.chosen.delete(id);
    this.draw();
    this.box.focus({ preventScroll: true });
  }

  private current(): AsideTopic | undefined {
    const id = this.agentId;
    if (!id || this.fresh.has(id)) return undefined;
    return currentTopic(this.topics, this.chosen.get(id));
  }

  /** Com pergunta em andamento o botão vira "Parar"; o Enter não para nada (`fromKey`: a caixa fica livre para o rascunho). */
  private async submit(fromKey = false): Promise<void> {
    const agentId = this.agentId;
    if (!agentId) return;
    if (asideRunning(this.topics)) return fromKey ? undefined : this.stop();
    const text = this.box.value.trim();
    if (!text || this.sending) return;
    this.sending = true;
    this.syncButton();
    this.setError('');
    try {
      const r = await this.ctx.store.askAside(agentId, text, this.current()?.id);
      if (this.agentId !== agentId) return;
      if ('error' in r) {
        this.setError(r.error);
        return;
      }
      const i = this.topics.findIndex((t) => t.id === r.topic.id);
      if (i >= 0) this.topics[i] = r.topic;
      else this.topics.unshift(r.topic);
      this.chosen.set(agentId, r.topic.id);
      this.fresh.delete(agentId);
      if (this.box.value.trim() === text) {
        this.box.value = '';
        this.drafts.delete(agentId);
      }
      this.draw(true);
      this.schedule(asidePollMs(this.topics, true));
    } catch {
      if (this.agentId === agentId) this.setError(tr('sem conexão com o Habblaud'));
    } finally {
      this.sending = false;
      this.syncButton();
    }
  }

  private async stop(): Promise<void> {
    const agentId = this.agentId;
    const topic = this.topics.find((t) => t.turns.some((q) => !isFinalAside(q.status)));
    if (!agentId || !topic) return;
    this.setError('');
    try {
      const r = await this.ctx.store.cancelAside(agentId, topic.id);
      if (this.agentId !== agentId) return;
      if ('error' in r) this.setError(r.error);
    } catch {
      if (this.agentId === agentId) this.setError(tr('sem conexão com o Habblaud'));
    }
    void this.refresh();
  }

  private async remove(): Promise<void> {
    const agentId = this.agentId;
    const topic = this.current();
    if (!agentId || !topic || asideRunning(this.topics)) return;
    if (!confirm(tr('Apagar esta conversa do bate-papo paralelo?'))) return;
    this.setError('');
    try {
      const r = await this.ctx.store.deleteAside(agentId, topic.id);
      if (this.agentId !== agentId) return;
      if ('error' in r) return this.setError(r.error);
      this.topics = this.topics.filter((t) => t.id !== topic.id);
      this.chosen.delete(agentId);
      this.draw();
    } catch {
      if (this.agentId === agentId) this.setError(tr('sem conexão com o Habblaud'));
    }
  }

  // ---------------------------------------------------------------- desenho

  private resetView(): void {
    this.list.replaceChildren();
    this.turns.clear();
    this.shownTopic = null;
    this.pickerSig = '';
    this.picker.replaceChildren();
  }

  private syncButton(): void {
    const running = asideRunning(this.topics);
    setText(this.sendBtn, running ? tr('Parar') : tr('Enviar'));
    this.sendBtn.classList.toggle('is-stop', running);
    this.sendBtn.disabled = !running && (this.sending || !this.box.value.trim());
  }

  /** `toEnd`: a pergunta foi feita agora, a janela vai ao fim. */
  private draw(toEnd = false): void {
    const agentId = this.agentId;
    if (!agentId) return;
    const topic = this.current();
    const running = asideRunning(this.topics);
    this.drawPicker(agentId, topic);
    this.delBtn.disabled = !topic || running;
    setAttr(this.delBtn, 'title', running ? tr('Espere a resposta ou pare antes de apagar') : tr('Apagar conversa'));

    const atEnd = toEnd || this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < AT_END_PX;
    if ((topic?.id ?? null) !== this.shownTopic) {
      this.list.replaceChildren();
      this.turns.clear();
      this.shownTopic = topic?.id ?? null;
    }
    for (const turn of topic?.turns ?? []) {
      let refs = this.turns.get(turn.id);
      if (!refs) {
        const answerBox = h('div', { class: 'ui-chat__md ui-md' });
        const statusEl = h('p', { class: 'ui-chat__status', hidden: true });
        this.list.append(
          h('div', { class: 'ui-chat__bubble ui-chat__bubble--me', text: turn.question }),
          h('div', { class: 'ui-chat__bubble ui-chat__bubble--agent' }, answerBox, statusEl),
        );
        refs = { answerBox, statusEl, answer: '', status: '' };
        this.turns.set(turn.id, refs);
      }
      // Resposta que só cresce: troca só o corpo daquele balão.
      if (turn.answer !== refs.answer) {
        refs.answerBox.replaceChildren(renderMarkdown(turn.answer));
        refs.answer = turn.answer;
      }
      const status = asideStatusText(turn);
      if (status !== refs.status) {
        setText(refs.statusEl, status);
        setHidden(refs.statusEl, !status);
        refs.statusEl.classList.toggle('is-failed', turn.status === 'failed');
        refs.status = status;
      }
    }
    setHidden(this.empty, !!topic?.turns.length);
    this.syncButton();
    if (atEnd) this.log.scrollTop = this.log.scrollHeight;
  }

  private drawPicker(agentId: string, topic: AsideTopic | undefined): void {
    const fresh = this.fresh.has(agentId) || !this.topics.length;
    const sig = `${fresh ? 'n' : ''}|${this.topics.map((t) => `${t.id}:${topicLabel(t)}`).join('|')}`;
    if (sig !== this.pickerSig) {
      this.pickerSig = sig;
      const options: HTMLOptionElement[] = [];
      if (fresh) {
        const o = h('option', { text: tr('Nova conversa') });
        o.value = '';
        options.push(o);
      }
      for (const t of this.topics) {
        const o = h('option', { text: topicLabel(t) });
        o.value = t.id;
        options.push(o);
      }
      this.picker.replaceChildren(...options);
    }
    this.picker.value = fresh ? '' : (topic?.id ?? '');
    this.picker.disabled = !this.topics.length;
  }
}
