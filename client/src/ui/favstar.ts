// Estrela de favoritar sessão (gaveta e terminal): liga/desliga na mesma lista "Favoritas" do Histórico (favorites.ts).
import type { AgentInfo, RecentSession } from '../../../shared/types';
import type { UiContext } from './context';
import { iconButton, setAttr, setHidden, setTitle } from './dom';
import { agentSession, favorites, sessionKey } from './favorites';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

/** Retrato da sessão do agente para a estrela (null: subagente ou demo, sem estrela). */
export function favoriteSessionOf(ctx: UiContext, a: AgentInfo): RecentSession | null {
  const snap = ctx.store.snapshot;
  return agentSession(a, ctx.store.room(a.roomId), ctx.store.mock || !!snap?.meta.demo);
}

/** A sessão que a estrela liga/desliga agora (a estrela vive em linhas reaproveitadas). */
const starTarget = new WeakMap<HTMLElement, RecentSession>();

/** Estrela de favoritar a sessão: a mesma lista "Favoritas" do Histórico. Não seleciona a linha em que está. */
export function createFavStar(extraClass = ''): HTMLButtonElement {
  const b = iconButton(ICONS.star, tr('Favoritar sessão'), (ev) => {
    ev.stopPropagation();
    const s = starTarget.get(b);
    if (s) favorites.toggle(s);
  }, `ui-fav-star ${extraClass}`.trim());
  setHidden(b, true);
  return b;
}

export function updateFavStar(b: HTMLButtonElement, s: RecentSession | null): void {
  setHidden(b, !s);
  if (!s) {
    starTarget.delete(b);
    return;
  }
  starTarget.set(b, s);
  const on = favorites.has(sessionKey(s));
  const label = on ? tr('Tirar dos favoritos') : tr('Favoritar sessão');
  if (b.dataset.on !== String(on)) {
    b.dataset.on = String(on);
    b.innerHTML = on ? ICONS.starFilled : ICONS.star;
  }
  b.classList.toggle('is-on', on);
  setAttr(b, 'aria-pressed', String(on));
  setAttr(b, 'aria-label', label);
  setTitle(b, label);
}
