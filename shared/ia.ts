// IA e nível de cada agente fixo e de cada etapa de uma demanda (equipe/equipe.mjs escolhe; a tela mostra e deixa
// mudar). A IA é o modelo do Claude Code (`claude --model`); o nível é o esforço (`claude --effort`).

/** As IAs que se escolhem pelo nome (sempre a versão mais nova de cada uma). */
export const AI_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type AiModel = (typeof AI_MODELS)[number];
/** A escada da triagem, da mais barata à mais capaz (a Fable só entra por escolha de alguém). */
export const AI_LADDER = ['haiku', 'sonnet', 'opus'] as const;
export type AiLadder = (typeof AI_LADDER)[number];
/** Os níveis de esforço, do mais barato ao mais caro. */
export const AI_LEVELS = ['baixo', 'medio', 'alto', 'extra', 'maximo'] as const;
export type AiLevel = (typeof AI_LEVELS)[number];

export const AI_MODEL_NAME: Record<AiModel, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
export const AI_MODEL_HINT: Record<AiModel, string> = {
  haiku: 'A mais rápida e barata: tarefa mecânica e curta',
  sonnet: 'Equilibrada: o trabalho comum da função',
  opus: 'A mais capaz da escada: julgamento, estratégia, criação que representa a marca',
  fable: 'Só por escolha: a triagem não usa',
};
export const AI_LEVEL_NAME: Record<AiLevel, string> = { baixo: 'Baixo', medio: 'Médio', alto: 'Alto', extra: 'Extra', maximo: 'Máximo' };

/** As escolhas de IA guardadas num agente fixo. */
export interface AgentAi {
  /** IA fixa; ausente = automática (a triagem escolhe em cada etapa). */
  modelo?: AiModel;
  /** Nível fixo; ausente = automático. */
  nivel?: AiLevel;
  /** O mínimo: a triagem nunca escolhe abaixo disto para este agente. */
  piso?: { modelo?: AiLadder; nivel?: AiLevel };
  /** Ao passar trabalho, ele pode escolher a IA e o nível do colega (o que vale hoje). */
  pode: boolean;
  /** A pessoa marcou esse poder à mão (sim ou não); ausente = vale o padrão: quem dirige e confere pode. */
  podeMarcado?: boolean;
}

/** A IA e o nível com que uma etapa rodou, e por quê. */
export interface StageAi {
  modelo?: string;
  nivel?: string;
  /** Quem escolheu: 'triagem', 'agente' (fixo no agente), 'colega' (quem passou o trabalho), 'pessoa' ou 'padrao'. */
  por?: string;
  motivo?: string;
  de?: string;
}

const um = <T extends string>(lista: readonly T[], v: unknown): T | undefined => (typeof v === 'string' && (lista as readonly string[]).includes(v) ? (v as T) : undefined);

/** Lê as escolhas de IA de um agente vindas de fora: só o que é válido fica. */
export function parseAgentAi(raw: unknown): AgentAi | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { modelo?: unknown; nivel?: unknown; piso?: unknown; pode?: unknown; podeMarcado?: unknown };
  const out: AgentAi = { pode: r.pode === true };
  const modelo = um(AI_MODELS, r.modelo);
  const nivel = um(AI_LEVELS, r.nivel);
  if (modelo) out.modelo = modelo;
  if (nivel) out.nivel = nivel;
  if (r.piso && typeof r.piso === 'object') {
    const p = r.piso as { modelo?: unknown; nivel?: unknown };
    const piso: NonNullable<AgentAi['piso']> = {};
    const pm = um(AI_LADDER, p.modelo);
    const pn = um(AI_LEVELS, p.nivel);
    if (pm) piso.modelo = pm;
    if (pn) piso.nivel = pn;
    if (pm || pn) out.piso = piso;
  }
  if (typeof r.podeMarcado === 'boolean') out.podeMarcado = r.podeMarcado;
  return out;
}

/** "Sonnet · médio" (o que houver); '' quando nada foi escolhido. */
export function aiLabel(ia: { modelo?: string; nivel?: string } | undefined): string {
  const partes: string[] = [];
  if (ia?.modelo) partes.push(AI_MODEL_NAME[ia.modelo as AiModel] ?? ia.modelo);
  if (ia?.nivel) partes.push((AI_LEVEL_NAME[ia.nivel as AiLevel] ?? ia.nivel).toLowerCase());
  return partes.join(' · ');
}

/** A escolha de uma etapa em uma frase: "Sonnet · médio. Escolhido pela triagem: roteiro inteiro." */
export function textoDaEscolha(ia: StageAi | undefined): string {
  if (!ia) return '';
  const quem: Record<string, string> = { triagem: 'Escolhido pela triagem', agente: 'Fixo no agente', colega: 'Escolhido por quem passou o trabalho', pessoa: 'Escolhido no pedido', padrao: 'Sem escolha' };
  const rotulo = aiLabel(ia) || 'O padrão do Claude Code';
  const origem = quem[ia.por ?? ''] ?? '';
  const resto = [origem, ia.motivo?.replace(/\.+$/, '')].filter(Boolean).join(': ');
  return `${rotulo}.${resto ? ` ${resto}.` : ''}`;
}

/**
 * O que a tela manda para mudar a IA de um agente. Em cada campo, 'auto' tira a escolha; `pode`: true, false ou
 * 'padrao' (volta a valer a regra: quem dirige e confere pode).
 */
export interface AgentAiChange {
  modelo?: AiModel | 'auto';
  nivel?: AiLevel | 'auto';
  pisoModelo?: AiLadder | 'auto';
  pisoNivel?: AiLevel | 'auto';
  pode?: boolean | 'padrao';
}

/** Lê uma mudança de IA vinda da tela: só os campos válidos ficam; nada válido = undefined. */
export function parseAgentAiChange(raw: unknown): AgentAiChange | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: AgentAiChange = {};
  const ou = <T extends string>(lista: readonly T[], v: unknown): T | 'auto' | undefined => (v === 'auto' ? 'auto' : um(lista, v));
  const modelo = ou(AI_MODELS, r.modelo);
  const nivel = ou(AI_LEVELS, r.nivel);
  const pisoModelo = ou(AI_LADDER, r.pisoModelo);
  const pisoNivel = ou(AI_LEVELS, r.pisoNivel);
  if (modelo) out.modelo = modelo;
  if (nivel) out.nivel = nivel;
  if (pisoModelo) out.pisoModelo = pisoModelo;
  if (pisoNivel) out.pisoNivel = pisoNivel;
  if (typeof r.pode === 'boolean' || r.pode === 'padrao') out.pode = r.pode;
  return Object.keys(out).length ? out : undefined;
}
