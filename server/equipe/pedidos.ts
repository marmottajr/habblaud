// Demandas pedidas pela tela do escritório (equipe de agentes fixos; ver o README.md).
//
// O servidor não abre nada no computador: ele só guarda o pedido numa fila em memória. Quem abre o terminal do
// agente é o serviço do host (`equipe servir`, equipe/equipe.mjs), que consulta esta fila a cada 2 s.
//
//   GET  /api/equipe/estado          (página)   {ligado, servico}: há chave? o serviço do host está consultando?
//   POST /api/equipe/demandas        (página)   {room, slug, pedido, titulo?} -> 201 {id, servico}
//   GET  /api/equipe/demandas/:id    (página)   como ficou o pedido: pendente | aberta | erro | expirado
//   GET  /api/equipe/pedidos         (serviço)  pedidos pendentes
//   POST /api/equipe/pedidos/:id     (serviço)  {ok, demanda?, erro?}: o terminal abriu, ou por que não abriu
//
// Recado para um agente que está trabalhando (ele lê no meio do trabalho, como se o usuário tivesse digitado
// no terminal dele). Quem digita é o processo que abriu a sessão (`equipe _rodar`), que consulta a fila:
//   POST /api/equipe/mensagens       (página)   {agentId, texto} -> 201 {id}
//   GET  /api/equipe/mensagens/:id   (página)   pendente | entregue | erro | expirado
//   GET  /api/equipe/mensagens?pid=  (sessão)   recados pendentes para a sessão daquele processo
//   POST /api/equipe/mensagens/:id   (sessão)   {ok, erro?}: foi digitado, ou por que não foi
//
// Rotinas (demanda que se repete; server/equipe/rotinas.ts):
//   GET  /api/equipe/rotinas?room=   (página)   lista
//   POST /api/equipe/rotinas         (página)   {room, slug, pedido} + {dias, hora} ou {intervaloMin} -> 201
//   POST /api/equipe/rotinas/:id     (página)   {ativa} liga/desliga, {rodar: true} roda agora, {apagar: true},
//                                               ou os campos a editar (pedido, slug, room, dias, hora, intervaloMin)
//   POST /api/equipe/rotinas/:id     (serviço)  {novidades, cabecalho?}: itens novos no caminho de uma rotina por gatilho
//
// Histórico das demandas (o painel de Demandas). O serviço do host publica um arquivo por projeto em
// <pasta da equipe>/demandas/ (equipe.mjs, publicarDemandas); o servidor só lê:
//   GET  /api/equipe/historico            (página)   projetos e demandas, sem os textos longos
//   GET  /api/equipe/historico/:id?room=  (página)   uma demanda inteira (pedido, instrução e resultado de cada etapa)
//   POST /api/equipe/historico/:id        (página)   {room, acao}: arquivar | desarquivar | excluir | perguntar ({etapa, texto}) | mostrar (a janela
//                                                    do terminal) | retomar (a demanda parada). Vira um pedido na fila; acompanha-se em /demandas/:id
//
// Trava: como o terminal e as permissões, só pelo próprio computador (conferido em http/app.ts). Além disso, tudo
// menos /estado exige a chave do escritório no cabeçalho X-Equipe-Chave: o conteúdo de <pasta da equipe>/chave,
// criada no host por `equipe chave`. Sem o arquivo, o recurso fica desligado.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { parseAgentAiChange, type AgentAiChange } from '../../shared/ia';
import { MAX_ROOM_AGENTS, parseAgentLimit } from '../../shared/roomstyle';
import { normalizeCwd } from '../model/rooms';
import type { Equipes } from './registro';
import { RotinaInvalida, type Rotinas } from './rotinas';

export type EstadoDoPedido = 'pendente' | 'aberta' | 'erro' | 'expirado';

export interface Pedido {
  id: string;
  /** Pasta do projeto (a sala). */
  room: string;
  /** Agente fixo que recebe a demanda. */
  slug: string;
  pedido: string;
  titulo?: string;
  criadoEm: number;
  estado: EstadoDoPedido;
  /** Id da demanda criada no projeto (quando o terminal abriu). */
  demanda?: string;
  erro?: string;
  /** Recado do serviço quando deu certo com ressalva (a demanda ficou na fila, esperando a que está trabalhando). */
  aviso?: string;
  /** Pedido que não abre demanda: age sobre uma que já existe (`demanda` é o id dela). */
  acao?: Acao;
  /** Na ação `perguntar`: o número da etapa sobre a qual é a pergunta (o texto vai em `pedido`). */
  etapa?: number;
  /** Na ação `perguntar`: em vez de só responder, o agente reabre o trabalho (pode chamar colegas). */
  continuar?: boolean;
  /**
   * Pedido de criação pela tela: `pasta` abre no Mac a janela de escolher pasta; `sala` cria uma sala fixa na
   * pasta escolhida; `agente` cria um agente fixo na sala `room` a partir de uma descrição curta.
   */
  tipo?: 'pasta' | 'sala' | 'agente' | 'ler-funcao' | 'funcao' | 'apagar-agente' | 'remover-sala' | 'ligar-sala' | 'dono' | 'limite' | 'ia';
  /** `ia`: a mudança de IA e nível do agente `slug` (só os campos que mudam). */
  ia?: AgentAiChange;
  /** `limite`: quantos agentes fixos a sala pode ter; 0 = volta ao padrão (as mesas do layout). */
  limite?: number;
  /** `ligar-sala`: a outra sala e se é para ligar (true) ou desligar (false). */
  outra?: string;
  ligar?: boolean;
  /** `dono`: o nome vale no feminino ("a Marina"). */
  feminino?: boolean;
  /** `funcao`: o texto novo da função. `ler-funcao` resolvido: o texto de hoje. */
  texto?: string;
  /** `sala`: nome da sala. */
  nome?: string;
  /** `sala`: a pasta pedida. `pasta` resolvido: a pasta que ele escolheu na janela do Mac. */
  pasta?: string;
  /** `agente`: a função (título) e a descrição curta; `visual` puxa a aparência do personagem. */
  funcao?: string;
  descricao?: string;
  visual?: 'f' | 'm';
  /** `sala` resolvido: a pasta da sala criada (o id dela no escritório). */
  sala?: string;
  /** `agente` resolvido: o nome de arquivo do agente criado. */
  agente?: string;
}

/** O aviso de sala cheia (o mesmo na tela e no pedido). */
export function salaCheia(tem: number, limite: number): string {
  return `esta sala está cheia: ${tem} de ${limite} ${limite === 1 ? 'agente' : 'agentes'}. Aumente o limite nas configurações da sala ou apague um agente`;
}

/** Tamanho do texto da função de um agente, editada na tela (o comando confere de novo). */
export const FUNCAO_TEXTO_MIN = 50;
export const FUNCAO_TEXTO_MAX = 40_000;

/** Tamanho da descrição curta de um agente novo (o comando confere de novo). */
export const DESCRICAO_MIN = 20;
export const DESCRICAO_MAX = 4_000;

// `retomar`: a demanda parada volta a andar. Quem confere se ela está mesmo parada (e não arquivada, nem com
// agente trabalhando) é o serviço do host, que enxerga a pasta do projeto; o servidor só guarda o pedido.
export const ACOES = ['arquivar', 'desarquivar', 'excluir', 'mostrar', 'perguntar', 'retomar'] as const;
export type Acao = (typeof ACOES)[number];
const DEMANDA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/;

/** Tamanho máximo do texto da demanda. */
export const PEDIDO_MAX = 8_000;
const TITULO_MAX = 60;
/** Pedido que o serviço não buscou nisto expira: o serviço do host não está rodando. */
export const PENDENTE_TTL_MS = 120_000;
/** Pedidos resolvidos ficam consultáveis por isto. */
const RESOLVIDO_TTL_MS = 10 * 60_000;
const MAX_PENDENTES = 20;
/** O serviço consulta a cada 2 s; sem consulta nisto, conta como parado. */
export const SERVICO_VIVO_MS = 15_000;
const CHAVE_MIN = 20;

/** Recado para a sessão de um agente que está trabalhando. */
export interface Mensagem {
  id: string;
  /** Processo do Claude Code da sessão (o `<pid>` do id do agente). */
  pid: number;
  slug: string;
  texto: string;
  criadoEm: number;
  estado: 'pendente' | 'entregue' | 'erro' | 'expirado';
  erro?: string;
}

/** Tamanho máximo de um recado (vai digitado numa linha só). */
export const MENSAGEM_MAX = 2_000;
/** Recado que a sessão não buscou nisto expira (sessão fechada, ou aberta sem ser pela equipe). */
export const MENSAGEM_TTL_MS = 60_000;

/** O que a fila precisa saber de um agente vivo para lhe mandar um recado. */
export interface AgenteVivo {
  id: string;
  kind: string;
  staff?: string;
  status: string;
}

export class PedidoInvalido extends Error {}

/** Texto da demanda: sem caracteres de controle (menos quebra de linha e tab), sem espaço sobrando. */
export function limparPedido(raw: unknown, max = PEDIDO_MAX): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let out = '';
  for (const ch of raw.replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 10 || c === 9 || (c >= 32 && c !== 127 && c !== 0x2028 && c !== 0x2029)) out += ch;
  }
  out = out.trim();
  if (!out) return undefined;
  return [...out].slice(0, max).join('').trim();
}

export interface FilaOptions {
  equipes: () => Equipes;
  /** Arquivo com a chave do escritório; null = recurso desligado. */
  keyFile: string | null;
  /** Quantos agentes fixos cabem numa sala de equipe (o limite dela, sem passar das mesas do layout). */
  limite?: (room: string) => number | undefined;
  /** Quantas mesas o layout da sala tem: o teto do limite que se escolhe. */
  mesas?: (room: string) => number | undefined;
  /** Agentes com sessão aberta (Office.list), para os recados. */
  agentes?: () => readonly AgenteVivo[];
  now?: () => number;
  newId?: () => string;
}

export class FilaDePedidos {
  private pedidos = new Map<string, Pedido>();
  private mensagens = new Map<string, Mensagem>();
  private ultimaConsulta = -Infinity;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: FilaOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  private chave(): string | undefined {
    if (!this.opts.keyFile) return undefined;
    try {
      const k = readFileSync(this.opts.keyFile, 'utf8').trim();
      return k.length >= CHAVE_MIN ? k : undefined;
    } catch {
      return undefined;
    }
  }

  /** Há chave criada no host (o recurso está ligado)? */
  ligado(): boolean {
    return this.chave() !== undefined;
  }

  /** O serviço do host consultou a fila há pouco? */
  servicoAtivo(): boolean {
    return this.now() - this.ultimaConsulta < SERVICO_VIVO_MS;
  }

  /** Confere a chave enviada (comparação em tempo constante). */
  conferirChave(enviada: string | undefined): 'ok' | 'desligado' | 'errada' {
    const certa = this.chave();
    if (!certa) return 'desligado';
    if (!enviada) return 'errada';
    const a = createHash('sha256').update(enviada.trim()).digest();
    const b = createHash('sha256').update(certa).digest();
    return timingSafeEqual(a, b) ? 'ok' : 'errada';
  }

  private limpar(): void {
    const now = this.now();
    for (const [id, p] of this.pedidos) {
      if (p.estado === 'pendente' && now - p.criadoEm > PENDENTE_TTL_MS) {
        p.estado = 'expirado';
        p.erro = 'o serviço da equipe não buscou o pedido: ele não está rodando neste computador';
      }
      if (p.estado !== 'pendente' && now - p.criadoEm > RESOLVIDO_TTL_MS) this.pedidos.delete(id);
    }
  }

  criar(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; slug?: unknown; pedido?: unknown; titulo?: unknown };
    if (typeof b.room !== 'string' || typeof b.slug !== 'string') throw new PedidoInvalido('esperado {room, slug, pedido}');
    const room = normalizeCwd(b.room);
    const agente = this.opts.equipes().get(room)?.agentes.find((a) => a.slug === b.slug);
    if (!agente) throw new PedidoInvalido('este agente não é da equipe deste projeto');
    const pedido = limparPedido(b.pedido);
    if (!pedido) throw new PedidoInvalido('escreva a demanda');
    if ([...this.pedidos.values()].filter((p) => p.estado === 'pendente').length >= MAX_PENDENTES) {
      throw new PedidoInvalido('há pedidos demais esperando o serviço da equipe; confira se ele está rodando');
    }
    const novo: Pedido = { id: this.newId(), room, slug: agente.slug, pedido, criadoEm: this.now(), estado: 'pendente' };
    const titulo = limparPedido(b.titulo, TITULO_MAX)?.replace(/\s+/g, ' ');
    if (titulo) novo.titulo = titulo;
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** Ação do painel de Demandas sobre uma demanda que já existe; quem executa é o serviço do host. */
  criarAcao(demanda: string, body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; acao?: unknown; etapa?: unknown; texto?: unknown; continuar?: unknown };
    if (typeof b.room !== 'string' || !ACOES.includes(b.acao as Acao)) throw new PedidoInvalido(`esperado {room, acao}, com acao em: ${ACOES.join(', ')}`);
    if (!DEMANDA_ID.test(demanda)) throw new PedidoInvalido('demanda inválida');
    const room = normalizeCwd(b.room);
    if (!this.opts.equipes().has(room)) throw new PedidoInvalido('este projeto não tem equipe');
    if ([...this.pedidos.values()].filter((p) => p.estado === 'pendente').length >= MAX_PENDENTES) {
      throw new PedidoInvalido('há pedidos demais esperando o serviço da equipe; confira se ele está rodando');
    }
    const novo: Pedido = { id: this.newId(), room, slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', acao: b.acao as Acao, demanda };
    // Pergunta a quem fez uma etapa: precisa da etapa e do texto.
    if (novo.acao === 'perguntar') {
      const texto = limparPedido(b.texto);
      if (!Number.isInteger(b.etapa) || (b.etapa as number) < 1 || (b.etapa as number) > 200) throw new PedidoInvalido('diga sobre qual etapa é a pergunta');
      if (!texto) throw new PedidoInvalido('escreva a pergunta');
      novo.etapa = b.etapa as number;
      novo.pedido = texto;
      if (b.continuar === true) novo.continuar = true;
    }
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  private cabe(): void {
    if ([...this.pedidos.values()].filter((p) => p.estado === 'pendente').length >= MAX_PENDENTES) {
      throw new PedidoInvalido('há pedidos demais esperando o serviço da equipe; confira se ele está rodando');
    }
  }

  /** "Escolher pasta": o serviço abre no Mac a janela de escolher pasta e devolve o caminho. */
  criarEscolhaDePasta(): Pedido {
    this.limpar();
    this.cabe();
    const novo: Pedido = { id: this.newId(), room: '', slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'pasta' };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "Nova sala": nome e pasta. Quem confere a pasta (existe, foi escolhida na janela do Mac) é o serviço. */
  criarSala(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { nome?: unknown; pasta?: unknown };
    const nome = limparPedido(b.nome, 40)?.replace(/\s+/g, ' ');
    if (!nome || nome.length < 2) throw new PedidoInvalido('dê um nome para a sala');
    const pasta = limparPedido(b.pasta, 600);
    if (!pasta || !pasta.startsWith('/') || pasta.includes('\n')) throw new PedidoInvalido('escolha a pasta da sala');
    this.cabe();
    const novo: Pedido = { id: this.newId(), room: '', slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'sala', nome, pasta };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "Novo agente": função e descrição curta, numa sala que já tem equipe (mesmo vazia). */
  criarAgente(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; funcao?: unknown; descricao?: unknown; visual?: unknown };
    if (typeof b.room !== 'string') throw new PedidoInvalido('esperado {room, funcao, descricao}');
    const room = normalizeCwd(b.room);
    if (!this.opts.equipes().has(room)) throw new PedidoInvalido('esta sala não é de uma equipe: crie a sala primeiro');
    const funcao = limparPedido(b.funcao, 40)?.replace(/\s+/g, ' ');
    if (!funcao || funcao.length < 2) throw new PedidoInvalido('diga a função do agente (ex.: Designer)');
    const descricao = limparPedido(b.descricao, DESCRICAO_MAX);
    if (!descricao || descricao.length < DESCRICAO_MIN) throw new PedidoInvalido('descreva em uma ou duas frases o que este agente faz');
    // Sala cheia: o limite de agentes dela (configurações da sala) já foi atingido.
    const limite = this.opts.limite?.(room);
    const tem = this.opts.equipes().get(room)?.agentes.length ?? 0;
    if (limite !== undefined && tem >= limite) throw new PedidoInvalido(salaCheia(tem, limite));
    this.cabe();
    const novo: Pedido = { id: this.newId(), room, slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'agente', funcao, descricao };
    if (b.visual === 'f' || b.visual === 'm') novo.visual = b.visual;
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /**
   * Gestão pela tela de uma sala de equipe: ler a função de um agente, salvar a função editada, apagar um agente
   * ou remover a sala. Quem confere se pode (agente em demanda, sala com agentes) é o serviço do host.
   */
  criarGestao(tipo: 'ler-funcao' | 'funcao' | 'apagar-agente' | 'remover-sala', body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; slug?: unknown; funcao?: unknown; texto?: unknown };
    if (typeof b.room !== 'string') throw new PedidoInvalido('esperado {room}');
    const room = normalizeCwd(b.room);
    const equipe = this.opts.equipes().get(room);
    if (!equipe) throw new PedidoInvalido('esta sala não é de uma equipe');
    const novo: Pedido = { id: this.newId(), room, slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo };
    if (tipo !== 'remover-sala') {
      const agente = typeof b.slug === 'string' ? equipe.agentes.find((a) => a.slug === b.slug) : undefined;
      if (!agente) throw new PedidoInvalido('este agente não é da equipe desta sala');
      novo.slug = agente.slug;
    }
    if (tipo === 'funcao') {
      const texto = limparPedido(b.texto, FUNCAO_TEXTO_MAX);
      if (!texto || texto.length < FUNCAO_TEXTO_MIN) throw new PedidoInvalido('a função ficou curta demais: escreva o que o agente faz');
      novo.texto = texto;
      const funcao = limparPedido(b.funcao, 40)?.replace(/\s+/g, ' ');
      if (funcao && funcao.length >= 2) novo.funcao = funcao;
    }
    this.cabe();
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "IA do agente": IA, nível, o mínimo e o poder de escolher a IA do colega. Quem grava é o serviço. */
  criarIA(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; slug?: unknown; ia?: unknown };
    if (typeof b.room !== 'string' || typeof b.slug !== 'string') throw new PedidoInvalido('esperado {room, slug, ia}');
    const room = normalizeCwd(b.room);
    const agente = this.opts.equipes().get(room)?.agentes.find((a) => a.slug === b.slug);
    if (!agente) throw new PedidoInvalido('este agente não é da equipe desta sala');
    const ia = parseAgentAiChange(b.ia);
    if (!ia) throw new PedidoInvalido('diga o que muda: a IA, o nível, o mínimo ou a permissão');
    this.cabe();
    const novo: Pedido = { id: this.newId(), room, slug: agente.slug, pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'ia', ia };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "Limite de agentes": quantos agentes fixos a sala pode ter (0 = volta ao padrão, as mesas do layout). */
  criarLimite(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; limite?: unknown };
    if (typeof b.room !== 'string') throw new PedidoInvalido('esperado {room, limite}');
    const room = normalizeCwd(b.room);
    const equipe = this.opts.equipes().get(room);
    if (!equipe) throw new PedidoInvalido('esta sala não é de uma equipe');
    if (equipe.escritorio) throw new PedidoInvalido('a sala do dono é só dele');
    const limite = b.limite === 0 ? 0 : parseAgentLimit(b.limite);
    if (limite === undefined) throw new PedidoInvalido(`o limite vai de 1 a ${MAX_ROOM_AGENTS} agentes`);
    const mesas = this.opts.mesas?.(room);
    if (limite && mesas !== undefined && limite > mesas) throw new PedidoInvalido(`esta sala tem ${mesas} ${mesas === 1 ? 'mesa' : 'mesas'}: para mais agentes, escolha um layout com mais mesas`);
    if (limite && limite < equipe.agentes.length) throw new PedidoInvalido(`esta sala já tem ${equipe.agentes.length} agentes: o limite não pode ser menor que isso`);
    this.cabe();
    const novo: Pedido = { id: this.newId(), room, slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'limite', limite };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "Conversa com": liga ou desliga duas salas de equipe. */
  criarLigacao(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { room?: unknown; outra?: unknown; ligar?: unknown };
    if (typeof b.room !== 'string' || typeof b.outra !== 'string') throw new PedidoInvalido('esperado {room, outra, ligar}');
    const room = normalizeCwd(b.room);
    const outra = normalizeCwd(b.outra);
    const equipes = this.opts.equipes();
    if (!equipes.has(room) || !equipes.has(outra)) throw new PedidoInvalido('as duas salas precisam ser de equipe');
    if (room === outra) throw new PedidoInvalido('escolha outra sala: esta é a mesma');
    if (equipes.get(room)?.escritorio || equipes.get(outra)?.escritorio) throw new PedidoInvalido('a sala do escritório não se liga a outras');
    this.cabe();
    const novo: Pedido = { id: this.newId(), room, slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'ligar-sala', outra, ligar: b.ligar !== false };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  /** "Dono do escritório": como os agentes chamam quem usa. Nome vazio volta ao do usuário do computador. */
  criarDono(body: unknown): Pedido {
    this.limpar();
    const b = (body ?? {}) as { nome?: unknown; feminino?: unknown };
    const nome = typeof b.nome === 'string' ? (limparPedido(b.nome, 40)?.replace(/\s+/g, ' ') ?? '') : '';
    if (nome && !/^[\p{L}][\p{L} .'-]*$/u.test(nome)) throw new PedidoInvalido('use só letras no nome (ele vai para dentro das regras dos agentes)');
    this.cabe();
    const novo: Pedido = { id: this.newId(), room: '', slug: '', pedido: '', criadoEm: this.now(), estado: 'pendente', tipo: 'dono', nome, feminino: b.feminino === true };
    this.pedidos.set(novo.id, novo);
    return novo;
  }

  get(id: string): Pedido | undefined {
    this.limpar();
    return this.pedidos.get(id);
  }

  // ---------------------------------------------------------------- recados para quem está trabalhando

  private limparMensagens(): void {
    const now = this.now();
    for (const [id, m] of this.mensagens) {
      if (m.estado === 'pendente' && now - m.criadoEm > MENSAGEM_TTL_MS) {
        m.estado = 'expirado';
        m.erro = 'a sessão do agente não buscou o recado: ela fechou, ou não foi aberta pela equipe';
      }
      if (m.estado !== 'pendente' && now - m.criadoEm > RESOLVIDO_TTL_MS) this.mensagens.delete(id);
    }
  }

  /** Recado para um agente fixo com sessão aberta. */
  criarMensagem(body: unknown): Mensagem {
    this.limparMensagens();
    const b = (body ?? {}) as { agentId?: unknown; texto?: unknown };
    if (typeof b.agentId !== 'string') throw new PedidoInvalido('esperado {agentId, texto}');
    const agente = this.opts.agentes?.().find((a) => a.id === b.agentId);
    if (!agente || agente.kind !== 'main' || !agente.staff || agente.status === 'offline') {
      throw new PedidoInvalido('este agente não está com sessão aberta agora; mande uma demanda nova');
    }
    const pid = Number(agente.id.slice(agente.id.lastIndexOf(':') + 1));
    if (!Number.isInteger(pid) || pid <= 0) throw new PedidoInvalido('não sei qual é a sessão deste agente');
    const texto = limparPedido(b.texto, MENSAGEM_MAX)?.replace(/\s+/g, ' ');
    if (!texto) throw new PedidoInvalido('escreva o recado');
    if ([...this.mensagens.values()].filter((m) => m.estado === 'pendente').length >= MAX_PENDENTES) throw new PedidoInvalido('há recados demais esperando');
    const m: Mensagem = { id: this.newId(), pid, slug: agente.staff, texto, criadoEm: this.now(), estado: 'pendente' };
    this.mensagens.set(m.id, m);
    return m;
  }

  getMensagem(id: string): Mensagem | undefined {
    this.limparMensagens();
    return this.mensagens.get(id);
  }

  /** Recados pendentes para a sessão do processo `pid`. */
  mensagensDe(pid: number): Mensagem[] {
    this.limparMensagens();
    return [...this.mensagens.values()].filter((m) => m.estado === 'pendente' && m.pid === pid);
  }

  resolverMensagem(id: string, body: unknown): boolean {
    const m = this.mensagens.get(id);
    if (!m || m.estado !== 'pendente') return false;
    const b = (body ?? {}) as { ok?: unknown; erro?: unknown };
    if (b.ok === true) m.estado = 'entregue';
    else {
      m.estado = 'erro';
      m.erro = limparPedido(b.erro, 300) ?? 'não foi possível entregar o recado na sessão';
    }
    return true;
  }

  /** Pedidos esperando o serviço (a consulta marca o serviço como vivo). */
  pendentes(): Pedido[] {
    this.ultimaConsulta = this.now();
    this.limpar();
    return [...this.pedidos.values()].filter((p) => p.estado === 'pendente');
  }

  /** O serviço diz como terminou: o terminal abriu (com o id da demanda) ou o motivo de não abrir. */
  resolver(id: string, body: unknown): boolean {
    const p = this.pedidos.get(id);
    if (!p || p.estado !== 'pendente') return false;
    const b = (body ?? {}) as { ok?: unknown; demanda?: unknown; erro?: unknown; aviso?: unknown; pasta?: unknown; sala?: unknown; slug?: unknown };
    if (b.ok === true) {
      p.estado = 'aberta';
      // Pedidos de criação: a pasta escolhida, a sala criada, o agente criado.
      const caminho = (v: unknown) => {
        const t = limparPedido(v, 600);
        return t && t.startsWith('/') && !t.includes('\n') ? t : undefined;
      };
      if (p.tipo === 'pasta') p.pasta = caminho(b.pasta);
      if (p.tipo === 'sala') p.sala = caminho(b.sala);
      if (p.tipo === 'agente' && typeof b.slug === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(b.slug)) p.agente = b.slug;
      // "Editar função": o texto de hoje e o título, para a tela mostrar.
      if (p.tipo === 'ler-funcao') {
        const lido = b as { texto?: unknown; funcao?: unknown };
        p.texto = limparPedido(lido.texto, FUNCAO_TEXTO_MAX) ?? '';
        p.funcao = limparPedido(lido.funcao, 40);
      }
      const demanda = limparPedido(b.demanda, 120);
      if (demanda) p.demanda = demanda;
      const aviso = limparPedido(b.aviso, 300);
      if (aviso) p.aviso = aviso;
    } else {
      p.estado = 'erro';
      p.erro = limparPedido(b.erro, 300) ?? 'o serviço da equipe não conseguiu abrir o terminal';
    }
    return true;
  }
}

// ---------------------------------------------------------------- histórico das demandas (somente leitura)

const HISTORICO_ARQUIVO_MAX = 12 * 1024 * 1024;
const HISTORICO_PROJETOS_MAX = 40;

interface ProjetoPublicado {
  projeto: string;
  nome: string;
  diretoria?: string;
  /** As salas com que esta conversa: os agentes delas também fazem etapas aqui. */
  ligadas?: string[];
  atualizadoEm?: number;
  demandas: Array<Record<string, unknown> & { id: string; etapas: Array<Record<string, unknown>> }>;
}

/**
 * Quem está em reunião: os agentes de toda demanda em andamento que envolve agentes de mais de uma sala (a equipe
 * dona da demanda e as salas que conversam com ela: a Diretoria e as ligadas). Devolve as chaves "sala\nagente"
 * (a sala é a do agente, não a da demanda). Demanda só com gente de uma sala não é reunião.
 */
export function agentesEmReuniao(projetos: readonly ProjetoPublicado[], equipes: Equipes): Set<string> {
  const out = new Set<string>();
  for (const p of projetos) {
    const equipe = equipes.get(p.projeto);
    if (!equipe) continue;
    const casas = [p.projeto, equipe.diretoria, ...(equipe.ligadas ?? []), ...(p.ligadas ?? [])].filter((c): c is string => typeof c === 'string');
    const casaDe = (slug: string) => casas.find((c) => equipes.get(c)?.agentes.some((a) => a.slug === slug));
    for (const d of p.demandas) {
      if (d.estado !== 'rodando' || d.arquivadaEm) continue;
      const envolvidos = new Map<string, string>();
      for (const e of d.etapas) {
        const slug = typeof e.quem === 'string' ? e.quem : typeof e.agente === 'string' ? e.agente : '';
        const casa = slug ? casaDe(slug) : undefined;
        if (casa) envolvidos.set(`${casa}\n${slug}`, casa);
      }
      if (new Set(envolvidos.values()).size < 2) continue;
      for (const k of envolvidos.keys()) out.add(k);
    }
  }
  return out;
}

/** Lê os arquivos que o serviço do host publica (um por projeto). Arquivo torto fica de fora; nada lança. */
export function lerHistorico(dir: string | null): ProjetoPublicado[] {
  if (!dir) return [];
  let nomes: string[] = [];
  try {
    nomes = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: ProjetoPublicado[] = [];
  for (const nome of nomes.slice(0, HISTORICO_PROJETOS_MAX)) {
    try {
      const arquivo = join(dir, nome);
      if (statSync(arquivo).size > HISTORICO_ARQUIVO_MAX) continue;
      const j = JSON.parse(readFileSync(arquivo, 'utf8')) as Partial<ProjetoPublicado>;
      if (typeof j.projeto !== 'string' || !Array.isArray(j.demandas)) continue;
      const demandas = j.demandas.filter((d) => d && typeof d.id === 'string' && Array.isArray(d.etapas));
      const ligadas = (Array.isArray(j.ligadas) ? j.ligadas : []).filter((x): x is string => typeof x === 'string' && x.startsWith('/')).slice(0, HISTORICO_PROJETOS_MAX).map((x) => normalizeCwd(x));
      out.push({
        projeto: normalizeCwd(j.projeto),
        nome: typeof j.nome === 'string' ? j.nome : j.projeto,
        diretoria: typeof j.diretoria === 'string' ? normalizeCwd(j.diretoria) : undefined,
        ...(ligadas.length ? { ligadas } : {}),
        atualizadoEm: j.atualizadoEm,
        demandas,
      });
    } catch {
      // arquivo pela metade ou ilegível: fica para a próxima leitura
    }
  }
  return out;
}

/** A lista do painel: sem os textos longos (instrução e resultado de cada etapa vêm no detalhe). */
export function resumoDoHistorico(projetos: readonly ProjetoPublicado[]): unknown[] {
  return projetos.map((p) => ({
    ...p,
    demandas: p.demandas.map((d) => ({
      ...d,
      pedido: typeof d.pedido === 'string' ? d.pedido.slice(0, 400) : '',
      etapas: d.etapas.map(({ instrucao: _i, resultado, ...e }) => ({ ...e, temResultado: typeof resultado === 'string' && resultado.length > 0 })),
    })),
  }));
}

/** Junta a cada etapa o que a sessão dela gastou (tokens de entrada e saída), quando o servidor sabe. */
export function comNumeros(projetos: ProjetoPublicado[], numeros?: (sessao: string) => { tokensIn: number; tokensOut: number; costUSD?: number } | undefined): ProjetoPublicado[] {
  if (!numeros) return projetos;
  for (const p of projetos) {
    for (const d of p.demandas) {
      for (const e of d.etapas) {
        const n = typeof e.sessao === 'string' ? numeros(e.sessao) : undefined;
        if (n) e.tokens = n.tokensIn + n.tokensOut;
      }
    }
  }
  return projetos;
}

const HISTORICO = /^\/api\/equipe\/historico\/([^/]+)$/;
const MENSAGEM = /^\/api\/equipe\/mensagens\/([^/]+)$/;
const ROTINA = /^\/api\/equipe\/rotinas\/([^/]+)$/;
const DEMANDA = /^\/api\/equipe\/demandas\/([^/]+)$/;
const PEDIDO = /^\/api\/equipe\/pedidos\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'método não permitido' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof PedidoInvalido || err instanceof RotinaInvalida) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: 'erro interno' });
}

export function createEquipeRoutes(
  fila: FilaDePedidos,
  rotinas?: Rotinas,
  opts: {
    historicoDir?: string | null;
    numeros?: (sessao: string) => { tokensIn: number; tokensOut: number; costUSD?: number } | undefined;
    /** Como os agentes chamam quem usa o escritório (do registro), para a tela mostrar. */
    dono?: () => { nome: string; feminino: boolean; escolhido: boolean } | undefined;
  } = {},
): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  /** Responde 401/403 e devolve false quando a chave não confere. */
  const autorizado = (req: IncomingMessage, res: ServerResponse): boolean => {
    const header = req.headers['x-equipe-chave'];
    const r = fila.conferirChave(typeof header === 'string' ? header : undefined);
    if (r === 'ok') return true;
    if (r === 'desligado') sendJson(res, 403, { error: 'demandas pelo escritório desligadas: crie a chave no computador com "equipe chave"' });
    else sendJson(res, 401, { error: 'chave do escritório ausente ou errada' });
    return false;
  };

  return (req, res, path) => {
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';
    if (path === '/api/equipe/estado') {
      if (!isRead) return methodNotAllowed(res, 'GET');
      return sendJson(res, 200, { ligado: fila.ligado(), servico: fila.servicoAtivo(), dono: opts.dono?.() });
    }
    if (path === '/api/equipe/demandas') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!autorizado(req, res)) return void req.resume();
      readJson(req)
        .then((body) => {
          const p = fila.criar(body);
          sendJson(res, 201, { id: p.id, servico: fila.servicoAtivo() });
        })
        .catch((err) => fail(res, err));
      return;
    }
    // ---- criar sala e agente pela tela (o serviço do host é quem cria; acompanha-se em /demandas/:id)
    const criacao: Record<string, (body: unknown) => Pedido> = {
      '/api/equipe/salas/pasta': () => fila.criarEscolhaDePasta(),
      '/api/equipe/salas': (body) => fila.criarSala(body),
      '/api/equipe/agentes': (body) => fila.criarAgente(body),
      '/api/equipe/agentes/funcao/ler': (body) => fila.criarGestao('ler-funcao', body),
      '/api/equipe/agentes/funcao': (body) => fila.criarGestao('funcao', body),
      '/api/equipe/agentes/apagar': (body) => fila.criarGestao('apagar-agente', body),
      '/api/equipe/salas/remover': (body) => fila.criarGestao('remover-sala', body),
      '/api/equipe/salas/ligar': (body) => fila.criarLigacao(body),
      '/api/equipe/salas/limite': (body) => fila.criarLimite(body),
      '/api/equipe/agentes/ia': (body) => fila.criarIA(body),
      '/api/equipe/dono': (body) => fila.criarDono(body),
    };
    if (Object.hasOwn(criacao, path)) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!autorizado(req, res)) return void req.resume();
      readJson(req)
        .then((body) => sendJson(res, 201, { id: criacao[path](body).id, servico: fila.servicoAtivo() }))
        .catch((err) => fail(res, err));
      return;
    }
    if (path === '/api/equipe/pedidos') {
      if (!isRead) return methodNotAllowed(res, 'GET');
      if (!autorizado(req, res)) return;
      return sendJson(res, 200, { pedidos: fila.pendentes() });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const idDe = (m: RegExpExecArray): string | undefined => {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        sendJson(res, 400, { error: 'id inválido' });
        return undefined;
      }
    };

    // ---- histórico das demandas
    if (path === '/api/equipe/historico') {
      if (!isRead) return methodNotAllowed(res, 'GET');
      if (!autorizado(req, res)) return;
      return sendJson(res, 200, { projetos: resumoDoHistorico(comNumeros(lerHistorico(opts.historicoDir ?? null), opts.numeros)), servico: fila.servicoAtivo() });
    }
    const hm = HISTORICO.exec(path);
    if (hm) {
      if (!autorizado(req, res)) return void req.resume();
      const id = idDe(hm);
      if (id === undefined) return;
      if (isRead) {
        const room = normalizeCwd(url.searchParams.get('room') ?? '');
        const d = lerHistorico(opts.historicoDir ?? null).find((p) => p.projeto === room)?.demandas.find((x) => x.id === id);
        return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'demanda desconhecida' });
      }
      if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      readJson(req)
        .then((body) => sendJson(res, 201, { id: fila.criarAcao(id, body).id, servico: fila.servicoAtivo() }))
        .catch((err) => fail(res, err));
      return;
    }

    // ---- recados
    if (path === '/api/equipe/mensagens') {
      if (!autorizado(req, res)) return void req.resume();
      if (isRead) {
        const pid = Number(url.searchParams.get('pid'));
        return sendJson(res, 200, { mensagens: Number.isInteger(pid) && pid > 0 ? fila.mensagensDe(pid) : [] });
      }
      if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      readJson(req)
        .then((body) => sendJson(res, 201, { id: fila.criarMensagem(body).id }))
        .catch((err) => fail(res, err));
      return;
    }
    const mm = MENSAGEM.exec(path);
    if (mm) {
      if (!autorizado(req, res)) return void req.resume();
      const id = idDe(mm);
      if (id === undefined) return;
      if (isRead) {
        const m = fila.getMensagem(id);
        return m ? sendJson(res, 200, { id: m.id, estado: m.estado, erro: m.erro }) : sendJson(res, 404, { error: 'recado desconhecido' });
      }
      if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      readJson(req)
        .then((body) => (fila.resolverMensagem(id, body) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'recado desconhecido ou já resolvido' })))
        .catch((err) => fail(res, err));
      return;
    }

    // ---- rotinas
    if (path === '/api/equipe/rotinas' || ROTINA.test(path)) {
      if (!rotinas) return sendJson(res, 404, { error: 'rotinas desligadas' });
      if (!autorizado(req, res)) return void req.resume();
      const rm = ROTINA.exec(path);
      if (!rm) {
        if (isRead) return sendJson(res, 200, { rotinas: rotinas.listar(url.searchParams.get('room') ?? undefined) });
        if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
        readJson(req)
          .then((body) => sendJson(res, 201, rotinas.criar(body)))
          .catch((err) => fail(res, err));
        return;
      }
      const id = idDe(rm);
      if (id === undefined) return;
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      readJson(req)
        .then((body) => {
          const b = (body ?? {}) as Record<string, unknown>;
          if (b.apagar === true) return rotinas.apagar(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'rotina desconhecida' });
          let r;
          if (Array.isArray(b.novidades)) r = rotinas.dispararGatilho(id, b);
          else if (b.rodar === true) r = rotinas.rodarAgora(id);
          else if (typeof b.ativa === 'boolean') r = rotinas.ligar(id, b.ativa);
          else if (['pedido', 'dias', 'hora', 'intervaloMin', 'gatilho', 'slug', 'room'].some((k) => b[k] !== undefined)) r = rotinas.editar(id, b);
          else throw new RotinaInvalida('esperado {ativa}, {rodar: true}, {apagar: true} ou os campos a editar');
          return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'rotina desconhecida' });
        })
        .catch((err) => fail(res, err));
      return;
    }

    const d = DEMANDA.exec(path);
    const s = PEDIDO.exec(path);
    const m = d ?? s;
    if (!m) return sendJson(res, 404, { error: 'rota desconhecida' });
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: 'id inválido' });
    }
    if (d) {
      if (!isRead) return methodNotAllowed(res, 'GET');
      if (!autorizado(req, res)) return;
      const p = fila.get(id);
      if (!p) return sendJson(res, 404, { error: 'pedido desconhecido' });
      return sendJson(res, 200, { id: p.id, estado: p.estado, demanda: p.demanda, erro: p.erro, aviso: p.aviso, pasta: p.tipo === 'pasta' ? p.pasta : undefined, sala: p.sala, agente: p.agente, ...(p.tipo === 'ler-funcao' && p.estado === 'aberta' ? { texto: p.texto ?? '', funcao: p.funcao } : {}), servico: fila.servicoAtivo() });
    }
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    if (!autorizado(req, res)) return void req.resume();
    readJson(req)
      .then((body) => {
        if (fila.resolver(id, body)) sendJson(res, 200, { ok: true });
        else sendJson(res, 404, { error: 'pedido desconhecido ou já resolvido' });
      })
      .catch((err) => fail(res, err));
  };
}
