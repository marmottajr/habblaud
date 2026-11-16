// Botão "Festa no escritório" da barra superior (POST/DELETE /api/party; shared/party.ts): começa a festa na sala com
// mais agentes (todos os personagens vão comemorar lá por ~2 min, ver world/sim/party.ts) e, com a festa em
// andamento, encerra antes da hora. Aparece para quem pode (AccessInfo.party: o próprio computador ou o celular com login,
// menos com HABBLAUD_REMOTE_ALLOW=none), celular inclusive: cabe na barra até em 320 px.
import type { Notice } from '../../../shared/types';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { iconButton, setAttr, setHidden, setTitle } from './dom';
import { pixelIcon } from './icons';
import { tr } from '../../../shared/i18n';

/** Língua de sogra soltando confete, no traço dos outros ícones da barra. */
const PARTY_ICON = pixelIcon(['......#..#', '..#.......', '.....##.#.', '....###...', '...####.#.', '..####....', '.###..#...', '##........', '#...#.....', '..........']);

export class PartyButton implements UiComponent {
  readonly button: HTMLButtonElement;
  private busy = false;

  constructor(
    private readonly ctx: UiContext,
    private readonly toast: (n: Notice) => void,
  ) {
    this.button = iconButton(PARTY_ICON, tr('Festa no escritório: todos os personagens comemoram juntos numa sala'), () => void this.toggle(), 'ui-btn-party');
    this.button.hidden = true;
  }

  /** Festa em andamento, segundo o último snapshot. */
  private active(): boolean {
    const snap = this.ctx.store.snapshot;
    return !!snap?.party && snap.party.until > snap.serverTime;
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const ending = this.active();
    try {
      const err = ending ? await this.ctx.store.endParty() : await this.ctx.store.startParty();
      if (err) this.toast({ id: `party-${Date.now()}`, level: 'warn', text: err, at: Date.now() });
      else this.ctx.announce(ending ? tr('Festa encerrada.') : tr('Festa começando!'));
    } finally {
      this.busy = false;
    }
  }

  render(): void {
    const { store } = this.ctx;
    setHidden(this.button, !(store.mock || access().party) || store.replaying);
    const on = this.active();
    setAttr(this.button, 'aria-pressed', String(on));
    const label = on ? tr('Encerrar a festa no escritório') : tr('Festa no escritório: todos os personagens comemoram juntos numa sala');
    setTitle(this.button, label);
    setAttr(this.button, 'aria-label', label);
  }
}
