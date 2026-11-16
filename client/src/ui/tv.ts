// TV das salas (apresentações; shared/presentation.ts e server/presentations/). Clicar na TV de uma sala (ou em
// "Assistir" no aviso de apresentação pronta) abre esta janela por cima de tudo, com a moldura de uma TV e o escritório
// desfocado atrás:
// - com apresentação, abre a mais recente no primeiro slide, parada: setas, espaço, clique ou deslizar avançam; ▶ liga
//   o modo automático (o tempo de cada slide vem do tamanho do texto) e qualquer navegação pausa; Esc fecha;
// - a lista mostra as anteriores da sala (a mais recente primeiro, com o selo "nova") e o botão de pedir outra;
// - sem apresentação (ou enquanto o agente prepara), o pedido: com mais de um agente principal na sala, você escolhe
//   quem recebe. O pedido vai como mensagem pelo escritório (plugin habblaud-mensagens).
// Enquanto a apresentação está na tela, os personagens da sala vão assistir (WorldApi.setTvAudience).
// Os slides são montados com textContent (nunca innerHTML): nada do texto do agente vira HTML na página.
import { autoAdvanceMs, parseSlides, type Block, type Inline, type PresentationContent, type PresentationSummary, type Slide } from '../../../shared/presentation';
import type { AgentInfo, RoomInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import { createAvatar } from './avatar';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle } from './dom';
import { formatDateTime } from './format';
import { ICONS, pixelIcon } from './icons';

/** Evento (em ctx.root) que abre a TV de uma sala: detail = id da sala. O aviso "Apresentação pronta" usa. */
export const TV_OPEN_EVENT = 'habblaud:tv-open';

const PLAY_ICON = pixelIcon(['##......', '####....', '######..', '########', '######..', '####....', '##......']);
const PAUSE_ICON = pixelIcon(['##..##', '##..##', '##..##', '##..##', '##..##', '##..##', '##..##']);
const LIST_ICON = pixelIcon(['##.######', '.........', '##.######', '.........', '##.######', '.........', '##.######']);

type View =
  | { kind: 'loading' }
  | { kind: 'list' }
  | { kind: 'request' }
  | { kind: 'slides'; content: PresentationContent; slides: Slide[]; index: number }
  | { kind: 'error'; text: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? tr('erro {0}', [res.status]));
  return out;
}

/** Agentes principais presentes numa sala (quem pode receber o pedido). */
export function roomMains(agents: readonly AgentInfo[], roomId: string): AgentInfo[] {
  return agents.filter((a) => a.roomId === roomId && a.kind === 'main' && a.status !== 'offline' && a.status !== 'done');
}

// ------------------------------------------------------------------ slides (DOM seguro)

function inlineNodes(c: readonly Inline[], img: (src: string) => string): Node[] {
  return c.map((x) => {
    switch (x.t) {
      case 'text':
        return document.createTextNode(x.v);
      case 'code':
        return h('code', { text: x.v });
      case 'b':
        return h('strong', {}, ...inlineNodes(x.c, img));
      case 'i':
        return h('em', {}, ...inlineNodes(x.c, img));
      case 'link':
        return h('a', { attrs: { href: x.href, target: '_blank', rel: 'noopener noreferrer' } }, ...inlineNodes(x.c, img));
      case 'img':
        return h('img', { class: 'ui-tv__inline-img', attrs: { src: img(x.src), alt: x.alt, loading: 'lazy' } });
    }
  });
}

function blockNode(b: Block, img: (src: string) => string): HTMLElement {
  switch (b.t) {
    case 'h':
      return h(`h${b.level}` as 'h1' | 'h2' | 'h3', {}, ...inlineNodes(b.c, img));
    case 'p':
      return h('p', {}, ...inlineNodes(b.c, img));
    case 'quote':
      return h('blockquote', {}, ...inlineNodes(b.c, img));
    case 'code':
      return h('pre', { class: 'ui-tv__code' }, h('code', { text: b.v }));
    case 'img':
      return h('figure', { class: 'ui-tv__figure' }, h('img', { attrs: { src: img(b.src), alt: b.alt, loading: 'lazy' } }), b.alt ? h('figcaption', { text: b.alt }) : null);
    case 'table':
      return h(
        'div',
        { class: 'ui-tv__table' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...b.head.map((c, i) => h('th', { style: b.align[i] ? `text-align:${b.align[i]}` : undefined }, ...inlineNodes(c, img))))),
          h('tbody', {}, ...b.rows.map((row) => h('tr', {}, ...row.map((c, i) => h('td', { style: b.align[i] ? `text-align:${b.align[i]}` : undefined }, ...inlineNodes(c, img)))))),
        ),
      );
    case 'list': {
      const list = h(b.ordered ? 'ol' : 'ul', { attrs: b.ordered && b.start !== 1 ? { start: b.start } : undefined });
      for (const it of b.items) list.append(h('li', { class: it.level ? 'is-sub' : undefined }, ...inlineNodes(it.c, img)));
      return list;
    }
  }
}

/** O slide montado em DOM (a capa, com "#" no começo, ganha o estilo de capa). */
export function slideNode(s: Slide, img: (src: string) => string): HTMLElement {
  const cover = s.blocks[0]?.t === 'h' && s.blocks[0].level === 1;
  return h('div', { class: `ui-tv__slide${cover ? ' is-cover' : ''}` }, ...s.blocks.map((b) => blockNode(b, img)));
}

// ------------------------------------------------------------------ janela

export class TvPlayer implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly roomLabel: HTMLElement;
  private readonly titleLabel: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly content: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly listBtn: HTMLButtonElement;
  private readonly counter: HTMLElement;
  private roomId: string | null = null;
  private view: View = { kind: 'loading' };
  private list: PresentationSummary[] = [];
  private canRequest = false;
  private listKey = '';
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chosen: string | null = null;
  private sending = false;
  private status = '';
  private touch: { x: number; y: number } | null = null;

  constructor(private readonly ctx: UiContext) {
    this.roomLabel = h('span', { class: 'ui-tv__room' });
    this.titleLabel = h('span', { class: 'ui-tv__title' });
    this.content = h('div', { class: 'ui-tv__content' });
    this.progress = h('div', { class: 'ui-tv__progress', attrs: { 'aria-hidden': 'true' } });
    this.screen = h('div', { class: 'ui-tv__screen', tabIndex: -1 }, this.content, this.progress);
    this.prevBtn = iconButton(ICONS.chevronLeft, tr('Slide anterior'), () => this.step(-1, true), 'ui-tv__btn');
    this.nextBtn = iconButton(ICONS.chevronRight, tr('Próximo slide'), () => this.step(1, true), 'ui-tv__btn');
    this.playBtn = iconButton(PLAY_ICON, tr('Passar sozinha'), () => this.togglePlay(), 'ui-tv__btn');
    this.listBtn = iconButton(LIST_ICON, tr('Apresentações desta sala'), () => this.show({ kind: 'list' }), 'ui-tv__btn');
    this.counter = h('span', { class: 'ui-tv__counter', attrs: { 'aria-live': 'polite' } });
    this.bar = h(
      'div',
      { class: 'ui-tv__bar' },
      this.prevBtn,
      this.counter,
      this.nextBtn,
      this.playBtn,
      h('span', { class: 'ui-tv__spacer' }),
      this.listBtn,
      iconButton(ICONS.close, tr('Desligar a TV (Esc)'), () => this.el.close(), 'ui-tv__btn'),
    );
    const set = h(
      'div',
      { class: 'ui-tv__set' },
      h('div', { class: 'ui-tv__head' }, h('span', { class: 'ui-tv__led', attrs: { 'aria-hidden': 'true' } }), this.roomLabel, this.titleLabel),
      this.screen,
      this.bar,
    );
    this.el = h('dialog', { class: 'ui-tv', attrs: { 'aria-label': tr('TV da sala') } }, set, h('div', { class: 'ui-tv__stand', attrs: { 'aria-hidden': 'true' } })) as HTMLDialogElement;
    this.el.addEventListener('close', () => this.onClose());
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.screen.addEventListener('click', (e) => this.onScreenClick(e));
    this.screen.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') this.touch = { x: e.clientX, y: e.clientY };
    });
    this.screen.addEventListener('pointerup', (e) => {
      const t = this.touch;
      this.touch = null;
      if (!t || this.view.kind !== 'slides') return;
      const dx = e.clientX - t.x;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - t.y) * 1.5) {
        this.swiped = true;
        this.step(dx < 0 ? 1 : -1, true);
      }
    });

    ctx.world.onTvClick?.((roomId) => void this.open(roomId));
    ctx.root.addEventListener(TV_OPEN_EVENT, (e) => void this.open((e as CustomEvent<string>).detail));
  }

  private swiped = false;

  private room(): RoomInfo | undefined {
    return this.roomId ? this.ctx.store.room(this.roomId) : undefined;
  }

  // ---------------------------------------------------------------- abrir e fechar

  /** Abre a TV de uma sala: a apresentação mais recente ou, sem nenhuma (ou com o pedido em preparo), o pedido. */
  async open(roomId: string): Promise<void> {
    if (!this.ctx.store.room(roomId)) return;
    this.roomId = roomId;
    this.chosen = null;
    this.status = '';
    this.show({ kind: 'loading' });
    if (!this.el.open) this.el.showModal();
    try {
      await this.loadList();
      const latest = this.list[0];
      const preparing = this.room()?.tv?.state === 'preparing';
      if (latest && !preparing) await this.openPresentation(latest.id);
      else this.show({ kind: this.list.length ? 'list' : 'request' });
    } catch (err) {
      this.show({ kind: 'error', text: tr('Não deu para ligar a TV: {0}', [(err as Error).message]) });
    }
  }

  private async loadList(): Promise<void> {
    if (!this.roomId) return;
    const r = await getJson<{ presentations: PresentationSummary[]; canRequest: boolean }>(`/api/presentations?room=${encodeURIComponent(this.roomId)}`);
    this.list = r.presentations;
    this.canRequest = r.canRequest && !!access().presentations;
    const tv = this.room()?.tv;
    this.listKey = `${tv?.count ?? 0}|${tv?.title ?? ''}`;
  }

  private async openPresentation(id: string): Promise<void> {
    this.show({ kind: 'loading' });
    try {
      const content = await getJson<PresentationContent>(`/api/presentations/${encodeURIComponent(id)}`);
      const slides = parseSlides(content.markdown);
      if (!slides.length) throw new Error(tr('a apresentação está vazia'));
      this.show({ kind: 'slides', content, slides, index: 0 });
      // o foco vai para a tela: espaço e setas já passam os slides
      this.screen.focus({ preventScroll: true });
      if (!content.seen) {
        void postJson(`/api/presentations/${encodeURIComponent(id)}/seen`, {}).catch(() => undefined);
        const item = this.list.find((p) => p.id === id);
        if (item) item.seen = true;
      }
    } catch (err) {
      this.show({ kind: 'error', text: tr('Não deu para abrir a apresentação: {0}', [(err as Error).message]) });
    }
  }

  private onClose(): void {
    this.stopPlay();
    this.ctx.world.setTvAudience?.(null);
    this.roomId = null;
    this.content.replaceChildren();
    this.view = { kind: 'loading' };
  }

  // ---------------------------------------------------------------- telas

  private show(view: View): void {
    this.stopPlay();
    this.view = view;
    const slides = view.kind === 'slides';
    this.ctx.world.setTvAudience?.(slides && this.roomId ? this.roomId : null);
    this.el.classList.toggle('is-slides', slides);
    for (const b of [this.prevBtn, this.nextBtn, this.playBtn]) setHidden(b, !slides);
    setHidden(this.counter, !slides);
    setHidden(this.listBtn, view.kind === 'list' || view.kind === 'loading');
    this.paint();
  }

  /** Redesenha a tela atual. */
  private paint(): void {
    const view = this.view;
    const room = this.room();
    setText(this.roomLabel, room ? tr('TV · {0}', [room.name]) : tr('TV'));
    setText(this.titleLabel, view.kind === 'slides' ? view.content.title : '');
    this.screen.classList.toggle('is-static', view.kind === 'loading' || (view.kind === 'request' && room?.tv?.state === 'preparing'));
    switch (view.kind) {
      case 'loading':
        this.content.replaceChildren(h('p', { class: 'ui-tv__msg', text: tr('Ligando…') }));
        return;
      case 'error':
        this.content.replaceChildren(h('p', { class: 'ui-tv__msg', text: view.text }));
        return;
      case 'list':
        this.content.replaceChildren(this.listNode());
        return;
      case 'request':
        this.content.replaceChildren(this.requestNode());
        return;
      case 'slides':
        this.paintSlide();
    }
  }

  private paintSlide(): void {
    const view = this.view;
    if (view.kind !== 'slides') return;
    const id = view.content.id;
    const img = (src: string) => `/api/presentations/${encodeURIComponent(id)}/image?src=${encodeURIComponent(src)}`;
    const node = slideNode(view.slides[view.index], img);
    this.content.replaceChildren(node);
    this.content.scrollTop = 0;
    setText(this.counter, tr('{0} / {1}', [view.index + 1, view.slides.length]));
    setAttr(this.prevBtn, 'aria-disabled', view.index === 0 ? 'true' : null);
    setAttr(this.nextBtn, 'aria-disabled', view.index === view.slides.length - 1 ? 'true' : null);
    this.prevBtn.disabled = view.index === 0;
    this.nextBtn.disabled = view.index === view.slides.length - 1;
    this.syncPlay();
  }

  private listNode(): HTMLElement {
    const room = this.room();
    const preparing = room?.tv?.state === 'preparing';
    const rows = this.list.map((p) =>
      h(
        'button',
        { class: 'ui-tv__item', type: 'button', on: { click: () => void this.openPresentation(p.id) } },
        h('span', { class: 'ui-tv__item-title', text: p.title }),
        h('span', { class: 'ui-tv__item-meta', text: tr('{0} · {1} slides', [formatDateTime(p.at), p.slides]) }),
        p.seen ? null : h('span', { class: 'ui-tv__badge', text: tr('nova') }),
      ),
    );
    return h(
      'div',
      { class: 'ui-tv__panel' },
      h('h2', { text: tr('Apresentações desta sala') }),
      preparing ? h('p', { class: 'ui-tv__note', text: tr('📡 Uma apresentação nova está sendo preparada.') }) : null,
      rows.length ? h('div', { class: 'ui-tv__items' }, ...rows) : h('p', { class: 'ui-tv__note', text: tr('Nenhuma apresentação nesta sala ainda.') }),
      this.canRequest ? h('button', { class: 'ui-btn ui-btn--primary ui-tv__cta', type: 'button', text: tr('Pedir nova apresentação'), on: { click: () => this.show({ kind: 'request' }) } }) : null,
    );
  }

  private requestNode(): HTMLElement {
    const room = this.room();
    const preparing = room?.tv?.state === 'preparing';
    const parts: (HTMLElement | null)[] = [h('h2', { text: preparing ? tr('Preparando a apresentação…') : tr('Pedir uma apresentação') })];
    if (preparing) {
      parts.push(h('p', { class: 'ui-tv__note', text: tr('O agente está criando os slides sobre a última tarefa concluída. A TV acende e avisa quando ficar pronta.') }));
      if (this.list.length) parts.push(h('button', { class: 'ui-btn ui-tv__cta', type: 'button', text: tr('Ver as anteriores'), on: { click: () => this.show({ kind: 'list' }) } }));
      return h('div', { class: 'ui-tv__panel' }, ...parts);
    }
    if (!this.list.length) parts.push(h('p', { class: 'ui-tv__note', text: tr('Esta sala ainda não tem apresentação.') }));
    if (!this.canRequest) {
      parts.push(
        h('p', {
          class: 'ui-tv__note',
          text: access().remote
            ? tr('Pedir pela TV não está liberado no acesso pelo celular (HABBLAUD_REMOTE_ALLOW precisa de messages).')
            : tr('Pedir pela TV precisa das mensagens pelo escritório: o plugin habblaud-mensagens (npm run mod:install).'),
        }),
      );
      return h('div', { class: 'ui-tv__panel' }, ...parts);
    }
    const agents = roomMains(this.ctx.store.snapshot?.agents ?? [], this.roomId ?? '');
    const reachable = agents.filter((a) => a.canMessage);
    if (!agents.length) {
      parts.push(h('p', { class: 'ui-tv__note', text: tr('Nenhum agente principal nesta sala agora para criar a apresentação.') }));
      return h('div', { class: 'ui-tv__panel' }, ...parts);
    }
    if (this.chosen && !reachable.some((a) => a.id === this.chosen)) this.chosen = null;
    if (!this.chosen && reachable.length === 1) this.chosen = reachable[0].id;
    parts.push(
      h('p', {
        class: 'ui-tv__note',
        text: tr('O agente cria uma apresentação sobre a última tarefa que concluiu: o que foi pedido, o que foi feito, antes e depois, decisões, riscos e próximos passos.'),
      }),
    );
    if (agents.length > 1) parts.push(h('p', { class: 'ui-tv__label', text: tr('Quem cria a apresentação?') }));
    const list = h('div', { class: 'ui-tv__agents', role: 'radiogroup', attrs: { 'aria-label': tr('Quem cria a apresentação?') } });
    for (const a of agents) {
      const ok = !!a.canMessage;
      const on = this.chosen === a.id;
      const btn = h(
        'button',
        {
          class: `ui-tv__agent${on ? ' is-on' : ''}`,
          type: 'button',
          role: 'radio',
          attrs: { 'aria-checked': String(on), disabled: !ok },
          on: {
            click: () => {
              this.chosen = a.id;
              this.paint();
            },
          },
        },
        createAvatar(a, 'sm'),
        h(
          'span',
          { class: 'ui-tv__agent-text' },
          h('strong', { text: a.name }),
          h('span', { text: ok ? (a.activity?.text ?? '') : tr('sem o plugin de mensagens nesta sessão') }),
        ),
      );
      list.append(btn);
    }
    parts.push(list);
    const send = h('button', {
      class: 'ui-btn ui-btn--primary ui-tv__cta',
      type: 'button',
      text: this.sending ? tr('Pedindo…') : tr('Pedir apresentação'),
      attrs: { disabled: !this.chosen || this.sending },
      on: { click: () => void this.request() },
    });
    parts.push(send);
    if (this.status) parts.push(h('p', { class: 'ui-tv__status', role: 'status', text: this.status }));
    if (this.list.length) parts.push(h('button', { class: 'ui-btn ui-tv__cta', type: 'button', text: tr('Ver as anteriores'), on: { click: () => this.show({ kind: 'list' }) } }));
    return h('div', { class: 'ui-tv__panel' }, ...parts);
  }

  private async request(): Promise<void> {
    if (!this.roomId || !this.chosen || this.sending) return;
    this.sending = true;
    this.status = '';
    this.paint();
    const agent = this.ctx.agent(this.chosen);
    try {
      await postJson('/api/presentations/request', { roomId: this.roomId, agentId: this.chosen });
      this.ctx.announce(tr('Pedido enviado para {0}.', [agent?.name ?? tr('o agente')]));
      this.status = tr('Pedido enviado para {0}. A TV acende e avisa quando a apresentação ficar pronta.', [agent?.name ?? tr('o agente')]);
    } catch (err) {
      this.status = tr('Não deu para pedir: {0}', [(err as Error).message]);
    } finally {
      this.sending = false;
      this.paint();
    }
  }

  // ---------------------------------------------------------------- navegação

  private step(delta: number, manual = false): void {
    const view = this.view;
    if (view.kind !== 'slides') return;
    if (manual) this.stopPlay();
    const next = Math.max(0, Math.min(view.slides.length - 1, view.index + delta));
    if (next === view.index) {
      if (!manual) this.stopPlay();
      return;
    }
    view.index = next;
    this.paintSlide();
  }

  private go(index: number): void {
    const view = this.view;
    if (view.kind !== 'slides') return;
    this.stopPlay();
    view.index = Math.max(0, Math.min(view.slides.length - 1, index));
    this.paintSlide();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.view.kind !== 'slides' || e.altKey || e.ctrlKey || e.metaKey) return;
    const onButton = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        this.step(1, true);
        break;
      case ' ':
        if (onButton) return;
        this.step(e.shiftKey ? -1 : 1, true);
        break;
      case 'ArrowLeft':
      case 'PageUp':
        this.step(-1, true);
        break;
      case 'Home':
        this.go(0);
        break;
      case 'End':
        this.go(this.view.slides.length - 1);
        break;
      case 'p':
      case 'P':
        this.togglePlay();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private onScreenClick(e: MouseEvent): void {
    if (this.view.kind !== 'slides') return;
    if (this.swiped) {
      this.swiped = false;
      return;
    }
    if ((e.target as Element).closest('a, button, pre, .ui-tv__table')) return;
    const box = this.screen.getBoundingClientRect();
    this.step(e.clientX - box.left < box.width * 0.3 ? -1 : 1, true);
  }

  // ---------------------------------------------------------------- modo automático

  private togglePlay(): void {
    if (this.view.kind !== 'slides') return;
    if (this.playing) this.stopPlay();
    else {
      // no último slide, o play recomeça do primeiro
      if (this.view.index === this.view.slides.length - 1) this.view.index = 0;
      this.playing = true;
      this.paintSlide();
    }
  }

  private stopPlay(): void {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncPlayButton();
    this.progress.style.transition = 'none';
    this.progress.style.width = '0';
  }

  /** Agenda o próximo slide (modo automático) e anima a barrinha de progresso. */
  private syncPlay(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncPlayButton();
    const view = this.view;
    this.progress.style.transition = 'none';
    this.progress.style.width = '0';
    if (!this.playing || view.kind !== 'slides') return;
    if (view.index >= view.slides.length - 1) {
      this.playing = false;
      this.syncPlayButton();
      return;
    }
    const ms = autoAdvanceMs(view.slides[view.index]);
    void this.progress.offsetWidth;
    this.progress.style.transition = `width ${ms}ms linear`;
    this.progress.style.width = '100%';
    this.timer = setTimeout(() => this.step(1), ms);
  }

  private syncPlayButton(): void {
    this.playBtn.innerHTML = this.playing ? PAUSE_ICON : PLAY_ICON;
    const label = this.playing ? tr('Pausar (P)') : tr('Passar sozinha (P)');
    setTitle(this.playBtn, label);
    setAttr(this.playBtn, 'aria-label', label);
    setAttr(this.playBtn, 'aria-pressed', String(this.playing));
  }

  // ---------------------------------------------------------------- snapshot

  render(): void {
    if (!this.el.open || !this.roomId) return;
    const room = this.room();
    if (!room) {
      this.el.close();
      return;
    }
    // lista e pedido acompanham a TV da sala: apresentação nova, preparo que começou ou acabou
    if (this.view.kind !== 'list' && this.view.kind !== 'request') return;
    const key = `${room.tv?.count ?? 0}|${room.tv?.title ?? ''}`;
    if (key !== this.listKey) {
      this.listKey = key;
      void this.loadList().then(() => this.paint(), () => undefined);
      return;
    }
    // só redesenha quando muda o que aparece (assim o foco não pula a cada snapshot)
    const agents = roomMains(this.ctx.store.snapshot?.agents ?? [], this.roomId).map((a) => `${a.id}:${a.canMessage ? 1 : 0}`);
    const paintKey = `${this.view.kind}|${room.tv?.state ?? ''}|${agents.join(',')}`;
    if (paintKey !== this.paintKey && !this.sending) {
      this.paintKey = paintKey;
      this.paint();
    }
  }

  private paintKey = '';
}
