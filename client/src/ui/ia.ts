// "IA do agente": na gaveta de um agente fixo, a IA e o nível com que ele trabalha (ou automático: a triagem
// escolhe em cada trabalho), o mínimo que ele nunca fica abaixo, e se ele pode escolher a IA do colega ao passar
// trabalho. Quem grava é o serviço da equipe (ui/criar.ts pede a confirmação e manda o pedido).
import { AI_LADDER, AI_LEVEL_NAME, AI_LEVELS, AI_MODEL_HINT, AI_MODEL_NAME, AI_MODELS, type AgentAi, type AgentAiChange } from '../../../shared/ia';
import { h, setHidden, setText } from './dom';

/** O que está escolhido nos campos da seção (cada um com "auto" = sem escolha; `pode`: 'padrao', 'sim' ou 'nao'). */
export interface EscolhasDeIA {
  modelo: string;
  nivel: string;
  pisoModelo: string;
  pisoNivel: string;
  pode: string;
}

/** Os campos como estão guardados no agente. */
export function escolhasDe(ia: AgentAi | undefined): EscolhasDeIA {
  return {
    modelo: ia?.modelo ?? 'auto',
    nivel: ia?.nivel ?? 'auto',
    pisoModelo: ia?.piso?.modelo ?? 'auto',
    pisoNivel: ia?.piso?.nivel ?? 'auto',
    pode: ia?.podeMarcado === undefined ? 'padrao' : ia.podeMarcado ? 'sim' : 'nao',
  };
}

/** Só o que mudou entre o guardado e o escolhido; nada mudou = undefined. */
export function mudancaDeIA(ia: AgentAi | undefined, novo: EscolhasDeIA): AgentAiChange | undefined {
  const antes = escolhasDe(ia);
  const out: AgentAiChange = {};
  if (novo.modelo !== antes.modelo) out.modelo = novo.modelo as AgentAiChange['modelo'];
  if (novo.nivel !== antes.nivel) out.nivel = novo.nivel as AgentAiChange['nivel'];
  if (novo.pisoModelo !== antes.pisoModelo) out.pisoModelo = novo.pisoModelo as AgentAiChange['pisoModelo'];
  if (novo.pisoNivel !== antes.pisoNivel) out.pisoNivel = novo.pisoNivel as AgentAiChange['pisoNivel'];
  if (novo.pode !== antes.pode) out.pode = novo.pode === 'padrao' ? 'padrao' : novo.pode === 'sim';
  return Object.keys(out).length ? out : undefined;
}

/** A mudança em palavras, para a confirmação: "IA: Sonnet; nível: automático; ...". */
export function textoDaMudanca(m: AgentAiChange): string {
  const nome = (v: string | undefined, nomes: Record<string, string>, auto: string) => (v === 'auto' ? auto : (nomes[v ?? ''] ?? v ?? ''));
  const partes: string[] = [];
  if (m.modelo !== undefined) partes.push(`IA: ${nome(m.modelo, AI_MODEL_NAME, 'automática (a triagem escolhe)')}`);
  if (m.nivel !== undefined) partes.push(`nível: ${nome(m.nivel, AI_LEVEL_NAME, 'automático (a triagem escolhe)').toLowerCase()}`);
  if (m.pisoModelo !== undefined) partes.push(`IA mínima: ${nome(m.pisoModelo, AI_MODEL_NAME, 'sem mínimo')}`);
  if (m.pisoNivel !== undefined) partes.push(`nível mínimo: ${nome(m.pisoNivel, AI_LEVEL_NAME, 'sem mínimo').toLowerCase()}`);
  if (m.pode !== undefined) partes.push(m.pode === 'padrao' ? 'escolher a IA do colega: volta ao padrão (quem dirige e confere pode)' : m.pode ? 'pode escolher a IA e o nível do colega ao passar trabalho' : 'não pode mais escolher a IA do colega');
  return partes.join('; ');
}

function campo(rotulo: string, select: HTMLSelectElement): HTMLElement {
  return h('label', { class: 'ui-ia__campo' }, h('span', { text: rotulo }), select);
}

function opcoes(select: HTMLSelectElement, itens: readonly (readonly [string, string, string?])[]): void {
  select.replaceChildren(...itens.map(([value, text, title]) => h('option', { text, attrs: { value, ...(title ? { title } : {}) } })));
}

export class AgentAiPicker {
  readonly el: HTMLElement;
  private modelo = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'IA do agente' } });
  private nivel = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Nível do agente' } });
  private pisoModelo = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'IA mínima do agente' } });
  private pisoNivel = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Nível mínimo do agente' } });
  private pode = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Pode escolher a IA do colega' } });
  private salvar: HTMLButtonElement;
  private resumo = h('p', { class: 'ui-muted ui-small' });
  private atual: AgentAi | undefined;
  private de = '';

  /** `aoSalvar(mudanca)`: a gaveta sabe de qual agente é e manda o pedido. */
  constructor(aoSalvar: (mudanca: AgentAiChange) => void) {
    opcoes(this.modelo, [['auto', 'Automática'], ...AI_MODELS.map((m) => [m, AI_MODEL_NAME[m], AI_MODEL_HINT[m]] as const)]);
    opcoes(this.nivel, [['auto', 'Automático'], ...AI_LEVELS.map((n) => [n, AI_LEVEL_NAME[n]] as const)]);
    opcoes(this.pisoModelo, [['auto', 'Sem mínimo'], ...AI_LADDER.map((m) => [m, AI_MODEL_NAME[m]] as const)]);
    opcoes(this.pisoNivel, [['auto', 'Sem mínimo'], ...AI_LEVELS.map((n) => [n, AI_LEVEL_NAME[n]] as const)]);
    this.salvar = h('button', {
      class: 'ui-btn',
      type: 'button',
      text: 'Salvar',
      on: {
        click: () => {
          const m = mudancaDeIA(this.atual, this.escolhas());
          if (m) aoSalvar(m);
        },
      },
    });
    for (const s of [this.modelo, this.nivel, this.pisoModelo, this.pisoNivel, this.pode]) s.addEventListener('change', () => this.sync());
    this.el = h(
      'div',
      { class: 'ui-ia' },
      h('p', { class: 'ui-muted ui-small', text: 'Automático: com a triagem ligada (no terminal: equipe ia --triagem ia), antes de cada trabalho ela lê o pedido e escolhe a IA e o nível mais baratos que entregam com qualidade; desligada, vale o padrão do Claude Code. Fixe só se este agente deve usar sempre a mesma.' }),
      h('div', { class: 'ui-ia__linha' }, campo('IA', this.modelo), campo('Nível', this.nivel)),
      h('p', { class: 'ui-dem__rot', text: 'No mínimo (a triagem nunca escolhe abaixo disto)' }),
      h('div', { class: 'ui-ia__linha' }, campo('IA', this.pisoModelo), campo('Nível', this.pisoNivel)),
      h('p', { class: 'ui-dem__rot', text: 'Permissões' }),
      h('div', { class: 'ui-ia__linha' }, campo('Escolher a IA e o nível do colega ao passar trabalho', this.pode)),
      this.resumo,
      h('div', { class: 'ui-estilo__acoes' }, this.salvar),
    );
  }

  private escolhas(): EscolhasDeIA {
    return { modelo: this.modelo.value, nivel: this.nivel.value, pisoModelo: this.pisoModelo.value, pisoNivel: this.pisoNivel.value, pode: this.pode.value };
  }

  /** Mostra o que está guardado no agente `id`. Enquanto a pessoa mexe nos campos, eles ficam como ela deixou. */
  render(id: string, ia: AgentAi | undefined): void {
    const de = JSON.stringify([id, ia ?? null]);
    if (de === this.de) return;
    this.de = de;
    this.atual = ia;
    // O "padrão" diz o que vale hoje para este agente (quem dirige e confere pode; os outros, não).
    const padrao = ia?.podeMarcado === undefined ? !!ia?.pode : undefined;
    opcoes(this.pode, [['padrao', padrao === undefined ? 'Padrão (quem dirige e confere pode)' : padrao ? 'Padrão: pode (ele dirige ou confere)' : 'Padrão: não pode'], ['sim', 'Sim, pode'], ['nao', 'Não pode']]);
    const e = escolhasDe(ia);
    this.modelo.value = e.modelo;
    this.nivel.value = e.nivel;
    this.pisoModelo.value = e.pisoModelo;
    this.pisoNivel.value = e.pisoNivel;
    this.pode.value = e.pode;
    this.sync();
  }

  private sync(): void {
    const m = mudancaDeIA(this.atual, this.escolhas());
    this.salvar.disabled = !m;
    setText(this.resumo, m ? `Vai mudar: ${textoDaMudanca(m)}.` : '');
    setHidden(this.resumo, !m);
  }
}
