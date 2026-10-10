// Rotinas dos agentes fixos (ver o README.md): uma demanda que se repete em dias e
// hora marcados. Ficam em <dataDir>/rotinas.json. Na hora, o servidor põe um pedido na mesma fila das demandas
// pedidas pela tela (server/equipe/pedidos.ts); quem abre o terminal continua sendo o serviço do host.
//
// O relógio é o do servidor. No Docker, o `docker:up` passa o fuso do computador (TZ), então "9h" é 9h de lá.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';
import { normalizeCwd } from '../model/rooms';
import { limparPedido, PEDIDO_MAX } from './pedidos';

export interface Rotina {
  id: string;
  /** Pasta do projeto (a sala). */
  room: string;
  /** Agente fixo que recebe a demanda. */
  slug: string;
  pedido: string;
  /** Dias da semana em que roda: 0 = domingo ... 6 = sábado. (Vazio quando a rotina é por intervalo.) */
  dias: number[];
  /** Hora local, "HH:MM". (Vazia quando a rotina é por intervalo.) */
  hora: string;
  /** Rotina por intervalo: roda a cada tantos minutos, em vez de em dias e hora marcados. */
  intervaloMin?: number;
  /**
   * Rotina por gatilho: roda quando chega item novo neste caminho do computador (arquivo novo numa pasta, ou
   * linha nova numa planilha .csv). Quem olha o caminho é o serviço do host (`equipe servir`); o relógio não a dispara.
   */
  gatilho?: string;
  ativa: boolean;
  criadaEm: number;
  /** Próxima vez em que deve rodar (epoch ms). */
  proxima: number;
  /** Última vez em que rodou, e como foi. */
  ultima?: number;
  ultimoAviso?: string;
}

interface RotinasFile {
  versao: 1;
  rotinas: Rotina[];
}

export class RotinaInvalida extends Error {}

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ROTINAS = 100;
/** Intervalo mínimo e máximo de uma rotina por intervalo (cada vez abre uma sessão: muito curto gasta demais). */
export const INTERVALO_MIN = 15;
export const INTERVALO_MAX = 7 * 24 * 60;

/** Rotina atrasada mais que isto (computador desligado, Habblaud parado) não roda: pula para a próxima vez. */
export const ATRASO_MAX_MS = 6 * 3_600_000;

/** Próxima data local, depois de `apos`, que cai num dos `dias` às `hora`. */
export function proximaOcorrencia(dias: readonly number[], hora: string, apos: number): number {
  const m = HORA_RE.exec(hora);
  if (!m || !dias.length) return Number.POSITIVE_INFINITY;
  const base = new Date(apos);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() > apos && dias.includes(d.getDay())) return d.getTime();
  }
  return Number.POSITIVE_INFINITY;
}

/** Quando a rotina roda de novo, contado a partir de `apos`. */
export function proximaVez(r: Pick<Rotina, 'dias' | 'hora' | 'intervaloMin' | 'gatilho'>, apos: number): number {
  if (r.gatilho) return Number.MAX_SAFE_INTEGER;
  return r.intervaloMin ? apos + r.intervaloMin * 60_000 : proximaOcorrencia(r.dias, r.hora, apos);
}

/** Lê o "quando" de um corpo de pedido: intervalo (em minutos) ou dias e hora. Lança se não for válido. */
function lerQuando(b: { dias?: unknown; hora?: unknown; intervaloMin?: unknown; gatilho?: unknown }): Quando {
  if (typeof b.gatilho === 'string' && b.gatilho.trim()) {
    const caminho = limparPedido(b.gatilho, GATILHO_MAX)?.replace(/\s*\n\s*/g, ' ');
    if (!caminho || !/^(~\/|\/)/.test(caminho)) throw new RotinaInvalida('caminho inválido: comece por ~/ ou /, por exemplo ~/Documents/pedidos/novos.csv');
    return { dias: [], hora: '', gatilho: caminho };
  }
  if (b.intervaloMin !== undefined && b.intervaloMin !== null && b.intervaloMin !== 0) {
    const n = Number(b.intervaloMin);
    if (!Number.isInteger(n) || n < INTERVALO_MIN || n > INTERVALO_MAX) throw new RotinaInvalida(`intervalo inválido: use de ${INTERVALO_MIN} minutos a 7 dias`);
    return { dias: [], hora: '', intervaloMin: n };
  }
  const dias = limparDias(b.dias);
  if (!dias) throw new RotinaInvalida('escolha pelo menos um dia da semana');
  if (typeof b.hora !== 'string' || !HORA_RE.test(b.hora)) throw new RotinaInvalida('hora inválida: use HH:MM');
  return { dias, hora: b.hora };
}

type Quando = Pick<Rotina, 'dias' | 'hora' | 'intervaloMin' | 'gatilho'>;
const GATILHO_MAX = 400;
/** Itens novos que cabem numa demanda disparada por gatilho. */
const NOVIDADES_MAX = 30;

function limparDias(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const dias = [...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return dias.length ? dias : undefined;
}

export interface RotinasOptions {
  /** rotinas.json; null = só em memória (testes). */
  file: string | null;
  /** O agente é da equipe do projeto? */
  existe: (room: string, slug: string) => boolean;
  /** Põe o pedido na fila do serviço do host (`pedido`: o texto, quando difere do prompt base). Lança se não der. */
  disparar: (r: Rotina, pedido?: string) => void;
  now?: () => number;
  newId?: () => string;
}

export class Rotinas {
  private lista: Rotina[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: RotinasOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  load(): void {
    if (!this.opts.file) return;
    try {
      const j = JSON.parse(readFileSync(this.opts.file, 'utf8')) as Partial<RotinasFile>;
      const out: Rotina[] = [];
      for (const r of Array.isArray(j.rotinas) ? j.rotinas : []) {
        const pedido = limparPedido(r?.pedido);
        if (!r || typeof r.id !== 'string' || typeof r.room !== 'string' || typeof r.slug !== 'string' || !pedido) continue;
        let quando: Quando;
        try {
          quando = lerQuando(r);
        } catch {
          continue;
        }
        const limpa: Rotina = { id: r.id, room: r.room, slug: r.slug, pedido, ...quando, ativa: r.ativa !== false, criadaEm: Number(r.criadaEm) || 0, proxima: Number(r.proxima) || proximaVez(quando, this.now()) };
        if (typeof r.ultima === 'number') limpa.ultima = r.ultima;
        if (typeof r.ultimoAviso === 'string') limpa.ultimoAviso = r.ultimoAviso;
        out.push(limpa);
      }
      this.lista = out.slice(0, MAX_ROTINAS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`rotinas.json ilegível (${errMsg(err)}); começando sem rotinas.`);
    }
  }

  private save(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ versao: 1, rotinas: this.lista } satisfies RotinasFile, null, 2)}\n`);
      renameSync(tmp, file);
      log.clearOnce('rotinas-write');
    } catch (err) {
      log.warnOnce('rotinas-write', `Não foi possível gravar ${file} (${errMsg(err)}); as rotinas valem só nesta execução.`);
    }
  }

  /** Rotinas de uma sala (ou todas), na ordem de criação. */
  listar(room?: string): Rotina[] {
    const alvo = room === undefined ? undefined : normalizeCwd(room);
    return this.lista.filter((r) => alvo === undefined || r.room === alvo).map((r) => ({ ...r, dias: [...r.dias] }));
  }

  criar(body: unknown): Rotina {
    const b = (body ?? {}) as { room?: unknown; slug?: unknown; pedido?: unknown; dias?: unknown; hora?: unknown; intervaloMin?: unknown; gatilho?: unknown };
    if (typeof b.room !== 'string' || typeof b.slug !== 'string') throw new RotinaInvalida('esperado {room, slug, pedido} e dias e hora, ou intervaloMin, ou gatilho');
    const room = normalizeCwd(b.room);
    if (!this.opts.existe(room, b.slug)) throw new RotinaInvalida('este agente não é da equipe deste projeto');
    const pedido = limparPedido(b.pedido, PEDIDO_MAX);
    if (!pedido) throw new RotinaInvalida('escreva o que o agente deve fazer na rotina');
    const quando = lerQuando(b);
    if (this.lista.length >= MAX_ROTINAS) throw new RotinaInvalida(`há rotinas demais (máximo ${MAX_ROTINAS}); apague alguma`);
    const agora = this.now();
    const r: Rotina = { id: this.newId(), room, slug: b.slug, pedido, ...quando, ativa: true, criadaEm: agora, proxima: proximaVez(quando, agora) };
    this.lista.push(r);
    this.save();
    return { ...r };
  }

  /** Liga ou desliga. Ao religar, a próxima vez é contada a partir de agora (nada de rodar o atrasado). */
  ligar(id: string, ativa: boolean): Rotina | undefined {
    const r = this.lista.find((x) => x.id === id);
    if (!r) return undefined;
    r.ativa = ativa;
    if (ativa) r.proxima = proximaVez(r, this.now());
    this.save();
    return { ...r };
  }

  /** Edita o agente, o prompt base ou o "quando" de uma rotina. Só muda o que vier no corpo. */
  editar(id: string, body: unknown): Rotina | undefined {
    const r = this.lista.find((x) => x.id === id);
    if (!r) return undefined;
    const b = (body ?? {}) as { room?: unknown; slug?: unknown; pedido?: unknown; dias?: unknown; hora?: unknown; intervaloMin?: unknown; gatilho?: unknown };
    const room = typeof b.room === 'string' ? normalizeCwd(b.room) : r.room;
    const slug = typeof b.slug === 'string' ? b.slug : r.slug;
    if ((room !== r.room || slug !== r.slug) && !this.opts.existe(room, slug)) throw new RotinaInvalida('este agente não é da equipe deste projeto');
    let pedido = r.pedido;
    if (b.pedido !== undefined) {
      const limpo = limparPedido(b.pedido, PEDIDO_MAX);
      if (!limpo) throw new RotinaInvalida('escreva o que o agente deve fazer na rotina');
      pedido = limpo;
    }
    const mudouQuando = b.dias !== undefined || b.hora !== undefined || b.intervaloMin !== undefined || b.gatilho !== undefined;
    const quando = mudouQuando ? lerQuando({ dias: b.dias ?? r.dias, hora: b.hora ?? r.hora, intervaloMin: b.intervaloMin, gatilho: b.gatilho }) : undefined;
    Object.assign(r, { room, slug, pedido });
    if (quando) {
      r.dias = quando.dias;
      r.hora = quando.hora;
      if (quando.intervaloMin) r.intervaloMin = quando.intervaloMin;
      else delete r.intervaloMin;
      if (quando.gatilho) r.gatilho = quando.gatilho;
      else delete r.gatilho;
      r.proxima = proximaVez(r, this.now());
    }
    delete r.ultimoAviso;
    this.save();
    return { ...r, dias: [...r.dias] };
  }

  /** Roda agora, fora da hora (para testar). A próxima vez marcada não muda. */
  rodarAgora(id: string): Rotina | undefined {
    const r = this.lista.find((x) => x.id === id);
    if (!r) return undefined;
    if (!this.opts.existe(r.room, r.slug)) throw new RotinaInvalida('este agente não é mais da equipe do projeto');
    this.opts.disparar(r);
    r.ultima = this.now();
    delete r.ultimoAviso;
    this.save();
    return { ...r, dias: [...r.dias] };
  }

  /**
   * O serviço do host viu itens novos no caminho do gatilho: abre a demanda com o prompt base e a lista do que
   * chegou. Rotina desligada, sem gatilho ou sem novidade não roda (devolve a rotina como está).
   */
  dispararGatilho(id: string, body: unknown): Rotina | undefined {
    const r = this.lista.find((x) => x.id === id);
    if (!r) return undefined;
    const b = (body ?? {}) as { novidades?: unknown; cabecalho?: unknown };
    const novidades = (Array.isArray(b.novidades) ? b.novidades : [])
      .map((n) => limparPedido(n, 700)?.replace(/\s+/g, ' '))
      .filter((n): n is string => !!n)
      .slice(0, NOVIDADES_MAX);
    if (!r.gatilho || !r.ativa || !novidades.length) return { ...r, dias: [...r.dias] };
    if (!this.opts.existe(r.room, r.slug)) throw new RotinaInvalida('este agente não é mais da equipe do projeto');
    const cabecalho = limparPedido(b.cabecalho, 400)?.replace(/\s+/g, ' ');
    const texto = [r.pedido, '', `O que chegou de novo em ${r.gatilho}:`, ...(cabecalho ? [`(colunas: ${cabecalho})`] : []), ...novidades.map((n) => `- ${n}`)].join('\n');
    this.opts.disparar(r, limparPedido(texto, PEDIDO_MAX));
    r.ultima = this.now();
    delete r.ultimoAviso;
    this.save();
    return { ...r, dias: [...r.dias] };
  }

  apagar(id: string): boolean {
    const antes = this.lista.length;
    this.lista = this.lista.filter((x) => x.id !== id);
    if (this.lista.length === antes) return false;
    this.save();
    return true;
  }

  /** Dispara o que venceu. Devolve quantas rodaram. */
  tick(): number {
    const agora = this.now();
    let rodaram = 0;
    let mudou = false;
    for (const r of this.lista) {
      if (!r.ativa || r.gatilho || agora < r.proxima) continue;
      const atraso = agora - r.proxima;
      r.proxima = proximaVez(r, agora);
      mudou = true;
      if (atraso > ATRASO_MAX_MS) {
        r.ultimoAviso = 'pulada: o computador estava desligado ou o Habblaud parado na hora marcada';
        continue;
      }
      if (!this.opts.existe(r.room, r.slug)) {
        r.ultimoAviso = 'não rodou: este agente não é mais da equipe do projeto';
        continue;
      }
      try {
        this.opts.disparar(r);
        r.ultima = agora;
        delete r.ultimoAviso;
        rodaram++;
      } catch (err) {
        r.ultimoAviso = `não rodou: ${errMsg(err)}`;
      }
    }
    if (mudou) this.save();
    return rodaram;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
