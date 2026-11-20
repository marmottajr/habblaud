// Cartões de USO POR CONTA na barra superior: sessão de 5 horas e semanal, com reinício e origem dos números.
// Regras de apresentação:
// - número velho nunca passa por atual: janela que já renovou depois da leitura mostra "—" e "renovada";
//   números antigos ficam acinzentados com a idade ("há 6 d") no cabeçalho ou, no celular, um selo no chip;
// - o reinício vem com verbo implícito no ícone ↻ e contagem regressiva quando falta menos de um dia;
// - conta sem números diz "sem dados de uso" e oferece "Como ativar" (mod do Habblaud, recomendado).
// Conta do Codex: os números vêm dos arquivos de sessão dele, que só se renovam enquanto alguma sessão roda; por isso
// a idade ("há 12 min") fica sempre à mostra. Sem cota nem créditos ("sem cota") nunca vira 0%. Não há o que
// instalar para o uso: "Como funciona" abre a ajuda na seção do Codex. Sem Opus/Sonnet nem e-mail (só o plano).
// Conta do omp: o uso vem de `omp usage --json` para o provedor do modelo em uso (sem botão "Como ativar": não há o que
// instalar); provedor sem janelas de 5 h/7 d (Ollama) mostra "sem uso de 5 h e semana" e a nota do omp. O omp é
// multiprovedor: o botão "▾ N" do cartão abre a lista de todos os provedores dele, com todos os limites de cada um.
import type { AccountInfo, AccountUsage, OmpUsageLimit } from '../../../shared/types';
import type { UiContext } from './context';
import { h, iconButton, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { FIVE_HOURS_MS, providerLabel, relativeTime, usageLevel, usageWindowView, WEEK_MS, type UsageWindowView } from './format';
import { ICONS } from './icons';
import { isCodex, isOmp, PROVIDER_NAME, providerOf, showsProviderTag } from './provider';
import { usageRowFits } from './usage-row';
import { createAccountChip, createProviderTag, updateAccountChip, updateProviderTag } from './widgets';
import { tr } from '../../../shared/i18n';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: tr('cache do /usage do Claude Code'),
  statusline: tr('ao vivo (statusline do Claude Code)'),
  codex: tr('arquivos do Codex'),
  omp: tr('omp usage'),
};

/** Origem para mostrar: o arquivo ao vivo pode ter sido gravado pelo mod do Habblaud ou pelo tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return tr('ao vivo (mod do Habblaud)');
  if (u.source === 'omp') return u.ompProvider ? tr('omp usage ({0})', [u.ompProvider]) : tr('omp usage');
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * Como ligar o uso de uma conta, em ordem de preferência (dica do cartão e ajuda).
 * Trechos entre crases viram código (sem quebra de linha no meio do comando).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    tr('Recomendado: instala o mod do Habblaud no Claude Code (2.1.287 ou mais novo), que passa o uso de 5 h e da semana ao vivo. Rode na pasta do Habblaud, no computador onde o Claude Code roda; nas sessões já abertas, `/reload-plugins`.'),
  ],
  [
    'npm run usage:install',
    tr('No Claude Code anterior ao 2.1.287: liga um tap na linha de status, que passa os mesmos números ao vivo.'),
  ],
  ['/usage', tr('Sem instalar nada: rode `/usage` no Claude Code desta conta para atualizar o cache (os números envelhecem até a próxima vez).')],
];

/** Texto com trechos `assim` como código. */
export function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** O clique que fechou o painel (fora dele, no próprio botão) não o reabre. */
const REOPEN_GUARD_MS = 250;

/** Nome curto da janela de um limite: "5h", "Sem.", "30d"; "" sem duração. */
export function windowShort(ms: number | undefined): string {
  if (!ms) return '';
  if (ms === FIVE_HOURS_MS) return '5h';
  if (ms === WEEK_MS) return tr('Sem.');
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / HOUR_MS)}h`;
}

/** Rótulo do limite sem a janela, para agrupar: "Claude 7 Day (Fable)" -> "Claude (Fable)", "7 days" -> "". */
export function limitGroup(label: string): string {
  return label
    .replace(/\b\d+\s*(hours?|days?)\b/gi, '')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface OmpProviderView {
  key: string;
  /** "Anthropic"; com duas credenciais do mesmo provedor, "Anthropic (2)". */
  title: string;
  plan?: string;
  /** O provedor do modelo em uso (o das barras do cartão). */
  current: boolean;
  /** Limites agrupados pelo rótulo sem a janela, na ordem do omp. */
  groups: Array<{ label: string; limits: OmpUsageLimit[] }>;
  note?: string;
  fetchedAt: number;
}

/** Os provedores do omp de uma conta para o painel: o do modelo em uso primeiro, os outros na ordem do omp. */
export function ompProviderViews(u: AccountUsage | undefined): OmpProviderView[] {
  const list = u?.ompProviders ?? [];
  const total = new Map<string, number>();
  for (const p of list) total.set(p.provider, (total.get(p.provider) ?? 0) + 1);
  const seen = new Map<string, number>();
  let currentTaken = false;
  const views = list.map((p): OmpProviderView => {
    const n = (seen.get(p.provider) ?? 0) + 1;
    seen.set(p.provider, n);
    const groups: OmpProviderView['groups'] = [];
    for (const l of p.limits) {
      const label = limitGroup(l.label);
      const g = groups.find((x) => x.label === label);
      if (g) g.limits.push(l);
      else groups.push({ label, limits: [l] });
    }
    const current = !currentTaken && p.provider === u?.ompProvider;
    if (current) currentTaken = true;
    return {
      key: `${p.provider}#${n}`,
      title: (total.get(p.provider) ?? 0) > 1 ? `${providerLabel(p.provider)} (${n})` : providerLabel(p.provider),
      ...(p.plan ? { plan: p.plan } : {}),
      current,
      groups,
      ...(p.note ? { note: p.note } : {}),
      fetchedAt: p.fetchedAt,
    };
  });
  return [...views.filter((v) => v.current), ...views.filter((v) => !v.current)];
}

interface Meter {
  el: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  reset: HTMLElement;
  resetLong: HTMLElement;
  resetShort: HTMLElement;
}

interface CardRefs {
  chip: HTMLElement;
  flag: HTMLElement;
  name: HTMLElement;
  prov: HTMLElement;
  email: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  meters: HTMLElement;
  five: Meter;
  week: Meter;
  msg: HTMLElement;
  msgLong: HTMLElement;
  msgShort: HTMLElement;
  how: HTMLButtonElement;
  howLong: HTMLElement;
  howShort: HTMLElement;
  tip: HTMLElement;
  tipTitle: HTMLElement;
  tipRows: HTMLElement;
  tipNote: HTMLElement;
  tipSetup: HTMLElement;
  /** omp: "▾ N" abre o painel com todos os provedores. */
  provs: HTMLButtonElement;
}

let tipSeq = 0;

function createMeter(long: string, short: string, title: string): Meter {
  const bar = h('span', { class: 'ui-meter__bar' }, h('span', { class: 'ui-meter__fill' }));
  const pct = h('span', { class: 'ui-meter__pct' });
  const resetLong = h('span', { class: 'ui-meter__reset-long' });
  const resetShort = h('span', { class: 'ui-meter__reset-short' });
  const reset = h('span', { class: 'ui-meter__reset' }, resetLong, resetShort);
  const label = h(
    'span',
    { class: 'ui-meter__label' },
    h('span', { class: 'ui-meter__label-long', text: long }),
    h('span', { class: 'ui-meter__label-short', text: short, attrs: { 'aria-hidden': 'true' } }),
  );
  const el = h('div', { class: 'ui-meter', role: 'img', attrs: { 'aria-label': title } }, label, bar, pct, reset);
  return { el, bar, pct, reset, resetLong, resetShort };
}

function updateMeter(m: Meter, view: UsageWindowView | null, windowName: string): void {
  if (!view || view.pct === null) {
    setVariant(m.el, 'is-', 'none');
    m.el.classList.remove('is-zero');
    m.el.classList.toggle('is-renewed', !!view?.renewed);
    setStyleVar(m.bar, '--pct', '0');
    setText(m.pct, '—');
    setText(m.resetLong, view?.renewed ? tr('↻ renovada') : '');
    setText(m.resetShort, '');
    const text = view ? `${windowName}: ${view.summary}` : tr('{0}: sem dados', [windowName]);
    setAttr(m.el, 'aria-label', text);
    setTitle(m.el, view?.renewed ? tr('{0}: a janela já renovou depois da última leitura; o uso atual é desconhecido.', [windowName]) : text);
    return;
  }
  const p = view.pct;
  m.el.classList.remove('is-renewed');
  setVariant(m.el, 'is-', usageLevel(p));
  m.el.classList.toggle('is-zero', p === 0);
  setStyleVar(m.bar, '--pct', String(p));
  setText(m.pct, `${p}%`);
  setText(m.resetLong, view.reset ? `↻ ${view.reset}` : '');
  setText(m.resetShort, view.resetShort ? `↻${view.resetShort}` : '');
  setAttr(m.el, 'aria-label', `${windowName}: ${view.summary}`);
  setTitle(m.el, `${windowName}: ${view.summary}`);
}

function syncRows(dl: HTMLElement, rows: [string, string][]): void {
  while (dl.children.length > rows.length * 2) dl.lastElementChild!.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2] as HTMLElement | undefined;
    let dd = dl.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt || !dd) {
      dt = h('dt');
      dd = h('dd');
      dl.append(dt, dd);
    }
    setText(dt, k);
    setText(dd, v);
  });
}

/** Passo a passo para ligar o uso (dica do cartão e ajuda). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

/** ok/stale: números recentes/antigos; empty: sem números; noquota: Codex sem cota nem créditos (nunca 0%). */
export type CardState = 'ok' | 'stale' | 'empty' | 'noquota';

function hasWindows(a: Pick<AccountInfo, 'usage'>): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Estado efetivo do cartão. */
export function cardState(a: Pick<AccountInfo, 'usage' | 'usageStatus'>): CardState {
  // "Sem cota" vem antes: a leitura não traz janelas, mas não é "sem dados".
  if (a.usage?.noQuota) return 'noquota';
  // Leitura sem nenhuma das janelas (ex.: cache do /usage sem números) vale como "sem dados".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

/** A idade dos números fica sempre à mostra? (Codex: só se renovam enquanto alguma sessão roda.) */
export function showsUsageAge(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): boolean {
  if (!a.usage) return false;
  const state = cardState(a);
  return state === 'stale' || ((isCodex(a) || isOmp(a)) && state !== 'empty');
}

/** Linha embaixo do nome: e-mail; no Codex (sem e-mail), o plano; nas outras, a pasta. */
export function usageSubtitle(a: Pick<AccountInfo, 'email' | 'plan' | 'configDir' | 'provider'>): string {
  if (a.email) return a.email;
  if (isCodex(a)) return a.plan ? tr('plano {0}', [a.plan]) : 'Codex';
  return a.configDir;
}

/** Mensagem no lugar das barras (estados sem números): [longa, curta]. */
export function usageMessage(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): [string, string] {
  const state = cardState(a);
  if (state === 'noquota') return [tr('sem cota'), tr('sem cota')];
  if (isOmp(a)) return a.usage ? [tr('sem uso de 5 h e semana'), tr('sem uso')] : [tr('sem uso informado'), tr('sem uso')];
  if (isCodex(a)) return [tr('sem dados ainda'), tr('sem dados')];
  return [tr('sem dados de uso'), tr('sem dados')];
}

/** Explicação do cartão de uma conta do Codex (dica); '' nas outras. */
export function codexUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCodex(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty') return tr('Não precisa instalar nada: os números chegam com a próxima sessão do Codex.');
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  if (state === 'noquota')
    return tr('Na última leitura ({0}), a conta estava sem cota nem créditos para usar (ex.: os créditos do workspace acabaram). Não é 0%: o Codex não informou as janelas. Os números voltam com a próxima sessão.', [age]);
  return tr('O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura ({0}).', [age]);
}

/** Explicação do cartão de uma conta do omp (dica); '' nas outras. */
export function ompUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isOmp(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (!u) return tr('Ainda sem uso: o Habblaud consulta o "omp usage" a cada 5 min enquanto uma sessão do omp está aberta.');
  if (state === 'empty') {
    const prov = u.ompProvider ?? tr('o provedor');
    return u.note
      ? tr('{0} não informa uso de 5 h nem da semana ao omp: {1}', [prov, u.note])
      : tr('{0} não informa uso de 5 h nem da semana ao omp.', [prov]);
  }
  if (state === 'noquota') return tr('Na última leitura ({0}), o provedor {1} estava sem cota: não é 0%.', [relativeTime(u.fetchedAt, now), u.ompProvider ?? '']);
  return tr('Uso do provedor {0} (o do modelo em uso), lido do "omp usage" a cada 5 min com uma sessão aberta; esta leitura é de {1}.', [
    u.ompProvider ?? '',
    relativeTime(u.fetchedAt, now),
  ]);
}

export class UsageCards {
  readonly el: HTMLElement;
  private list: KeyedList<AccountInfo>;
  private refs = new WeakMap<HTMLElement, CardRefs>();
  /** Painel dos provedores do omp (um só, da conta em `openFor`). */
  private panel: HTMLElement;
  private panelTitle: HTMLElement;
  private panelBody: HTMLElement;
  private panelFoot: HTMLElement;
  private openFor: string | null = null;
  private opener: HTMLButtonElement | null = null;
  private closedAt = -Infinity;

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-usage', role: 'group', attrs: { 'aria-label': tr('Uso por conta') } });
    this.list = new KeyedList<AccountInfo>(this.el, {
      key: (a) => a.id,
      create: () => this.createCard(),
      update: (el, a) => this.updateCard(el, a),
    });
    // A largura da janela mudou: refaz a conta de cabem-ou-não (ver fit()).
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(ctx.root);

    this.panelTitle = h('h2');
    this.panelBody = h('div', { class: 'ui-omp-usage__list' });
    this.panelFoot = h('p', { class: 'ui-omp-usage__foot' });
    this.panel = h(
      'div',
      { class: 'ui-popover ui-omp-usage', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Provedores do omp'), popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, this.panelTitle, iconButton(ICONS.close, tr('Fechar'), () => this.hidePanel(), 'ui-icon-btn--sm')),
      this.panelBody,
      this.panelFoot,
    );
    this.panel.addEventListener('toggle', () => {
      if (this.panelOpen) return;
      this.closedAt = performance.now();
      if (this.opener) setAttr(this.opener, 'aria-expanded', 'false');
      this.openFor = this.opener = null;
    });
    ctx.root.append(this.panel);
  }

  private get panelOpen(): boolean {
    return this.panel.matches(':popover-open') || this.panel.classList.contains('is-open');
  }

  private togglePanel(btn: HTMLButtonElement, card: HTMLElement): void {
    const id = card.dataset.acc ?? '';
    if (this.panelOpen) {
      const same = this.openFor === id;
      this.hidePanel();
      if (same) return;
    } else if (performance.now() - this.closedAt < REOPEN_GUARD_MS) return;
    const account = this.ctx.store.snapshot?.accounts.find((a) => a.id === id);
    if (!account) return;
    const r = btn.getBoundingClientRect();
    this.panel.style.top = `${Math.round(r.bottom + 8)}px`;
    this.panel.style.left = `${Math.max(8, Math.min(Math.round(r.left - 12), innerWidth - 8 - Math.min(360, innerWidth - 16)))}px`;
    this.openFor = id;
    this.opener = btn;
    this.renderPanel(account);
    if (typeof this.panel.showPopover === 'function') this.panel.showPopover();
    else this.panel.classList.add('is-open');
    setAttr(btn, 'aria-expanded', 'true');
    this.panel.focus();
  }

  private hidePanel(): void {
    if (typeof this.panel.hidePopover === 'function' && this.panel.matches(':popover-open')) this.panel.hidePopover();
    this.panel.classList.remove('is-open');
    if (this.opener) setAttr(this.opener, 'aria-expanded', 'false');
    this.openFor = this.opener = null;
  }

  /** Todos os provedores do omp da conta, cada um com os limites agrupados (refeito a cada snapshot com o painel aberto). */
  private renderPanel(a: AccountInfo): void {
    const now = this.ctx.now();
    const views = ompProviderViews(a.usage);
    setText(this.panelTitle, tr('Provedores do omp · {0}', [a.name]));
    this.panelBody.replaceChildren(
      ...views.map((v) => {
        const head = h(
          'div',
          { class: 'ui-omp-usage__head' },
          h('strong', { text: v.title }),
          v.plan ? h('span', { class: 'ui-omp-usage__chip', text: tr('plano {0}', [v.plan]) }) : '',
          v.current ? h('span', { class: 'ui-omp-usage__chip is-current', text: tr('em uso'), title: tr('Provedor do modelo em uso: o das barras do cartão') }) : '',
        );
        const groups = v.groups.map((g) => {
          const meters = h('div', { class: 'ui-usage-card__meters ui-omp-usage__meters' });
          for (const l of g.limits) {
            const short = windowShort(l.windowMs);
            const name = g.label ? `${g.label}${short ? ` · ${short}` : ''}` : short || l.label;
            const m = createMeter(short || '—', short || '—', name);
            const view = l.utilization === undefined ? null : usageWindowView({ utilization: l.utilization, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) }, v.fetchedAt, now, l.windowMs ?? Number.POSITIVE_INFINITY);
            updateMeter(m, view, name);
            if (l.exhausted) m.el.classList.add('is-exhausted');
            meters.append(m.el);
          }
          return h('div', { class: 'ui-omp-usage__group' }, g.label ? h('div', { class: 'ui-omp-usage__label', text: g.label }) : '', meters);
        });
        const note = v.note ? h('p', { class: 'ui-omp-usage__note', text: v.note }) : !v.groups.length ? h('p', { class: 'ui-omp-usage__note', text: tr('O omp não informa limites deste provedor.') }) : '';
        return h('section', { class: `ui-omp-usage__prov${v.current ? ' is-current' : ''}` }, head, ...groups, note);
      }),
    );
    setText(this.panelFoot, a.usage ? tr('Lido do "omp usage" {0}; atualiza a cada 5 min com uma sessão do omp aberta.', [relativeTime(a.usage.fetchedAt, now)]) : '');
  }

  render(): void {
    // Toda conta ganha cartão; a do omp mostra o uso do provedor do modelo em uso (omp usage), ver updateTip().
    const accounts = this.ctx.store.snapshot?.accounts ?? [];
    this.list.sync(accounts);
    this.el.classList.toggle('is-empty', accounts.length === 0);
    setStyleVar(this.el, '--count', String(accounts.length));
    // Medir força o layout da página, e o render roda a cada quadro no replay: só quando as contas mudam (a largura da
    // janela fica com o ResizeObserver do construtor).
    const key = accounts.map((a) => a.id).join('|');
    if (key !== this.fitKey) {
      this.fitKey = key;
      this.fit();
    }
  }

  /** Contas da última medida em fit() (ver render). */
  private fitKey = '';

  /**
   * Os cartões não cabem na linha da barra (muitas contas ou janela estreita)? Então vão para uma segunda linha
   * (`has-usage-row` na raiz, regras em styles.css). Só conta os tamanhos mínimos, que não dependem de a fila estar
   * numa linha ou na outra, então o resultado não oscila. No celular a barra já tem duas linhas (bloco próprio do CSS).
   */
  private fit(): void {
    const bar = this.el.parentElement;
    if (!bar) return;
    if (window.matchMedia('(max-width: 600px)').matches) {
      this.ctx.root.classList.remove('has-usage-row');
      return;
    }
    const barStyle = getComputedStyle(bar);
    const px = (v: string) => Number.parseFloat(v) || 0;
    // Largura natural dos outros itens (scrollWidth): na linha única eles encolhem, na linha de baixo não, e a
    // decisão não pode depender de em qual dos dois estados a barra está.
    const others = [...bar.children]
      .filter((c) => c !== this.el && getComputedStyle(c).display !== 'none')
      .map((c) => Math.max((c as HTMLElement).offsetWidth, c.scrollWidth));
    const fits = usageRowFits({
      barWidth: bar.clientWidth - px(barStyle.paddingLeft) - px(barStyle.paddingRight),
      others,
      gap: px(barStyle.columnGap),
      cardGap: px(getComputedStyle(this.el).columnGap),
      cards: [...this.el.children].map((c) => px(getComputedStyle(c).minWidth)),
    });
    this.ctx.root.classList.toggle('has-usage-row', !fits);
  }

  private createCard(): HTMLElement {
    const tipId = `ui-usage-tip-${++tipSeq}`;
    const chip = createAccountChip('lg');
    const flag = h('span', { class: 'ui-usage-card__flag', hidden: true, attrs: { 'aria-hidden': 'true' } });
    flag.innerHTML = ICONS.clock;
    const name = h('span', { class: 'ui-usage-card__name' });
    const prov = createProviderTag('ui-prov--xs');
    const email = h('span', { class: 'ui-usage-card__email' });
    const stateIcon = h('span', { class: 'ui-usage-card__state-icon', attrs: { 'aria-hidden': 'true' } });
    stateIcon.innerHTML = ICONS.clock;
    const stateText = h('span');
    const state = h('span', { class: 'ui-usage-card__state' }, stateIcon, stateText);
    const provs = h('button', {
      class: 'ui-usage-card__provs',
      type: 'button',
      hidden: true,
      attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      on: {
        click: (e) => {
          e.stopPropagation();
          const card = provs.closest<HTMLElement>('.ui-usage-card');
          if (card) this.togglePanel(provs, card);
        },
      },
    });
    const five = createMeter('5h', '5h', tr('Sessão de 5 horas'));
    const week = createMeter(tr('Semana'), tr('Sem.'), tr('Limite semanal'));
    const meters = h('div', { class: 'ui-usage-card__meters' }, five.el, week.el);
    const msgLong = h('span', { class: 'ui-usage-card__msg-long', text: tr('sem dados de uso') });
    const msgShort = h('span', { class: 'ui-usage-card__msg-short', text: tr('sem dados'), attrs: { 'aria-hidden': 'true' } });
    const howLong = h('span', { class: 'ui-usage-card__how-long', text: tr('Como ativar') });
    const howShort = h('span', { class: 'ui-usage-card__how-short', text: tr('Ativar'), attrs: { 'aria-hidden': 'true' } });
    const howBtn = h(
      'button',
      {
        class: 'ui-usage-card__how',
        type: 'button',
        title: tr('Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)'),
        on: { click: () => this.ctx.openHelp(howBtn.dataset.help === 'codex' ? 'codex' : 'usage') },
      },
      howLong,
      howShort,
    );
    const msg = h('div', { class: 'ui-usage-card__msg' }, h('span', { class: 'ui-usage-card__msg-text' }, msgLong, msgShort), howBtn);
    const tipTitle = h('div', { class: 'ui-usage-tip__title' });
    const tipRows = h('dl', { class: 'ui-kv' });
    const tipNote = h('p', { class: 'ui-usage-tip__note' });
    const tipSetup = h('div', { class: 'ui-usage-tip__setup' }, h('p', { class: 'ui-usage-tip__setup-title', text: tr('Como ter o uso ao vivo') }), createUsageSetup());
    const tip = h('div', { class: 'ui-usage-tip', role: 'tooltip', attrs: { id: tipId } }, tipTitle, tipRows, tipNote, tipSetup);
    const card = h(
      'div',
      { class: 'ui-usage-card', tabIndex: 0, attrs: { 'aria-describedby': tipId } },
      chip,
      flag,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, name, prov, email, state, provs), meters, msg),
      tip,
    );
    this.refs.set(card, {
      chip,
      flag,
      name,
      prov,
      email,
      state,
      stateText,
      meters,
      five,
      week,
      msg,
      msgLong,
      msgShort,
      how: howBtn,
      howLong,
      howShort,
      tip,
      tipTitle,
      tipRows,
      tipNote,
      tipSetup,
      provs,
    });
    return card;
  }

  private updateCard(card: HTMLElement, a: AccountInfo): void {
    const r = this.refs.get(card)!;
    const now = this.ctx.now();
    const codex = isCodex(a);
    const provider = providerOf(a);
    const omp = isOmp(a);
    updateAccountChip(r.chip, a);
    setStyleVar(card, '--acc', a.color);
    setText(r.name, a.name);
    updateProviderTag(r.prov, provider, a.name);
    setText(r.email, usageSubtitle(a));
    card.dataset.acc = a.id;
    // omp: "▾ N" com mais de um provedor (ou limites além das duas barras); o painel aberto acompanha o snapshot.
    const views = omp ? ompProviderViews(a.usage) : [];
    const extra = views.length > 1 || views.some((v) => v.groups.reduce((n, g) => n + g.limits.length, 0) > 2);
    setHidden(r.provs, !extra);
    if (extra) {
      setText(r.provs, `${views.length} ▾`);
      setTitle(r.provs, tr('Ver todos os provedores do omp ({0}) e os limites de cada um', [views.length]));
      setAttr(r.provs, 'aria-label', tr('Provedores do omp: {0}', [views.length]));
    }
    if (this.openFor === a.id && this.panelOpen) this.renderPanel(a);
    setAttr(card, 'aria-label', tr('{0}{1}: uso do plano', [a.name, provider === 'claude' ? '' : ` (${PROVIDER_NAME[provider]})`]));

    const usage = a.usage;
    const state = cardState(a);
    setVariant(card, 'is-', state);
    const five = usage ? usageWindowView(usage.fiveHour, usage.fetchedAt, now, FIVE_HOURS_MS) : null;
    const week = usage ? usageWindowView(usage.sevenDay, usage.fetchedAt, now, WEEK_MS) : null;
    const showMeters = hasWindows(a);
    setHidden(r.meters, !showMeters);
    if (usage && showMeters) {
      updateMeter(r.five, five, tr('Sessão de 5 horas'));
      updateMeter(r.week, week, tr('Semana'));
    }
    r.meters.classList.toggle('is-dim', state !== 'ok');

    // Idade dos números antigos no cabeçalho (no celular, um selo no chip faz esse papel). No Codex a idade fica
    // sempre à mostra (os números só se renovam enquanto alguma sessão roda), discreta enquanto são recentes.
    const stale = state === 'stale';
    const showAge = showsUsageAge(a);
    setHidden(r.state, !showAge);
    setHidden(r.flag, !stale);
    r.state.classList.toggle('is-fresh', showAge && a.usageStatus === 'ok');
    if (showAge && usage) {
      const age = relativeTime(usage.fetchedAt, now);
      setText(r.stateText, age);
      setTitle(
        r.state,
        codex
          ? tr('Atualizado {0}: o Codex só grava o uso enquanto alguma sessão roda.', [age])
          : omp
            ? tr('Atualizado {0}: o omp usage é lido a cada 5 min enquanto uma sessão do omp está aberta.', [age])
            : tr('Números de {0}: podem não refletir o uso atual.', [age]),
      );
    }

    // Sem números: "sem dados de uso" + "Como ativar" (no Codex, "Como funciona": não há o que instalar). Sem cota:
    // a mensagem, sem botão. No omp, sem botão (o uso chega sozinho pelo omp usage).
    const [msgLong, msgShort] = usageMessage(a);
    setText(r.msgLong, msgLong);
    setText(r.msgShort, msgShort);
    setHidden(r.msg, state !== 'empty' && state !== 'noquota');
    setHidden(r.how, state === 'noquota' || omp);
    r.msg.classList.toggle('is-noquota', state === 'noquota');
    setTitle(r.msg, state === 'noquota' ? (omp ? ompUsageNote(a, now) : codexUsageNote(a, now)) : '');
    setText(r.howLong, codex ? tr('Como funciona') : tr('Como ativar'));
    setText(r.howShort, codex ? tr('Saber') : tr('Ativar'));
    r.how.dataset.help = codex ? 'codex' : 'usage';
    setTitle(r.how, codex ? tr('Como o uso do Codex chega ao Habblaud (abre a ajuda em “Codex”)') : tr('Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)'));
    this.updateTip(r, a, state, five, week, now);
  }

  private updateTip(r: CardRefs, a: AccountInfo, state: CardState, five: UsageWindowView | null, week: UsageWindowView | null, now: number): void {
    const codex = isCodex(a);
    const provider = providerOf(a);
    const omp = isOmp(a);
    const u = a.usage;
    setText(r.tipTitle, `${a.name}${showsProviderTag(provider, a.name) ? ` · ${PROVIDER_NAME[provider]}` : ''}${a.plan ? tr(' · plano {0}', [a.plan]) : ''}`);
    const rows: [string, string][] = [];
    if (provider !== 'claude') rows.push([tr('Ferramenta'), PROVIDER_NAME[provider]]);
    if (omp && u?.ompProvider) rows.push([tr('Provedor'), u.ompProvider]);
    if (a.email) rows.push(['E-mail', a.email]);
    if (a.organization) rows.push([tr('Organização'), a.organization]);
    if (a.plan) rows.push([tr('Plano'), a.plan]);
    rows.push([tr('Pasta'), a.configDir]);
    rows.push([tr('Sessões abertas'), String(a.sessions)]);
    if (u && (u.fiveHour || u.sevenDay)) {
      rows.push([tr('Sessão de 5 h'), five?.summary ?? '—']);
      rows.push([tr('Semana'), week?.summary ?? '—']);
      // Opus e Sonnet são janelas do Claude: no Codex e no omp não existem.
      const opus = codex || omp ? null : usageWindowView(u.sevenDayOpus, u.fetchedAt, now, WEEK_MS);
      const sonnet = codex || omp ? null : usageWindowView(u.sevenDaySonnet, u.fetchedAt, now, WEEK_MS);
      if (opus) rows.push([tr('Opus (semana)'), opus.summary]);
      if (sonnet) rows.push([tr('Sonnet (semana)'), sonnet.summary]);
    }
    if (u && state === 'noquota') rows.push([tr('Cota'), tr('sem cota nem créditos agora')]);
    if (u && (state !== 'empty' || codex || omp)) {
      rows.push([tr('Origem'), sourceLabel(u)]);
      rows.push([tr('Atualizado'), relativeTime(u.fetchedAt, now)]);
    }
    syncRows(r.tipRows, rows);

    // omp: a explicação dele, sem o passo a passo do Claude Code (o uso chega pelo omp usage).
    if (omp) {
      const note = ompUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      setHidden(r.tipSetup, true);
      return;
    }

    // Codex: a explicação dele, sem o passo a passo do Claude Code (não há o que instalar para o uso).
    if (codex) {
      const note = codexUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      setHidden(r.tipSetup, true);
      return;
    }

    let note = '';
    if (state === 'empty')
      note = u ? tr('A última leitura ({0}, {1}) não trouxe números de 5 h nem da semana.', [sourceLabel(u), relativeTime(u.fetchedAt, now)]) : tr('Ainda não há números de uso para esta conta.');
    else if (state === 'stale') note = tr('Números antigos: refletem a última leitura, não o uso de agora.');
    else if (u?.source === 'cache') note = tr('Cache do /usage: atualiza quando alguém roda /usage nesta conta.');
    else if (five?.renewed || week?.renewed) note = tr('Uma das janelas já reiniciou depois da última leitura.');
    setText(r.tipNote, note);
    setHidden(r.tipNote, !note);
    // O passo a passo aparece sempre que os números não são ao vivo.
    const live = u?.source === 'statusline' && state === 'ok';
    setHidden(r.tipSetup, live);
  }
}
