// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. A lógica pura está em ui/composer-model.ts.
// Imagens (ui/message-images.ts): o clipe anexa, Ctrl+V cola um print e dá para arrastar e soltar; até 6 por mensagem,
// com miniaturas (o X tira). Na hora de mandar, cada uma é reduzida (se for grande) e sobe; a mensagem leva os ids e o
// servidor as grava no computador, com os caminhos no fim do texto para o agente abrir.
import { MESSAGE_IMAGE_TYPES, MESSAGE_IMAGES_MAX, MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider } from '../../../shared/types';
import {
  canSend,
  composerMode,
  composerTip,
  enterSends,
  isSettled,
  LOST_ERROR,
  messageText,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pollDelay,
  sendStatusText,
  timeoutError,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { imageFiles, prepareImage, uploadImage, type PreparedImage } from './message-images';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

/** Imagem na caixa, esperando o envio. */
interface PendingImage {
  key: number;
  name: string;
  /** Miniatura (object URL do arquivo original). */
  url: string;
  /** Redução e base64 (começam ao anexar). */
  prepared: Promise<PreparedImage>;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Imagens anexadas de cada agente (como o rascunho do texto). */
  private images = new Map<string, PendingImage[]>();
  private imageSeq = 0;
  private canImages = false;
  private imagesRow: HTMLElement;
  private attachBtn: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  /** Agente da caixa (ou a chave da conversa, no terminal do histórico). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Rascunho por agente: é ele que manda no conteúdo da caixa. */
  private drafts = new Map<string, string>();
  /** Último envio de cada agente (a linha de situação). */
  private states = new Map<string, SendState>();
  /** Ferramenta de cada agente que recebeu mensagem (o texto da entrega e do prazo muda no Codex). */
  private providers = new Map<string, Provider>();
  /** Ferramenta do agente da caixa. */
  private provider: Provider = 'claude';
  /** O que a caixa mostra agora ("<agente>|<pronta>"): ao mudar, o conteúdo vem do rascunho. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Linha do ditado (gravando, transcrevendo, idioma, erro). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rascunho que recebe o ditado em andamento (o agente pode mudar enquanto o Mac transcreve). */
  private dictKey = '';
  private canDictate = false;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
    });
    this.box.addEventListener('focus', () => this.resize());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    // Ctrl+V com um print (ou uma imagem copiada): vira anexo; o texto que vier junto cola normalmente
    this.box.addEventListener('paste', (e) => {
      if (!this.canImages) return;
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      if (!e.clipboardData?.getData('text/plain')) e.preventDefault();
      this.addImages(files);
    });
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { accept: MESSAGE_IMAGE_TYPES.join(','), multiple: true } }) as HTMLInputElement;
    this.fileInput.addEventListener('change', () => {
      this.addImages(Array.from(this.fileInput.files ?? []));
      this.fileInput.value = '';
    });
    this.attachBtn = h('button', {
      class: `ui-msg__attach${term ? '' : ' ui-btn'}`,
      type: 'button',
      title: tr('Anexar imagens (ou cole um print com Ctrl+V)'),
      attrs: { 'aria-label': tr('Anexar imagens') },
      on: { click: () => this.fileInput.click() },
    });
    this.attachBtn.innerHTML = ICONS.attach;
    setHidden(this.attachBtn, true);
    this.imagesRow = h('div', { class: 'ui-msg__images', hidden: true, attrs: { 'aria-label': tr('Imagens anexadas') } });
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Mandar (Enter)'),
        attrs: { 'aria-label': tr('Mandar a mensagem') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Enviar'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.attachBtn, this.fileInput, this.dictate.el, this.sendBtn);
    // Clique na "linha do prompt" (fora do botão) põe o cursor na caixa, como num terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.imagesRow, this.row, this.dictStatus, this.status, this.tip);
    // arrastar e soltar imagens em qualquer parte da caixa
    this.el.addEventListener('dragover', (e) => {
      if (!this.canImages || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.el.classList.add('is-drop');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.el.classList.remove('is-drop');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('is-drop');
      if (!this.canImages) return;
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      this.addImages(files);
    });
  }

  /**
   * Atualiza a caixa para `agent` (undefined = nenhum: sessão do histórico ou agente que saiu); `key` identifica o
   * rascunho. Devolve o modo: a gaveta esconde a seção quando é 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Troca de agente (ou a caixa passou a valer/deixou de valer): o conteúdo vem do rascunho guardado.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Gravando para outro agente: para sem transcrever (a fala era para aquele).
      this.dictate.cancel();
      this.shown = shown;
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
      this.renderImages();
    }
    // Imagens: com as mensagens liberadas daqui e o servidor gravando (no Docker, com a pasta montada).
    const canImages = ready && !store.mock && !!access().messageImages;
    if (canImages !== this.canImages) {
      this.canImages = canImages;
      this.renderImages();
    }
    setHidden(this.attachBtn, !canImages);
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('o agente');
    const placeholder = ready ? (term ? tr('Mensagem para {0} (Enter manda, Shift+Enter quebra a linha)', [name]) : tr('Mensagem para {0}…', [name])) : mode.text;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Mensagem para {0}', [name]) : mode.text);
    setTitle(this.box, ready ? '' : mode.text);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    // Consulta em cache (30 s): o Mac pode instalar o Whisper ou parar o auxiliar com a página aberta.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcrevendo: o botão fica até o texto chegar (ele vai para o rascunho de quem ditou).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // Na gaveta, a dica do plugin entra no lugar da caixa; no terminal ela já está no lugar do texto.
    setHidden(this.row, !term && !ready);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internos

  private onKey(e: KeyboardEvent): void {
    // Os atalhos globais (F, T, P, /, setas...) não valem dentro da caixa. Com Ctrl/⌘ a tecla segue adiante
    // (Ctrl/⌘+F busca na conversa do terminal; os atalhos globais ignoram essas combinações).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (e.key === 'Escape') {
      // Esc só sai da caixa (o próximo fecha o terminal ou a gaveta).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /** Texto ditado: no cursor, se a caixa ainda é a de quem ditou; senão, no fim do rascunho daquele agente. */
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Avisos de sucesso somem sozinhos; "Gravando…" e "Transcrevendo…" ficam até a próxima mudança.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !this.sendable(this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Dá para mandar: texto, ou imagens (o texto pode ficar vazio) sem passar do tamanho. */
  private sendable(raw: string): boolean {
    if (canSend(raw)) return true;
    return this.canImages && !!this.images.get(this.agentId)?.length && messageText(raw).length <= MESSAGE_MAX;
  }

  // ---------------------------------------------------------------- imagens

  /** Anexa imagens à mensagem do agente da caixa (até MESSAGE_IMAGES_MAX); a redução começa já. */
  private addImages(files: readonly File[]): void {
    if (!this.canImages || !files.length) return;
    const key = this.agentId;
    const list = this.images.get(key) ?? [];
    const room = MESSAGE_IMAGES_MAX - list.length;
    if (files.length > room) this.sayDictation(tr('No máximo {0} imagens por mensagem.', [MESSAGE_IMAGES_MAX]), true);
    for (const f of files.slice(0, Math.max(0, room))) {
      const prepared = prepareImage(f);
      prepared.catch(() => undefined);
      list.push({ key: ++this.imageSeq, name: f.name || tr('imagem'), url: URL.createObjectURL(f), prepared });
    }
    this.images.set(key, list);
    this.renderImages();
    this.syncButton();
    this.box.focus({ preventScroll: true });
  }

  private removeImage(key: string, imageKey: number): void {
    const list = this.images.get(key) ?? [];
    const gone = list.find((i) => i.key === imageKey);
    if (gone) URL.revokeObjectURL(gone.url);
    this.images.set(key, list.filter((i) => i.key !== imageKey));
    this.renderImages();
    this.syncButton();
  }

  private clearImages(key: string, sent: readonly PendingImage[]): void {
    const list = this.images.get(key) ?? [];
    for (const i of sent) URL.revokeObjectURL(i.url);
    this.images.set(key, list.filter((i) => !sent.includes(i)));
    if (key === this.agentId) this.renderImages();
  }

  /** Miniaturas das imagens do agente da caixa, com o X para tirar. */
  private renderImages(): void {
    const key = this.agentId;
    const list = this.canImages ? (this.images.get(key) ?? []) : [];
    this.imagesRow.replaceChildren(
      ...list.map((i) => {
        const x = h('button', { class: 'ui-msg__thumb-x', type: 'button', text: '×', attrs: { 'aria-label': tr('Tirar {0}', [i.name]), title: tr('Tirar a imagem') }, on: { click: () => this.removeImage(key, i.key) } });
        return h('div', { class: 'ui-msg__thumb', title: i.name }, h('img', { attrs: { src: i.url, alt: i.name } }), x);
      }),
    );
    setHidden(this.imagesRow, !list.length);
  }

  /** Cresce com o texto até o limite do CSS (~6 linhas; depois rola). Escondida, mede quando aparecer. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  private async send(): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || !this.sendable(raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    // as imagens sobem antes (cada uma vira um id); um erro aqui deixa tudo na caixa para tentar de novo
    const pending = this.canImages ? [...(this.images.get(agentId) ?? [])] : [];
    const ids: string[] = [];
    try {
      for (const img of pending) ids.push(await uploadImage(await img.prepared));
    } catch (err) {
      this.setState(agentId, { phase: 'rejected', error: tr('Não deu para mandar a imagem: {0}', [(err as Error).message || OFFLINE_ERROR]), at: Date.now() });
      return;
    }
    let r: { message: OutboxMessage } | { error: string };
    try {
      r = await this.ctx.store.sendMessage(agentId, messageText(raw), ids);
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: as imagens enviadas saem e a caixa esvazia (a não ser que você tenha continuado a escrever).
    if (pending.length) this.clearImages(agentId, pending);
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Consulta a situação até ela se resolver (ou o prazo acabar). Para quando outro envio toma a linha de situação. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // Sem conexão agora: tenta de novo na próxima volta.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
