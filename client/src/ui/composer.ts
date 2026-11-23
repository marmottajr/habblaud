// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. A lógica pura está em ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
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
import { h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { fileToBase64, formatBytes, MAX_FILE_BYTES, MAX_FILES } from './spawn';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

/** Anexo escolhido para a próxima mensagem (sobe ao mandar: POST /api/messages/attachments, um por arquivo). */
interface PendingFile {
  file: File;
  url?: string;
}

/** A mensagem com os caminhos dos anexos no fim (o agente lê os arquivos pelos caminhos). */
export function textWithAttachments(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  const head = paths.length === 1 ? tr('Anexo enviado pelo Habblaud:') : tr('Anexos enviados pelo Habblaud:');
  return `${text.trim() ? `${text}\n\n` : ''}${head}\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

export class MessageComposer {
  readonly el: HTMLElement;
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
  /** Anexos de cada agente esperando o envio (como o rascunho, só na memória). */
  private files = new Map<string, PendingFile[]>();
  private fileInput: HTMLInputElement;
  private attachBtn: HTMLButtonElement;
  private fileList: HTMLElement;
  /** Aviso dos anexos (grande demais, limite, falha ao subir). */
  private fileNote: HTMLElement;

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
    // Anexos: o clipe, colar uma imagem (Ctrl/⌘+V) ou soltar arquivos na caixa.
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    this.attachBtn = iconButton(ICONS.attach, tr('Anexar imagens ou arquivos (ou cole/solte na caixa)'), () => this.fileInput.click(), 'ui-msg__attach');
    this.fileList = h('ul', { class: 'ui-spawn__files ui-msg__files', attrs: { 'aria-label': tr('Anexos') } });
    this.fileNote = h('p', { class: 'ui-msg__status is-error', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.box.addEventListener('paste', (e) => {
      const list = [...(e.clipboardData?.files ?? [])];
      if (!list.length || this.box.disabled) return;
      e.preventDefault();
      this.addFiles(list);
    });
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic ui-term__prompt--attach' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.attachBtn, this.dictate.el, this.sendBtn, this.fileInput);
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
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.fileList, this.row, this.fileNote, this.dictStatus, this.status, this.tip);
    this.el.addEventListener('dragover', (e) => {
      if (this.mode.kind !== 'ready' || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('is-drop');
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget as Node | null)) this.el.classList.remove('is-drop');
    });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('is-drop');
      const list = [...(e.dataTransfer?.files ?? [])];
      if (this.mode.kind !== 'ready' || !list.length) return;
      e.preventDefault();
      this.addFiles(list);
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
      setHidden(this.fileNote, true);
      this.renderFiles();
    }
    this.box.disabled = !ready;
    setHidden(this.attachBtn, !ready);
    setHidden(this.fileList, !ready);
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
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !this.sendable(this.agentId, this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Dá para mandar: texto válido, ou só anexos (com texto vazio). */
  private sendable(agentId: string, raw: string): boolean {
    if (canSend(raw)) return true;
    return !!this.files.get(agentId)?.length && messageText(raw).length <= MESSAGE_MAX;
  }

  // ---------------------------------------------------------------- anexos

  private addFiles(list: File[]): void {
    const key = this.agentId;
    const cur = this.files.get(key) ?? [];
    let note = '';
    for (const file of list) {
      if (cur.length >= MAX_FILES) {
        note = tr('No máximo {0} anexos por pedido.', [MAX_FILES]);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        note = tr('{0} passa de {1} MB.', [file.name, MAX_FILE_BYTES / 1024 / 1024]);
        continue;
      }
      if (!file.size) continue;
      cur.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined });
    }
    this.files.set(key, cur);
    setText(this.fileNote, note);
    setHidden(this.fileNote, !note);
    this.renderFiles();
    this.syncButton();
    this.box.focus({ preventScroll: true });
  }

  private removeFile(key: string, item: PendingFile): void {
    if (item.url) URL.revokeObjectURL(item.url);
    const left = (this.files.get(key) ?? []).filter((f) => f !== item);
    if (left.length) this.files.set(key, left);
    else this.files.delete(key);
    if (key === this.agentId) {
      this.renderFiles();
      this.syncButton();
    }
  }

  private clearFiles(key: string, sent: readonly PendingFile[]): void {
    for (const f of sent) this.removeFile(key, f);
  }

  /** Lista dos anexos da caixa atual (miniatura da imagem, nome, tamanho e o × para tirar). */
  private renderFiles(): void {
    const key = this.agentId;
    const items = this.files.get(key) ?? [];
    this.fileList.replaceChildren(
      ...items.map((item) => {
        const { file, url } = item;
        const thumb = url
          ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } })
          : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('ARQ') });
        const remove = iconButton(ICONS.close, tr('Tirar {0}', [file.name]), () => this.removeFile(key, item), 'ui-icon-btn--sm ui-spawn__file-x');
        return h(
          'li',
          { class: 'ui-spawn__file' },
          thumb,
          h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }),
          h('span', { class: 'ui-spawn__file-size', text: formatBytes(file.size) }),
          remove,
        );
      }),
    );
  }

  /** Sobe os anexos (um por vez) e devolve os caminhos gravados no computador. */
  private async upload(items: readonly PendingFile[]): Promise<string[] | { error: string }> {
    const paths: string[] = [];
    for (const item of items) {
      let res: Response;
      try {
        res = await fetch('/api/messages/attachments', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: item.file.name, type: item.file.type, data: await fileToBase64(item.file) }),
        });
      } catch {
        return { error: OFFLINE_ERROR };
      }
      const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || typeof body.path !== 'string') return { error: body.error ?? tr('erro {0}', [res.status]) };
      paths.push(body.path);
    }
    return paths;
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
    if (this.mode.kind !== 'ready' || !this.sendable(agentId, raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    const attached = [...(this.files.get(agentId) ?? [])];
    let r: { message: OutboxMessage } | { error: string };
    const paths = attached.length ? await this.upload(attached) : [];
    if (!Array.isArray(paths)) r = paths;
    else {
      const text = textWithAttachments(messageText(raw), paths);
      if (text.length > MESSAGE_MAX) r = { error: tr('a mensagem com os anexos passa de {0} caracteres', [MESSAGE_MAX]) };
      else {
        try {
          r = await this.ctx.store.sendMessage(agentId, text);
        } catch {
          r = { error: OFFLINE_ERROR };
        }
      }
    }
    // Aceita: os anexos mandados saem da caixa (os escolhidos enquanto subiam ficam).
    if (!('error' in r)) this.clearFiles(agentId, attached);
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: a caixa esvazia (a não ser que você tenha continuado a escrever enquanto o envio ia).
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
