// Do aviso do escritório para a notificação no aparelho: só o nome do agente, nunca o motivo.
//
// Um aviso do escritório leva o texto inteiro ("✋ Ana 2 precisa de você em projeto-x: apagar a pasta dist"). Esse
// texto aparece na tela de bloqueio de um telefone que anda na rua, por isso nada dele entra aqui: a notificação é
// montada a partir do nome do agente e de mais nada. `noticePush` é a única porta entre os dois mundos.
import type { Notice } from '../../shared/types';
import { tr } from '../../shared/i18n';

/** Tipo que o Habblaud registra por padrão: alguém precisa de você. */
export const NEEDS_YOU = 'needs-you';

export interface NoticePush {
  title: string;
  /** Caminho da própria origem; `?agent=` já é reconhecido ao carregar a página (client/src/ui/index.ts). */
  url: string;
  /** Agrupa o freio de 60 s: por agente, não por aviso. */
  key: string;
}

/**
 * A notificação de um aviso, ou undefined quando o aviso não merece push. Só nível `alert` (um agente que precisa de
 * resposta: `office.ts` o emite quando um agente passa a `waiting` e quando chega um pedido de permissão ou pergunta).
 */
export function noticePush(notice: Notice, nameOf: (agentId: string) => string | undefined): NoticePush | undefined {
  if (notice.level !== 'alert') return undefined;
  const name = (notice.agentId ? nameOf(notice.agentId) : undefined)?.trim();
  return {
    // Molde fechado. Nada de `notice.text`, nada de `notice.roomId`.
    title: name ? tr('{0} precisa de você', [name]) : tr('Um agente precisa de você'),
    url: notice.agentId ? `/?app=1&agent=${encodeURIComponent(notice.agentId)}` : '/?app=1',
    key: notice.agentId ?? 'sem-agente',
  };
}
