// Grupo "Notificações no aparelho" das configurações: liga o Web Push neste aparelho, lista os tipos e manda um teste.
//
// A seção aparece sempre que o servidor tem o recurso ligado, mesmo quando o navegador não dá: no lugar do botão fica
// o motivo, e abaixo uma linha técnica com o primeiro passo que falhou. Esconder a seção em silêncio custou uma
// tentativa inteira no iPhone a 2026-10-29, porque "não aparece nada" não distingue um Safari sem Push API de uma
// sessão expirada no servidor.
import { PushClient, type PushState } from '../push';
import { describePushDiagnosis, pushBlocker, type PushDiagnosis } from '../push/diagnose';
import type { UiContext } from './context';
import { h, setAttr, setHidden, setText } from './dom';
import { tr } from '../../../shared/i18n';

/**
 * Interruptor de um tipo. É o mesmo desenho de `switchRow` em ui/settings.ts, repetido aqui de propósito: importar de
 * lá fecharia um ciclo entre os dois módulos (settings.ts importa este grupo).
 */
function typeSwitch(label: string, onToggle: () => void): { row: HTMLElement; btn: HTMLButtonElement } {
  const id = `ui-push-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const btn = h('button', { class: 'ui-switch', type: 'button', role: 'switch', attrs: { 'aria-checked': 'false', 'aria-labelledby': id } }, h('span', { class: 'ui-switch__knob' })) as HTMLButtonElement;
  btn.addEventListener('click', onToggle);
  const row = h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-set__label', text: label, attrs: { id } })), btn);
  return { row, btn };
}

export class PushSettingsGroup {
  readonly el: HTMLElement;
  private readonly push = new PushClient();
  private readonly enableBtn: HTMLButtonElement;
  private readonly testBtn: HTMLButtonElement;
  private readonly statusText: HTMLElement;
  private readonly diagText: HTMLElement;
  private readonly typeList: HTMLElement;
  private readonly types = new Map<string, { btn: HTMLButtonElement; row: HTMLElement }>();
  private state: PushState = 'unsupported';
  private available = false;
  private busy = false;
  private diag?: PushDiagnosis;

  constructor(private ctx: UiContext) {
    this.enableBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Ligar notificações neste aparelho'), on: { click: () => void this.toggle() } }) as HTMLButtonElement;
    this.testBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Enviar teste'), hidden: true, on: { click: () => void this.test() } }) as HTMLButtonElement;
    this.statusText = h('span', { class: 'ui-set__hint', text: '' });
    // Linha técnica, para quem está a resolver o problema ler ou ditar. Não fala de nada do escritório.
    this.diagText = h('span', { class: 'ui-set__hint', text: '', hidden: true });
    this.typeList = h('div', { hidden: true });
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('Notificações no aparelho') }),
      h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-set__label', text: tr('Avisos com o Habblaud fechado') }), this.statusText), this.enableBtn),
      h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, this.diagText)),
      this.typeList,
      h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-set__hint', text: tr('Manda uma notificação agora, só para este aparelho.') })), this.testBtn),
    );
  }

  /**
   * Pergunta ao servidor e ao navegador. A seção aparece se o servidor tiver o recurso, mesmo que o navegador não dê:
   * nesse caso o diagnóstico diz qual peça falta.
   */
  async load(): Promise<void> {
    const status = await this.push.load();
    // 404 é o recurso desligado no servidor (HABBLAUD_PUSH=0): a seção não existe, como antes. Qualquer OUTRA falha
    // (sem resposta, sessão expirada, erro do servidor) mostra a seção com o diagnóstico — eram exactamente esses os
    // casos para que a linha de diagnóstico foi escrita, e eram os que ficavam escondidos.
    this.available = !!status?.publicKey || this.push.lastStatusCode !== 404;
    // Registra o service worker aqui (sem permissão nenhuma): o pedido de permissão só sai no clique do botão. Sem
    // chave pública não há como inscrever, logo não vale a pena registar nada.
    if (status?.publicKey) await this.push.register();
    this.state = await this.push.state();
    this.diag = await this.push.diagnose();
    this.render();
  }

  render(): void {
    setHidden(this.el, !this.available);
    if (!this.available) return;
    const on = this.state === 'on';
    const blocker = this.diag ? pushBlocker(this.diag) : undefined;
    setText(this.enableBtn, on ? tr('Desligar neste aparelho') : tr('Ligar notificações neste aparelho'));
    this.enableBtn.disabled = this.busy || this.state === 'denied' || (!on && !!blocker);
    setText(
      this.statusText,
      this.state === 'on'
        ? tr('Ligado neste aparelho.')
        : this.state === 'denied'
          ? tr('Sem permissão: libere as notificações nos ajustes do aparelho.')
          : blocker
            ? tr('Não dá neste aparelho: {0}', [blocker])
            : tr('Desligado. No iPhone, só funciona com o Habblaud adicionado à tela de início.'),
    );
    // O diagnóstico só aparece quando há algo a diagnosticar: com tudo ligado, a seção fica limpa.
    setHidden(this.diagText, on || !this.diag);
    if (this.diag) setText(this.diagText, describePushDiagnosis(this.diag));
    setHidden(this.testBtn, !on);
    this.testBtn.disabled = this.busy;
    this.renderTypes(on);
  }

  private renderTypes(on: boolean): void {
    setHidden(this.typeList, !on);
    for (const t of this.push.types) {
      let ref = this.types.get(t.id);
      if (!ref) {
        const sw = typeSwitch(t.label, () => void this.flip(t.id));
        ref = { btn: sw.btn, row: sw.row };
        this.types.set(t.id, ref);
        this.typeList.append(sw.row);
      }
      setAttr(ref.btn, 'aria-checked', String(t.enabled));
      ref.btn.disabled = this.busy;
    }
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      if (this.state === 'on') {
        await this.push.disable();
        this.state = 'off';
        this.ctx.announce(tr('Notificações desligadas neste aparelho.'));
      } else {
        this.state = await this.push.enable();
        // Depois de ligar, relê o estado deste aparelho: é o que desenha os interruptores certos.
        if (this.state === 'on') await this.push.refreshState();
        this.ctx.announce(this.state === 'on' ? tr('Notificações ligadas neste aparelho.') : tr('Não foi possível ligar as notificações neste aparelho.'));
      }
    } finally {
      this.busy = false;
      // Rediagnostica depois da tentativa: se a permissão foi recusada ou o registo falhou, a linha passa a dizê-lo.
      this.diag = await this.push.diagnose();
      this.render();
    }
  }

  private async flip(id: string): Promise<void> {
    if (this.busy) return;
    const current = this.push.types.find((t) => t.id === id);
    if (!current) return;
    this.busy = true;
    this.render();
    try {
      await this.push.setType(id, !current.enabled);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async test(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const ok = await this.push.test();
      this.ctx.announce(ok ? tr('Teste enviado.') : tr('Não foi possível enviar o teste.'));
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
