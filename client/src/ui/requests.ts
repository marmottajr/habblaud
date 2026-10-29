// Pedidos externos (server/requests/): um serviço local (um painel de decisões, um script) pergunta com opções e o
// escritório mostra o cartão no canto superior direito, um pedido por vez (‹ › passa para os outros). A opção
// recomendada vem marcada com ★. Escolher manda POST /api/requests/:id/decision; o pedido some do snapshot quando é
// escolhido, retirado pelo serviço ou expira. Responder segue a mesma trava das permissões (net/access.ts).
import { access } from '../net/access';
import type { ExternalRequestInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { formatClock, formatDuration } from './format';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

/** O pedido à mostra: o atual, se ainda estiver na lista; senão o mais antigo. */
export function currentRequest(list: readonly ExternalRequestInfo[], currentId: string): ExternalRequestInfo | undefined {
  return list.find((r) => r.id === currentId) ?? list[0];
}

/** Pedido vizinho na lista (`step` = 1 ou -1), dando a volta nas pontas. */
export function stepRequest(list: readonly ExternalRequestInfo[], currentId: string, step: number): ExternalRequestInfo | undefined {
  if (!list.length) return undefined;
  const i = Math.max(0, list.findIndex((r) => r.id === currentId));
  return list[(i + step + list.length) % list.length];
}

/** "expira em 3 h" */
export function requestExpiryText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return tr('expirando…');
  if (left < 60_000) return tr('expira em menos de 1 min');
  return tr('expira em {0}', [formatDuration(left)]);
}

/** Opções na ordem do serviço, com a recomendada primeiro. */
export function orderedOptions(r: Pick<ExternalRequestInfo, 'options' | 'recommended'>): ExternalRequestInfo['options'] {
  const rec = r.options.find((o) => o.id === r.recommended);
  return rec ? [rec, ...r.options.filter((o) => o !== rec)] : [...r.options];
}

type Phase = 'idle' | 'sending' | 'sent';

export class ExternalRequests implements UiComponent {
  readonly el: HTMLElement;
  private id = '';
  private phase: Phase = 'idle';
  private source: HTMLElement;
  private count: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private timer: HTMLElement;
  private title: HTMLElement;
  private text: HTMLElement;
  private options: HTMLElement;
  private remote: HTMLElement;
  private status: HTMLElement;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-perm__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.help;
    this.source = h('strong', { class: 'ui-perm__title' });
    this.count = h('span', { class: 'ui-ext__count' });
    this.prevBtn = h('button', { class: 'ui-btn ui-ext__nav', type: 'button', text: '‹', title: tr('Pedido anterior'), attrs: { 'aria-label': tr('Pedido anterior') }, on: { click: () => this.step(-1) } });
    this.nextBtn = h('button', { class: 'ui-btn ui-ext__nav', type: 'button', text: '›', title: tr('Próximo pedido'), attrs: { 'aria-label': tr('Próximo pedido') }, on: { click: () => this.step(1) } });
    this.timer = h('span', { class: 'ui-perm__timer' });
    this.title = h('p', { class: 'ui-ext__title' });
    this.text = h('p', { class: 'ui-ext__text' });
    this.options = h('div', { class: 'ui-ext__options', role: 'group', attrs: { 'aria-label': tr('Opções') } });
    this.remote = h('p', { class: 'ui-perm__note', hidden: true, text: tr('Para escolher por aqui, abra o Habblaud por http://localhost (ou 127.0.0.1).') });
    this.status = h('p', { class: 'ui-perm__status', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'section',
      { class: 'ui-perm ui-ext', hidden: true, attrs: { 'aria-label': tr('Pedido externo') } },
      h(
        'div',
        { class: 'ui-perm__head' },
        icon,
        h('div', { class: 'ui-perm__head-text' }, this.source, this.timer),
        h('div', { class: 'ui-ext__pager' }, this.prevBtn, this.count, this.nextBtn),
      ),
      this.title,
      this.text,
      this.options,
      this.remote,
      this.status,
    );
  }

  render(): void {
    const list = this.ctx.store.snapshot?.requests ?? [];
    const r = currentRequest(list, this.id);
    setHidden(this.el, !r);
    if (!r) return void this.reset('');
    if (r.id !== this.id) this.reset(r.id);
    const now = this.ctx.now();
    setText(this.source, tr('Pedido de {0}', [r.source]));
    setText(this.timer, requestExpiryText(r.expiresAt, now));
    setTitle(this.timer, tr('Pedido feito às {0}. Sem escolha até {1}, ele expira.', [formatClock(r.createdAt), formatClock(r.expiresAt)]));
    const pos = list.indexOf(r) + 1;
    setText(this.count, tr('{0} de {1}', [pos, list.length]));
    for (const b of [this.prevBtn, this.nextBtn]) setHidden(b, list.length < 2);
    setHidden(this.count, list.length < 2);
    setText(this.title, r.title);
    setText(this.text, r.text ?? '');
    setHidden(this.text, !r.text);
    if (this.options.dataset.id !== r.id) {
      this.options.dataset.id = r.id;
      this.options.replaceChildren(
        ...orderedOptions(r).map((o) => {
          const rec = o.id === r.recommended;
          return h(
            'button',
            {
              class: `ui-btn ui-perm__btn ui-ext__opt${rec ? ' ui-perm__btn--allow' : ''}`,
              type: 'button',
              title: rec ? tr('Opção recomendada') : '',
              on: { click: () => void this.send(o.id, o.label) },
            },
            h('strong', { text: rec ? `★ ${o.label}` : o.label }),
            o.description ? h('span', { class: 'ui-ext__desc', text: o.description }) : null,
          );
        }),
      );
    }
    const local = access().permissions;
    setHidden(this.remote, local);
    const busy = this.phase !== 'idle' || !local;
    for (const b of this.options.querySelectorAll('button')) b.disabled = busy;
    setAttr(this.el, 'data-source', r.source);
  }

  private reset(id: string): void {
    if (id === this.id) return;
    this.id = id;
    this.phase = 'idle';
    setText(this.status, '');
    this.status.classList.remove('is-error');
  }

  private step(n: number): void {
    const next = stepRequest(this.ctx.store.snapshot?.requests ?? [], this.id, n);
    if (next) this.reset(next.id);
    this.ctx.invalidate();
  }

  private async send(option: string, label: string): Promise<void> {
    const id = this.id;
    if (!id || this.phase !== 'idle') return;
    this.phase = 'sending';
    this.status.classList.remove('is-error');
    setText(this.status, tr('Enviando a resposta…'));
    this.ctx.invalidate();
    let error: string | undefined;
    try {
      error = await this.ctx.store.decideRequest(id, option);
    } catch {
      error = tr('Não foi possível falar com o Habblaud.');
    }
    if (this.id !== id) return;
    if (error) {
      this.phase = 'idle';
      this.status.classList.add('is-error');
      setText(this.status, error);
    } else {
      this.phase = 'sent';
      setText(this.status, tr('Escolhido: {0}.', [label]));
      this.ctx.announce(tr('Escolhido: {0}.', [label]));
    }
    this.ctx.invalidate();
  }
}
