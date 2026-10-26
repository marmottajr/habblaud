// As travas da seção do Habblaud World. Fica fora de settings-world.ts para o chip, os avisos e a troca de cena
// consultarem o modo sem puxar a janela inteira para o bundle principal.
import { access } from '../../net/access';
import type { WorldSource } from '../../net/world';
import type { UiContext } from '../context';
import type { WorldGate } from './world-model';

/** As travas da seção nesta página (celular, endereço local, trava do terminal, modo demonstração). */
export function worldGate(ctx: UiContext, src: WorldSource): WorldGate {
  const a = access();
  return { remote: a.remote, local: a.local, terminal: !!ctx.store.liveSnapshot?.meta.terminal, fake: src.fake };
}
