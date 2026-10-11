// Estado do escritório no navegador: recebe snapshots/feed/avisos do servidor via SSE
// (ou do simulador local quando a URL tem ?mock=1) e notifica os assinantes.
// Fonte alternativa (o timelapse, ui/timelapse.ts): pushReplay() publica snapshots reconstruídos e o
// SSE segue conectado por baixo, com os snapshots ao vivo guardados até o stopReplay().
// Também cuida da reconexão: quando o navegador desiste do stream (EventSource fechado após erro HTTP,
// ex.: servidor reiniciando atrás de um proxy), tenta de novo com espera crescente.
import type { AppearanceParts } from '../../../shared/appearance';
import type { StageAi } from '../../../shared/ia';
import type { Activity, AgentDetail, AgentInfo, FeedItem, Notice, OfficeSnapshot, OutboxMessage, PermissionDecision, PermissionRequestInfo, RoomInfo } from '../../../shared/types';
import { DemoSimulator } from '../../../shared/demo/simulator';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'mock';

export interface StoreEvents {
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notice: Notice;
  connection: ConnectionState;
  /** O servidor está servindo outro build do cliente: esta página está desatualizada. Emitido uma vez. */
  update: { build: string; current: string };
}

/**
 * Build desta página: o nome do bundle principal (ex.: "main-BFqheOCa"), tirado da URL do próprio módulo.
 * No modo dev (código-fonte servido pelo Vite) não há bundle e o resultado é undefined.
 */
export function pageBuild(moduleUrl: string = import.meta.url): string | undefined {
  try {
    return /\/bundle\/(main-[\w-]+)\.js$/.exec(new URL(moduleUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Listener<K extends keyof StoreEvents> = (value: StoreEvents[K]) => void;

/** O mínimo de EventSource que o store usa (permite injetar um falso nos testes). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StoreOptions {
  mock?: boolean;
  /** Parâmetros do modo mock (padrão: a query string da página). */
  search?: string;
  /** Fábrica do stream (padrão: `new EventSource(url)`). */
  eventSource?: (url: string) => EventSourceLike;
}

const FEED_LIMIT = 200;
/** EventSource.CLOSED (constante literal: o EventSource não existe no Node dos testes). */
const ES_CLOSED = 2;
/** Espera entre tentativas de reconexão: 2 s, 4 s, 8 s… até 30 s. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * Opções do simulador a partir da query string (?speed=2&sessions=6). `sessions=0` vale: escritório vazio. Para
 * capturas de tela: `seed=N` repete o mesmo escritório e `noquota=1` deixa a conta do Codex "sem cota".
 */
export function mockOptionsFrom(search: string): { speed: number; sessions: number; seed?: number; codexNoQuota?: boolean } {
  const params = new URLSearchParams(search);
  const num = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const speed = num('speed');
  const sessions = num('sessions');
  const seed = num('seed');
  return {
    speed: speed !== null && speed > 0 ? Math.min(speed, 50) : 1,
    sessions: sessions !== null && sessions >= 0 ? Math.min(Math.floor(sessions), 40) : 4,
    ...(seed !== null && seed >= 0 ? { seed: Math.floor(seed) } : {}),
    ...(params.get('noquota') === '1' ? { codexNoQuota: true } : {}),
  };
}

/** Uma rotina de um agente fixo, como GET /api/equipe/rotinas devolve. */
export interface RotinaInfo {
  id: string;
  room: string;
  slug: string;
  pedido: string;
  dias: number[];
  hora: string;
  /** Rotina por intervalo: a cada tantos minutos (aí `dias` e `hora` vêm vazios). */
  intervaloMin?: number;
  /** Rotina por gatilho: roda quando chega item novo neste caminho do computador. */
  gatilho?: string;
  ativa: boolean;
  proxima: number;
  ultima?: number;
  ultimoAviso?: string;
}

/** Uma etapa de uma demanda, como o painel de Demandas recebe (os textos longos só vêm no detalhe). */
export interface EtapaInfo {
  n: number;
  agente: string;
  /** Quem o agente é hoje, quando mudou de nome depois da etapa (senão, igual a `agente`). */
  quem?: string;
  funcao?: string;
  estado: string;
  passadaPor?: string;
  iniciadaEm?: number;
  terminadaEm?: number;
  /** Id da sessão do Claude Code da etapa (para abrir o terminal dela). */
  sessao?: string;
  /** A etapa é uma pergunta do dono a quem fez a etapa `sobre` (a pergunta vem em `instrucao`, a resposta em `resultado`). */
  pergunta?: boolean;
  /** A etapa é uma continuação pedida pelo dono a partir da etapa `sobre` (trabalho novo na mesma demanda). */
  continuacao?: boolean;
  sobre?: number;
  temResultado?: boolean;
  /** Por que a etapa ficou sem entregar (login vencido, limite do plano, janela fechada…) e o que fazer. */
  parada?: { tipo: string; texto: string; fazer?: string; em?: number };
  /** Tokens (entrada + saída) que a sessão da etapa gastou, quando o servidor sabe. */
  tokens?: number;
  /** A IA e o nível com que a etapa rodou, e por quê (equipe/equipe.mjs, escolherIADaEtapa). */
  ia?: StageAi;
  /** A etapa é a continuação de uma que pediu mais capacidade (`equipe subir`). */
  subida?: boolean;
  instrucao?: string;
  resultado?: string;
}

export interface DemandaInfo {
  id: string;
  titulo: string;
  pedido: string;
  /** fila | rodando | parada | concluida */
  estado: string;
  criadaEm: number;
  terminadaEm?: number;
  arquivadaEm?: number;
  /** Na fila: esperando a demanda que está trabalhando terminar (uma demanda por vez). */
  aguardando?: number;
  etapas: EtapaInfo[];
}

/** Como os agentes chamam quem usa o escritório: o nome escolhido, ou o do usuário do computador. */
export interface DonoInfo {
  nome: string;
  feminino: boolean;
  /** false = ninguém escolheu: o nome veio do usuário do computador. */
  escolhido: boolean;
}

/** As demandas de um projeto com equipe (GET /api/equipe/historico). */
export interface ProjetoHistorico {
  projeto: string;
  nome: string;
  /** Sala da Diretoria que dirige a equipe, se houver. */
  diretoria?: string;
  /** As salas com que esta conversa ("Conversa com"): os agentes delas também fazem etapas aqui. */
  ligadas?: string[];
  demandas: DemandaInfo[];
}

export class OfficeStore {
  snapshot: OfficeSnapshot | null = null;
  /** Feed global, do mais antigo para o mais recente. */
  feed: FeedItem[] = [];
  connection: ConnectionState = 'connecting';
  readonly mock: boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof StoreEvents, Set<(value: any) => void>>();
  private agentIndex = new Map<string, AgentInfo>();
  private roomIndex = new Map<string, RoomInfo>();
  private source: EventSourceLike | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private readonly search: string;
  private readonly openStream: (url: string) => EventSourceLike;
  /** Reconexão: tentativas seguidas sem sucesso e o timer da próxima. */
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  /** Desligado de propósito (disconnect()): não reconecta sozinho. */
  private stopped = true;
  /** Timelapse ligado: `snapshot` é o reconstruído; o último ao vivo fica em `live` (com a hora em que chegou). */
  private replay = false;
  private live: { snap: OfficeSnapshot; at: number } | null = null;

  constructor(opts: StoreOptions = {}) {
    this.mock = !!opts.mock;
    this.search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.openStream = opts.eventSource ?? ((url) => new EventSource(url));
    // Rede de volta (Wi-Fi, VPN): não espera o próximo intervalo para religar.
    if (typeof addEventListener === 'function' && !this.mock) {
      addEventListener('online', () => {
        if (!this.stopped && this.connection === 'closed') this.reconnectNow();
      });
    }
  }

  on<K extends keyof StoreEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  connect(): void {
    this.stopped = false;
    if (this.mock) return this.startMock();
    this.startSSE();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearRetry();
    this.closeSource();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  /** Reconecta imediatamente (botão "Tentar agora"), sem esperar o próximo intervalo. */
  reconnectNow(): void {
    if (this.mock) return;
    this.clearRetry();
    this.closeSource();
    this.stopped = false;
    this.startSSE();
  }

  /** Quando será a próxima tentativa automática de reconexão (epoch ms), ou null. */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  agent(id: string): AgentInfo | undefined {
    return this.agentIndex.get(id);
  }

  room(id: string): RoomInfo | undefined {
    return this.roomIndex.get(id);
  }

  agentsInRoom(roomId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter((a) => a.roomId === roomId);
  }

  /** Histórico longo de um agente (servidor). No modo mock e no timelapse devolve o `recent`. */
  async agentHistory(id: string): Promise<Activity[]> {
    if (this.mock || this.replay) return this.agent(id)?.recent ?? [];
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
    if (!res.ok) return this.agent(id)?.recent ?? [];
    const detail = (await res.json()) as AgentDetail;
    return detail.history;
  }

  /** Liga/desliga os agentes de demonstração no servidor. */
  async setDemo(enabled: boolean): Promise<boolean> {
    if (this.mock) return true;
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  /** Dá (ou, com texto vazio, tira) a função de um agente principal; o resultado chega no snapshot. */
  async setJob(id: string, job: string): Promise<boolean> {
    if (this.mock || this.replay) return false;
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job }),
    });
    return res.ok;
  }

  // ---------------------------------------------------------------- equipe: demanda pela tela

  /** A chave do escritório fica só neste navegador (o usuário cola uma vez; ver `equipe chave`). */
  get equipeKey(): string {
    try {
      return localStorage.getItem('habblaud.equipe.chave') ?? '';
    } catch {
      return '';
    }
  }

  set equipeKey(v: string) {
    try {
      if (v.trim()) localStorage.setItem('habblaud.equipe.chave', v.trim());
      else localStorage.removeItem('habblaud.equipe.chave');
    } catch {
      // sem armazenamento: a chave vale só enquanto a página estiver aberta
    }
  }

  /** O recurso está ligado no computador (há chave) e o serviço que abre o terminal está rodando? */
  async equipeEstado(): Promise<{ ligado: boolean; servico: boolean; dono?: DonoInfo } | null> {
    if (this.mock || this.replay) return null;
    try {
      const res = await fetch('/api/equipe/estado', { cache: 'no-store' });
      return res.ok ? ((await res.json()) as { ligado: boolean; servico: boolean; dono?: DonoInfo }) : null;
    } catch {
      return null;
    }
  }

  /** Manda uma demanda para um agente fixo. Devolve o id do pedido, ou o motivo de não ter ido. */
  async enviarDemanda(room: string, slug: string, pedido: string, chave: string): Promise<{ id?: string; servico?: boolean; status: number; error?: string }> {
    try {
      const res = await fetch('/api/equipe/demandas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Equipe-Chave': chave },
        body: JSON.stringify({ room, slug, pedido }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; servico?: boolean; error?: string };
      return { ...j, status: res.status };
    } catch {
      return { status: 0, error: 'o escritório não respondeu' };
    }
  }

  /** Como ficou o pedido: pendente (o serviço ainda não buscou), aberta, erro ou expirado. */
  async demandaEstado(id: string, chave: string): Promise<{ estado?: string; demanda?: string; erro?: string; aviso?: string } | null> {
    try {
      const res = await fetch(`/api/equipe/demandas/${encodeURIComponent(id)}`, { headers: { 'X-Equipe-Chave': chave }, cache: 'no-store' });
      return res.ok ? ((await res.json()) as { estado?: string; demanda?: string; erro?: string; aviso?: string }) : null;
    } catch {
      return null;
    }
  }

  /** Recado para um agente fixo que está trabalhando: ele lê no meio do trabalho. */
  async enviarRecado(agentId: string, texto: string, chave: string): Promise<{ id?: string; status: number; error?: string }> {
    try {
      const res = await fetch('/api/equipe/mensagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Equipe-Chave': chave },
        body: JSON.stringify({ agentId, texto }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      return { ...j, status: res.status };
    } catch {
      return { status: 0, error: 'o escritório não respondeu' };
    }
  }

  async recadoEstado(id: string, chave: string): Promise<{ estado?: string; erro?: string } | null> {
    try {
      const res = await fetch(`/api/equipe/mensagens/${encodeURIComponent(id)}`, { headers: { 'X-Equipe-Chave': chave }, cache: 'no-store' });
      return res.ok ? ((await res.json()) as { estado?: string; erro?: string }) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- equipe: histórico das demandas

  /** Demandas de todos os projetos com equipe. null = sem chave, chave errada ou sem resposta. */
  async historico(): Promise<ProjetoHistorico[] | null> {
    const chave = this.equipeKey;
    if (!chave) return null;
    try {
      const res = await fetch('/api/equipe/historico', { headers: { 'X-Equipe-Chave': chave }, cache: 'no-store' });
      return res.ok ? ((await res.json()) as { projetos: ProjetoHistorico[] }).projetos : null;
    } catch {
      return null;
    }
  }

  /** Uma demanda inteira: pedido, e a instrução e o resultado de cada etapa. */
  async demandaDetalhe(room: string, id: string): Promise<DemandaInfo | null> {
    try {
      const res = await fetch(`/api/equipe/historico/${encodeURIComponent(id)}?room=${encodeURIComponent(room)}`, { headers: { 'X-Equipe-Chave': this.equipeKey }, cache: 'no-store' });
      return res.ok ? ((await res.json()) as DemandaInfo) : null;
    } catch {
      return null;
    }
  }

  /** Arquiva, desarquiva, exclui, retoma ou traz o terminal da demanda para a frente. Quem faz é o serviço do Mac: espera a resposta dele. */
  async acaoDaDemanda(room: string, id: string, acao: 'arquivar' | 'desarquivar' | 'excluir' | 'mostrar' | 'perguntar' | 'retomar', extra: { etapa?: number; texto?: string; continuar?: boolean } = {}): Promise<{ ok: boolean; error?: string; aviso?: string }> {
    const chave = this.equipeKey;
    try {
      const res = await fetch(`/api/equipe/historico/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Equipe-Chave': chave }, body: JSON.stringify({ room, acao, ...extra }) });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !j.id) return { ok: false, error: j.error ?? 'o escritório recusou o pedido' };
      for (let i = 0; i < 20; i++) {
        await new Promise((ok) => setTimeout(ok, 700));
        const e = await this.demandaEstado(j.id, chave);
        if (e?.estado === 'aberta') return { ok: true, aviso: e.aviso };
        if (e?.estado === 'erro' || e?.estado === 'expirado') return { ok: false, error: e.erro ?? 'o serviço da equipe não conseguiu' };
      }
      return { ok: false, error: 'o serviço da equipe não respondeu: ele está rodando neste computador? (no terminal: equipe servico status)' };
    } catch {
      return { ok: false, error: 'o escritório não respondeu' };
    }
  }

  /**
   * Criar pela tela (ui/criar.ts): `pasta` abre no Mac a janela de escolher pasta, `sala` cria uma sala fixa e
   * `agente` cria um agente fixo a partir de uma descrição curta. Quem faz é o serviço do Mac: espera a resposta
   * dele (a janela de escolher pasta fica aberta até 100 s).
   */
  async criarNaEquipe(
    tipo: 'pasta' | 'sala' | 'agente' | 'ler-funcao' | 'funcao' | 'apagar-agente' | 'remover-sala' | 'ligar-sala' | 'dono' | 'limite' | 'ia',
    body: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; status?: number; error?: string; aviso?: string; pasta?: string; sala?: string; agente?: string; demanda?: string; texto?: string; funcao?: string }> {
    const chave = this.equipeKey;
    const path = {
      pasta: '/api/equipe/salas/pasta',
      sala: '/api/equipe/salas',
      agente: '/api/equipe/agentes',
      // Gestão: ler e salvar a função de um agente, apagar agente, remover sala.
      'ler-funcao': '/api/equipe/agentes/funcao/ler',
      funcao: '/api/equipe/agentes/funcao',
      'apagar-agente': '/api/equipe/agentes/apagar',
      'remover-sala': '/api/equipe/salas/remover',
      // "Conversa com" (liga ou desliga duas salas) e o dono do escritório (como os agentes chamam quem usa).
      'ligar-sala': '/api/equipe/salas/ligar',
      dono: '/api/equipe/dono',
      // Configurações da sala: quantos agentes fixos ela pode ter.
      limite: '/api/equipe/salas/limite',
      // Gaveta do agente fixo: a IA, o nível, o mínimo e a permissão de escolher a IA do colega.
      ia: '/api/equipe/agentes/ia',
    }[tipo];
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Equipe-Chave': chave }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !j.id) return { ok: false, status: res.status, error: j.error ?? 'o escritório recusou o pedido' };
      const voltas = tipo === 'pasta' ? 180 : 40;
      for (let i = 0; i < voltas; i++) {
        await new Promise((ok) => setTimeout(ok, 700));
        const e = (await this.demandaEstado(j.id, chave)) as { estado?: string; demanda?: string; erro?: string; aviso?: string; pasta?: string; sala?: string; agente?: string; texto?: string; funcao?: string } | null;
        if (e?.estado === 'aberta') return { ok: true, aviso: e.aviso, pasta: e.pasta, sala: e.sala, agente: e.agente, demanda: e.demanda, texto: e.texto, funcao: e.funcao };
        if (e?.estado === 'erro' || e?.estado === 'expirado') return { ok: false, error: e.erro ?? 'o serviço da equipe não conseguiu' };
      }
      return { ok: false, error: 'o serviço da equipe não respondeu: ele está rodando neste computador? (no terminal: equipe servico status)' };
    } catch {
      return { ok: false, error: 'o escritório não respondeu' };
    }
  }

  /** Rotinas (todas, ou as de uma sala). null = sem chave, chave errada ou sem resposta. */
  async rotinas(room?: string): Promise<RotinaInfo[] | null> {
    const chave = this.equipeKey;
    if (!chave || this.mock || this.replay) return null;
    try {
      const res = await fetch(`/api/equipe/rotinas${room ? `?room=${encodeURIComponent(room)}` : ''}`, { headers: { 'X-Equipe-Chave': chave }, cache: 'no-store' });
      return res.ok ? ((await res.json()) as { rotinas: RotinaInfo[] }).rotinas : null;
    } catch {
      return null;
    }
  }

  private async rotinaPost(path: string, body: unknown): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Equipe-Chave': this.equipeKey }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: res.ok, status: res.status, error: res.status === 401 ? 'A chave do escritório não confere.' : j.error };
    } catch {
      return { ok: false, status: 0, error: 'o escritório não respondeu' };
    }
  }

  /** Cria uma rotina: prompt base para um agente, em dias e hora marcados ou a cada intervalo (minutos). */
  criarRotina(dados: { room: string; slug: string; pedido: string; dias?: number[]; hora?: string; intervaloMin?: number; gatilho?: string }): Promise<{ ok: boolean; status: number; error?: string }> {
    return this.rotinaPost('/api/equipe/rotinas', dados);
  }

  /** Liga/desliga ({ativa}), roda agora ({rodar}), apaga ({apagar}) ou edita os campos de uma rotina. */
  mudarRotina(id: string, mudanca: Record<string, unknown>): Promise<{ ok: boolean; status: number; error?: string }> {
    return this.rotinaPost(`/api/equipe/rotinas/${encodeURIComponent(id)}`, mudanca);
  }

  /** "Verificar agora": pede ao servidor uma consulta ao GitHub (o resultado chega no snapshot). */
  async checkUpdates(): Promise<boolean> {
    if (this.mock) return false;
    const res = await fetch('/api/updates/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  }

  // ---------------------------------------------------------------- timelapse

  /** Snapshots vêm de uma fonte alternativa (o timelapse), não do SSE. */
  get replaying(): boolean {
    return this.replay;
  }

  /** Último snapshot ao vivo (durante o timelapse, `snapshot` é o reconstruído). */
  get liveSnapshot(): OfficeSnapshot | null {
    return this.replay ? (this.live?.snap ?? null) : this.snapshot;
  }

  /** Publica um snapshot da fonte alternativa; o primeiro liga o modo replay (o ao vivo fica guardado). */
  pushReplay(snap: OfficeSnapshot): void {
    if (!this.replay) {
      this.replay = true;
      this.live = this.snapshot ? { snap: this.snapshot, at: Date.now() } : null;
    }
    this.setSnapshot(snap);
  }

  /** Desliga a fonte alternativa e volta ao último snapshot ao vivo. */
  stopReplay(): void {
    if (!this.replay) return;
    this.replay = false;
    const live = this.live;
    this.live = null;
    if (live) {
      // `serverTime` avançado pelo tempo guardado: a UI acerta o relógio pelo snapshot que acabou de chegar.
      this.setSnapshot({ ...live.snap, serverTime: live.snap.serverTime + (Date.now() - live.at) });
    } else {
      this.snapshot = null;
      this.agentIndex = new Map();
      this.roomIndex = new Map();
    }
  }

  /**
   * Detalhe de um pedido de permissão (com os argumentos: comando, diff...). Os pedidos do demo já vêm
   * completos no snapshot; os reais vêm de GET /api/permissions/:id (só com acesso local).
   */
  async permissionDetail(agentId: string, id: string): Promise<PermissionRequestInfo | undefined> {
    const inline = this.agent(agentId)?.permission;
    if (inline?.id === id && inline.input !== undefined) return inline;
    if (this.mock) return inline?.id === id ? inline : undefined;
    const res = await fetch(`/api/permissions/${encodeURIComponent(id)}`);
    if (!res.ok) return undefined;
    return (await res.json()) as PermissionRequestInfo;
  }

  /**
   * Responde um pedido de permissão pelo escritório. Devolve undefined se deu certo, ou a mensagem de erro
   * do servidor (pedido já respondido, acesso que não é local...).
   */
  async decidePermission(id: string, d: PermissionDecision): Promise<string | undefined> {
    if (this.mock) {
      const sim = this.mockSim;
      if (!sim?.decidePermission(id, d)) return 'Este pedido já foi respondido.';
      this.applySnapshot(sim.snapshot());
      return undefined;
    }
    const enviar = (chave: string) =>
      fetch(`/api/permissions/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(chave ? { 'X-Equipe-Chave': chave } : {}) },
        body: JSON.stringify(d),
      });
    let res = await enviar(this.equipeKey);
    // Com a chave do escritório criada no computador, aprovar pela tela exige a chave: pede uma vez e guarda.
    if (res.status === 401) {
      const digitada = globalThis.prompt?.('Chave do escritório (no terminal: equipe chave)')?.trim();
      if (!digitada) return 'Para responder pelo escritório, cole a chave (no terminal: equipe chave).';
      res = await enviar(digitada);
      if (res.status === 401) return 'A chave do escritório não confere.';
      this.equipeKey = digitada;
    }
    if (res.ok) return undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') return body.error;
    } catch {
      // Resposta sem JSON (ex.: guard): usa a mensagem padrão.
    }
    return `Não foi possível responder (erro ${res.status}).`;
  }

  /**
   * Grava o personagem do projeto (PUT /api/agents/:id/character). Devolve undefined se deu certo, ou a mensagem de
   * erro (nome em uso, acesso que não é local...).
   */
  async saveCharacter(id: string, body: { name: string; seed: number; parts: AppearanceParts }): Promise<string | undefined> {
    return this.characterRequest(id, 'PUT', body);
  }

  /** "Voltar ao sorteio": apaga o personagem do projeto (DELETE /api/agents/:id/character). */
  async resetCharacter(id: string): Promise<string | undefined> {
    return this.characterRequest(id, 'DELETE', {});
  }

  private async characterRequest(id: string, method: 'PUT' | 'DELETE', body: object): Promise<string | undefined> {
    if (this.mock || this.replay) return 'Editar o personagem só funciona com o escritório ao vivo.';
    let res: Response;
    try {
      res = await fetch(`/api/agents/${encodeURIComponent(id)}/character`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return 'Sem conexão com o Habblaud.';
    }
    if (res.ok) return undefined;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string') return data.error;
    } catch {
      // Resposta sem JSON (ex.: guard): usa a mensagem padrão.
    }
    return `Não foi possível salvar o personagem (erro ${res.status}).`;
  }

  // ---------------------------------------------------------------- mensagens pelo escritório

  /**
   * Manda uma mensagem a um agente (POST /api/messages): a mensagem criada (status `queued`) ou o erro do servidor
   * (agente que não recebe mensagens, fila cheia, acesso que não é local...). Sem conexão com o servidor: lança.
   * No ?mock=1 a entrega é fictícia (o simulador põe a atividade no agente).
   */
  async sendMessage(agentId: string, text: string): Promise<{ message: OutboxMessage } | { error: string }> {
    if (this.mock) return this.mockSend(agentId, text);
    const enviar = (chave: string) =>
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(chave ? { 'X-Equipe-Chave': chave } : {}) },
        body: JSON.stringify({ agentId, text }),
      });
    let res = await enviar(this.equipeKey);
    // Com a chave do escritório criada no computador, mandar mensagem pela tela exige a chave: pede uma vez e guarda.
    if (res.status === 401) {
      const digitada = globalThis.prompt?.('Chave do escritório (no terminal: equipe chave)')?.trim();
      if (!digitada) return { error: 'para mandar mensagem pelo escritório, cole a chave (no terminal: equipe chave)' };
      res = await enviar(digitada);
      if (res.status === 401) return { error: 'a chave do escritório não confere' };
      this.equipeKey = digitada;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Resposta sem JSON (ex.: guard): usa a mensagem padrão.
    }
    if (res.status === 201 && body && typeof body === 'object') return { message: body as OutboxMessage };
    const error = (body as { error?: unknown } | undefined)?.error;
    return { error: typeof error === 'string' ? error : `erro ${res.status}` };
  }

  /** Situação de uma mensagem (GET /api/messages/:id). null = o servidor não a conhece (404). Sem conexão: lança. */
  async messageStatus(id: string): Promise<OutboxMessage | null> {
    if (this.mock) {
      const m = this.mockOutbox.get(id);
      return m ? { ...m } : null;
    }
    const res = await fetch(`/api/messages/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`erro ${res.status}`);
    return (await res.json()) as OutboxMessage;
  }

  /** Mensagens do ?mock=1 (entregues pelo simulador depois de ~1 s). */
  private mockOutbox = new Map<string, OutboxMessage>();
  private mockSeq = 0;

  private mockSend(agentId: string, text: string): { message: OutboxMessage } | { error: string } {
    const a = this.agent(agentId);
    if (!a) return { error: 'agente desconhecido: ele já saiu do escritório?' };
    if (!a.canMessage || a.kind !== 'main' || a.status === 'offline') return { error: 'este agente não recebe mensagens agora' };
    const now = Date.now();
    const msg: OutboxMessage = { id: `mock-${now.toString(36)}-${++this.mockSeq}`, agentId, status: 'queued', createdAt: now, updatedAt: now };
    this.mockOutbox.set(msg.id, msg);
    setTimeout(() => {
      const sim = this.mockSim;
      const ok = !!sim?.receiveMessage(agentId, text);
      Object.assign(msg, { status: ok ? 'delivered' : 'failed', updatedAt: Date.now() }, ok ? {} : { error: 'o agente saiu do escritório' });
      if (ok && sim) this.applySnapshot(sim.snapshot());
    }, 1_000);
    return { message: { ...msg } };
  }

  // ---------------------------------------------------------------- internos

  private emit<K extends keyof StoreEvents>(event: K, value: StoreEvents[K]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(value);
      } catch (err) {
        console.error(`[store] listener de "${event}" falhou`, err);
      }
    });
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit('connection', state);
  }

  private applySnapshot(snap: OfficeSnapshot): void {
    const cur = this.replay ? this.live?.snap : this.snapshot;
    if (cur && snap.rev < cur.rev && snap.meta.startedAt === cur.meta.startedAt) return;
    if (this.replay) this.live = { snap, at: Date.now() };
    else this.setSnapshot(snap);
    this.checkBuild(snap.meta.build);
  }

  private setSnapshot(snap: OfficeSnapshot): void {
    this.snapshot = snap;
    this.agentIndex = new Map(snap.agents.map((a) => [a.id, a]));
    this.roomIndex = new Map(snap.rooms.map((r) => [r.id, r]));
    this.emit('snapshot', snap);
  }

  private updateAnnounced = false;
  /** Build desta página (ver pageBuild); exposto para testes. */
  pageBuildId: string | undefined = pageBuild();

  /** Avisa (uma vez) quando o servidor passou a servir outro build do cliente. */
  private checkBuild(serverBuild: string | undefined): void {
    if (this.updateAnnounced || this.mock || !serverBuild) return;
    const current = this.pageBuildId;
    if (!current || current === serverBuild) return;
    this.updateAnnounced = true;
    this.emit('update', { build: serverBuild, current });
  }

  private applyFeed(items: FeedItem[]): void {
    if (!items.length) return;
    const known = new Set(this.feed.map((f) => f.id));
    const fresh = items.filter((f) => !known.has(f.id));
    if (!fresh.length) return;
    this.feed = [...this.feed, ...fresh].slice(-FEED_LIMIT);
    this.emit('feed', fresh);
  }

  /** Lê o JSON de um evento SSE; mensagens corrompidas são ignoradas sem derrubar o stream. */
  private parse<T>(ev: Event, what: string): T | null {
    try {
      return JSON.parse((ev as MessageEvent).data) as T;
    } catch (err) {
      console.warn(`[store] ${what} inválido ignorado`, err);
      return null;
    }
  }

  private startSSE(): void {
    this.setConnection('connecting');
    let es: EventSourceLike;
    try {
      es = this.openStream('/api/stream');
    } catch (err) {
      console.error('[store] não foi possível abrir o stream', err);
      this.setConnection('closed');
      this.scheduleRetry();
      return;
    }
    this.source = es;
    // Eventos de um stream já substituído (reconexão) não valem mais.
    const current = () => this.source === es;
    es.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.clearRetry();
      this.setConnection('open');
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: o próprio navegador vai tentar de novo. CLOSED: desistiu; a reconexão fica por nossa conta.
      if (es.readyState === ES_CLOSED) {
        this.setConnection('closed');
        this.scheduleRetry();
      } else {
        this.setConnection('connecting');
      }
    });
    es.addEventListener('snapshot', (ev) => {
      if (!current()) return;
      const snap = this.parse<OfficeSnapshot>(ev, 'snapshot');
      if (snap) this.applySnapshot(snap);
    });
    es.addEventListener('feed', (ev) => {
      if (!current()) return;
      const items = this.parse<FeedItem[]>(ev, 'feed');
      if (items) this.applyFeed(items);
    });
    es.addEventListener('notice', (ev) => {
      if (!current()) return;
      const n = this.parse<Notice>(ev, 'aviso');
      if (n) this.emit('notice', n);
    });
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.mock || this.stopped) return;
    const delay = reconnectDelay(this.attempts);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.stopped && this.connection === 'closed') {
        this.closeSource();
        this.startSSE();
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  /** Simulador do modo ?mock=1 (também responde os pedidos de permissão fictícios). */
  private mockSim: DemoSimulator | null = null;

  private startMock(): void {
    if (this.mockTimer) return;
    this.setConnection('mock');
    const sim = new DemoSimulator(mockOptionsFrom(this.search));
    this.mockSim = sim;
    this.applySnapshot(sim.snapshot());
    this.mockTimer = setInterval(() => {
      const now = Date.now();
      const r = sim.tick(now);
      if (r.changed) this.applySnapshot(sim.snapshot(now));
      this.applyFeed(r.feed);
      r.notices.forEach((n) => this.emit('notice', n));
    }, 250);
  }
}
