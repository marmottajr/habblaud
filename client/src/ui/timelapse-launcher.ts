// Timelapse do dia. O player (ui/timelapse.ts, com a linha do tempo e o replay) fica num pedaço separado do
// bundle e só é baixado na primeira abertura; até lá, `replayTime` é nulo e o escritório segue no relógio normal.
import type { UiComponent, UiContext } from './context';
import type { TimelapsePlayer } from './timelapse';
import { tr } from '../../../shared/i18n';

export class TimelapseLauncher implements UiComponent {
  private player: TimelapsePlayer | null = null;
  private loading: Promise<TimelapsePlayer> | null = null;

  /** `mount` coloca vinheta, barra e selo do player na interface quando ele é criado. */
  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (p: TimelapsePlayer) => void,
  ) {}

  get isOpen(): boolean {
    return this.player?.isOpen ?? false;
  }

  get replayTime(): number | null {
    return this.player?.replayTime ?? null;
  }

  toggle(): void {
    if (this.player) this.player.toggle();
    else
      void this.load()
        .then((p) => p.toggle())
        .catch(() => this.ctx.announce(tr('Não foi possível abrir o timelapse.')));
  }

  close(): void {
    this.player?.close();
  }

  render(): void {
    this.player?.render();
  }

  private load(): Promise<TimelapsePlayer> {
    this.loading ??= import('./timelapse').then((m) => {
      const player = new m.TimelapsePlayer(this.ctx);
      this.mount(player);
      this.player = player;
      return player;
    });
    // Falhou (rede caiu no meio do download): a próxima tentativa baixa de novo.
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }
}
