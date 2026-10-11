// Equipe: os agentes fixos de cada projeto, lidos do registro que o comando `equipe`
// (equipe/equipe.mjs, no host) mantém em <HABBLAUD_EQUIPE_DIR ou ~/.habblaud/equipe>/registro.json. No Docker a
// pasta entra montada somente leitura. O servidor só LÊ: quem cria, edita e apaga agente é o comando no host.
import { readFileSync, statSync } from 'node:fs';
import { errMsg, log } from '../log';
import { cleanJob } from '../model/jobs';
import { normalizeCwd } from '../model/rooms';
import { parseAgentAi, type AgentAi } from '../../shared/ia';
import { parseAgentLimit, roomAgentLimit, type RoomStyle } from '../../shared/roomstyle';

export interface EquipeAgente {
  /** Nome do arquivo do agente (`claude --agent <slug>`). */
  slug: string;
  funcao: string;
  criadoEm?: number;
  /** IA e nível deste agente (`equipe ia`): o que está fixo, o mínimo e se ele pode escolher a IA do colega. */
  ia?: AgentAi;
  /** Personagem escolhido (`equipe editar --nome --visual --semente`); o que faltar, o escritório sorteia. */
  personagem?: { nome?: string; look?: 'f' | 'm'; semente?: number };
}

export interface EquipeProjeto {
  nome: string;
  /** O nome foi escolhido pelo usuário (`equipe nome "..."`): o escritório usa como nome da sala. */
  nomeProprio?: boolean;
  agentes: EquipeAgente[];
  /** Sala (cwd normalizado) da Diretoria que dirige esta equipe: o diretor que trabalha aqui aparece lá. */
  diretoria?: string;
  /** Sala criada pela tela ("Nova sala"): existe no escritório mesmo sem agente nenhum. */
  sala?: boolean;
  /** A sala do dono: o agente dela (o dono do escritório) é com quem a pessoa conversa pela tela. */
  escritorio?: boolean;
  /** Salas (cwd normalizado) com que esta conversa: os agentes de lá podem trabalhar aqui e aparecem na sala deles. */
  ligadas?: string[];
  /** Quantos agentes fixos a sala pode ter, escolhido nas configurações dela (`equipe limite`); ausente = as mesas do layout. */
  limite?: number;
}

/** Como os agentes chamam quem usa o escritório (`equipe dono`); sem nome escolhido, o do usuário do computador. */
export interface DonoDoEscritorio {
  nome: string;
  feminino: boolean;
  /** false = o nome veio do computador (ninguém escolheu). */
  escolhido: boolean;
}

/** O dono gravado no registro, com tolerância. */
export function parseDono(raw: string): DonoDoEscritorio | undefined {
  try {
    const d = (JSON.parse(raw) as { dono?: { nome?: unknown; feminino?: unknown; escolhido?: unknown } }).dono;
    const nome = cleanJob(d?.nome)?.slice(0, 40).trim();
    return nome ? { nome, feminino: d?.feminino === true, escolhido: d?.escolhido === true } : undefined;
  } catch {
    return undefined;
  }
}

/** Sala (cwd normalizado do projeto) -> equipe. */
export type Equipes = ReadonlyMap<string, EquipeProjeto>;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_PROJETOS = 40;
const MAX_AGENTES = 40;
const MAX_BYTES = 1024 * 1024;

function limparPersonagem(raw: unknown): EquipeAgente['personagem'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { nome?: unknown; look?: unknown; semente?: unknown };
  const out: NonNullable<EquipeAgente['personagem']> = {};
  const nome = cleanJob(r.nome)?.slice(0, 24).trim();
  if (nome) out.nome = nome;
  if (r.look === 'f' || r.look === 'm') out.look = r.look;
  if (typeof r.semente === 'number' && Number.isInteger(r.semente) && r.semente >= 0 && r.semente <= 0xffffffff) out.semente = r.semente;
  return Object.keys(out).length ? out : undefined;
}

/** Lê o registro com tolerância: entradas tortas ficam de fora, nada lança. */
export function parseRegistro(raw: string): Map<string, EquipeProjeto> {
  const out = new Map<string, EquipeProjeto>();
  let j: { projetos?: unknown };
  try {
    j = JSON.parse(raw) as { projetos?: unknown };
  } catch {
    return out;
  }
  const projetos = j && typeof j === 'object' && j.projetos && typeof j.projetos === 'object' ? (j.projetos as Record<string, unknown>) : {};
  for (const [pasta, valor] of Object.entries(projetos)) {
    if (out.size >= MAX_PROJETOS) break;
    if (!pasta.startsWith('/') || !valor || typeof valor !== 'object') continue;
    const p = valor as { nome?: unknown; nomeProprio?: unknown; agentes?: unknown; diretoria?: unknown; sala?: unknown; ligadas?: unknown; escritorio?: unknown; limite?: unknown };
    const agentes: EquipeAgente[] = [];
    for (const item of Array.isArray(p.agentes) ? p.agentes : []) {
      if (agentes.length >= MAX_AGENTES) break;
      const a = (item ?? {}) as { slug?: unknown; funcao?: unknown; criadoEm?: unknown; personagem?: unknown; ia?: unknown };
      const funcao = cleanJob(a.funcao);
      if (typeof a.slug !== 'string' || !SLUG_RE.test(a.slug) || !funcao || agentes.some((x) => x.slug === a.slug)) continue;
      const agente: EquipeAgente = { slug: a.slug, funcao };
      if (typeof a.criadoEm === 'number' && Number.isFinite(a.criadoEm)) agente.criadoEm = a.criadoEm;
      const personagem = limparPersonagem(a.personagem);
      if (personagem) agente.personagem = personagem;
      const ia = parseAgentAi(a.ia);
      if (ia) agente.ia = ia;
      agentes.push(agente);
    }
    // Sem agentes só entra a sala criada pela tela (ela espera os primeiros agentes).
    if (!agentes.length && p.sala !== true) continue;
    const projeto: EquipeProjeto = { nome: cleanJob(p.nome) ?? pasta, agentes };
    if (p.sala === true) projeto.sala = true;
    if (p.escritorio === true) projeto.escritorio = true;
    if (p.nomeProprio === true && cleanJob(p.nome)) projeto.nomeProprio = true;
    if (typeof p.diretoria === 'string' && p.diretoria.startsWith('/')) projeto.diretoria = normalizeCwd(p.diretoria);
    const ligadas = (Array.isArray(p.ligadas) ? p.ligadas : []).filter((x): x is string => typeof x === 'string' && x.startsWith('/')).slice(0, MAX_PROJETOS).map((x) => normalizeCwd(x));
    if (ligadas.length) projeto.ligadas = [...new Set(ligadas)];
    const limite = parseAgentLimit(p.limite);
    if (limite) projeto.limite = limite;
    out.set(normalizeCwd(pasta), projeto);
  }
  return out;
}

export interface EquipeRegistroOptions {
  /** registro.json; null = sem equipe (testes). */
  file: string | null;
  onChange?: () => void;
  /** Intervalo da releitura (a pasta montada no Docker não avisa de mudanças). */
  intervalMs?: number;
}

export class EquipeRegistro {
  private atual = new Map<string, EquipeProjeto>();
  private marca = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private donoAtual: DonoDoEscritorio | undefined;

  constructor(private readonly opts: EquipeRegistroOptions) {}

  equipes(): Equipes {
    return this.atual;
  }

  /** Como os agentes chamam quem usa o escritório, pelo que o comando gravou no registro. */
  dono(): DonoDoEscritorio | undefined {
    return this.donoAtual;
  }

  /** Relê o arquivo se ele mudou (tamanho ou data). Devolve true se a equipe mudou. */
  load(): boolean {
    const file = this.opts.file;
    if (!file) return false;
    let marca = '';
    let raw = '';
    try {
      const st = statSync(file);
      marca = `${st.size}:${st.mtimeMs}`;
      if (marca === this.marca) return false;
      if (st.size > MAX_BYTES) throw new Error('arquivo grande demais');
      raw = readFileSync(file, 'utf8');
      log.clearOnce('equipe-read');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warnOnce('equipe-read', `registro da equipe ilegível (${errMsg(err)}).`);
      if (!this.marca && !this.atual.size) return false;
      marca = '';
    }
    this.marca = marca;
    const novo = raw ? parseRegistro(raw) : new Map<string, EquipeProjeto>();
    const dono = raw ? parseDono(raw) : undefined;
    const mudou = JSON.stringify([...novo]) !== JSON.stringify([...this.atual]) || JSON.stringify(dono) !== JSON.stringify(this.donoAtual);
    this.atual = novo;
    this.donoAtual = dono;
    return mudou;
  }

  start(): void {
    if (!this.opts.file || this.timer) return;
    this.load();
    this.timer = setInterval(() => {
      if (this.load()) this.opts.onChange?.();
    }, this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** A sala é a Diretoria de alguma equipe (alguma equipe aponta para ela em `diretoria`). */
export function ehDiretoria(equipes: Equipes, sala: string): boolean {
  for (const [pasta, e] of equipes) if (pasta !== sala && e.diretoria === sala) return true;
  return false;
}

/**
 * A aparência que vale numa sala de equipe: a escolhida; sem layout escolhido, a sala do dono é a de uma pessoa só
 * e a Diretoria é a de quatro gabinetes.
 */
export function estiloDaSala(equipes: Equipes, sala: string, escolhido: RoomStyle | undefined): RoomStyle | undefined {
  if (escolhido?.layout) return escolhido;
  const equipe = equipes.get(sala);
  if (!equipe) return escolhido;
  if (equipe.escritorio) return escolhido ?? { layout: 'individual' };
  if (ehDiretoria(equipes, sala)) return { ...escolhido, layout: 'diretoria' };
  return escolhido;
}

/** Quantos agentes fixos esta sala de equipe pode ter: o limite escolhido, sem passar das mesas do layout. */
export function limiteDaSala(equipes: Equipes, sala: string, escolhido: RoomStyle | undefined): number | undefined {
  const equipe = equipes.get(sala);
  if (!equipe || equipe.escritorio) return undefined;
  return roomAgentLimit(estiloDaSala(equipes, sala, escolhido), equipe.limite);
}
