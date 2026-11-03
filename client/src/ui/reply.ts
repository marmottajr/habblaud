// Caixa de resposta a uma pergunta de fim de turno (AgentInfo.reply): o resumo, a pergunta e os botões que o agente
// ofereceu. Clicar manda o texto do botão pela caixa de mensagem (ui/composer.ts), como se você o tivesse digitado —
// não é um pedido de permissão (ui/permission.ts), a sessão não fica presa esperando.
// Aparece no rodapé do terminal e na gaveta do agente, sempre logo acima da caixa de mensagem, que mostra a entrega.
// Ação do próprio app do Claude Code (commit, abrir PR...) vira um botão desligado: só de lá dá para fazer.
import type { Activity, AgentInfo, PendingReply, ReplyOption } from '../../../shared/types';
import type { MessageComposer } from './composer';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { tr } from '../../../shared/i18n';

/** A pergunta vale enquanto a sessão está no escritório: encerrada, não há a quem responder. */
export function pendingReply(agent: AgentInfo | undefined): PendingReply | undefined {
  if (!agent || agent.kind !== 'main' || agent.status === 'offline' || agent.status === 'done') return undefined;
  return agent.reply;
}

/**
 * A pergunta como uma linha de atividade ("❓ Commito essa mudança?"), para a barra lateral mostrar o que o agente
 * está esperando no lugar da última coisa que ele fez ("Escrevendo a resposta"). Só com o turno terminado.
 */
export function replyActivity(agent: AgentInfo | undefined): Activity | undefined {
  const r = agent?.status === 'idle' ? pendingReply(agent) : undefined;
  if (!r) return undefined;
  return { id: r.id, kind: 'ask', icon: '❓', text: r.ask, at: r.at, ...(r.recap ? { detail: r.recap } : {}) };
}

/** Texto que o botão manda à sessão: o da ferramenta ou, sem ele, o próprio rótulo (como o app faz). */
export function replyText(o: ReplyOption): string {
  return o.message ?? o.label;
}

export class ReplyCard {
  readonly el: HTMLElement;
  private recapEl: HTMLElement;
  private askEl: HTMLElement;
  private opts: HTMLElement;
  private note: HTMLElement;
  /** O que está na tela ("<agente>|<pergunta>"): ao mudar, os botões são refeitos. */
  private shown = '';
  /** Pergunta já respondida por aqui (os botões saem até vir outra). */
  private answered = '';

  constructor(
    private invalidate: () => void,
    private composer: MessageComposer,
    variant: 'drawer' | 'terminal',
  ) {
    this.recapEl = h('p', { class: 'ui-reply__recap' });
    this.askEl = h('p', { class: 'ui-reply__ask' });
    this.opts = h('div', { class: 'ui-reply__opts' });
    this.note = h('p', { class: 'ui-reply__note', hidden: true });
    this.el = h(
      'div',
      { class: `ui-reply ui-reply--${variant}`, hidden: true, role: 'group', attrs: { 'aria-label': tr('Pergunta do agente') } },
      this.recapEl,
      this.askEl,
      this.opts,
      this.note,
    );
  }

  render(agent: AgentInfo | undefined): void {
    const reply = pendingReply(agent);
    setHidden(this.el, !reply);
    if (!reply || !agent) {
      this.shown = '';
      return;
    }
    const key = `${agent.id}|${reply.id}`;
    if (key !== this.shown) {
      this.shown = key;
      setText(this.recapEl, reply.recap ?? '');
      setHidden(this.recapEl, !reply.recap);
      setText(this.askEl, reply.ask);
      this.opts.replaceChildren(...reply.options.map((o, i) => this.button(o, i === 0)));
    }
    const answered = this.answered === key;
    // Sem o plugin de mensagens (ou fora do acesso local) os botões não mandam nada: a caixa de mensagem logo abaixo
    // já diz o porquê, então aqui basta deixá-los apagados.
    const ready = this.composer.ready && !answered;
    for (const el of this.opts.children) this.setEnabled(el as HTMLButtonElement, ready);
    setHidden(this.opts, answered);
    setText(this.note, answered ? tr('Resposta enviada.') : '');
    setHidden(this.note, !answered);
  }

  private button(o: ReplyOption, recommended: boolean): HTMLButtonElement {
    const app = o.appAction;
    // aria-disabled (e não disabled): o botão continua focável e a dica do porquê aparece no hover.
    const btn = h('button', { class: `ui-btn ui-btn--sm${recommended && !app ? ' is-on' : ''}`, type: 'button', text: o.label });
    if (app) {
      btn.dataset.app = app;
      setTitle(btn, tr('“{0}” é do Claude Code; por aqui dá para responder com texto.', [o.label]));
      this.setEnabled(btn, false);
      return btn;
    }
    const text = replyText(o);
    setTitle(btn, tr('Responder “{0}” — vai para a sessão como se você tivesse digitado', [text]));
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true' || !this.composer.sendText(text)) return;
      this.answered = this.shown;
      this.invalidate();
    });
    return btn;
  }

  private setEnabled(btn: HTMLButtonElement, enabled: boolean): void {
    const on = enabled && !btn.dataset.app;
    setAttr(btn, 'aria-disabled', on ? null : 'true');
    btn.classList.toggle('is-disabled', !on);
  }
}
