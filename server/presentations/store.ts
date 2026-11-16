// Apresentações na TV das salas (shared/presentation.ts). O agente principal grava os slides em
// <dir>/<pasta da sala>/<data>-<título>/slides.md; aqui:
// - a pasta é relida a cada poucos segundos (só as pastas das salas abertas agora; no Docker é uma montagem somente
//   leitura, onde os eventos do sistema de arquivos não chegam, por isso a varredura e não um watch);
// - cada apresentação ganha um id opaco (o navegador nunca vê caminhos) e o título vem do primeiro "#" dos slides;
// - "assistida" fica em <dataDir>/presentations.json (vale para o computador e o celular);
// - o pedido pela TV vai ao agente pelo registro de mensagens (como se você tivesse digitado) e deixa a TV em
//   "Preparando…" até a apresentação aparecer na pasta da sala, a mensagem falhar ou o prazo vencer;
// - uma apresentação nova (depois da primeira varredura) vira o aviso "📺 Apresentação pronta".
// As imagens dos slides: só as citadas no texto; um caminho relativo vale dentro da pasta da apresentação e um
// absoluto passa pelo leitor de arquivos das entregas (deliveries/fetcher.ts: checagens dele e, no Docker, o auxiliar
// do host).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tr } from '../../shared/i18n';
import {
  FOLDER_RE,
  imageSources,
  joinHostPath,
  presentationRequestText,
  presentationTitle,
  PRESENTATION_MAX_BYTES,
  roomFolder,
  SLIDES_FILE,
  splitSlides,
  type PresentationContent,
  type PresentationSummary,
  type RoomTv,
} from '../../shared/presentation';
import type { AgentInfo, OutboxStatus } from '../../shared/types';
import { fileType } from '../deliveries/files';
import type { FetchResult } from '../deliveries/fetcher';
import { errMsg, log } from '../log';

/** Intervalo da varredura da pasta. */
export const SCAN_MS = 3_000;
/** Pedido sem apresentação nesse tempo: a TV sai do "Preparando…". */
export const REQUEST_TIMEOUT_MS = 20 * 60_000;
/** Imagem dentro da pasta da apresentação: no máximo isto. */
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
/** Assistidas guardadas (as mais antigas saem). */
const SEEN_MAX = 2_000;
const STATE_FILE = 'presentations.json';

interface Entry extends PresentationSummary {
  /** Pasta da apresentação (onde o servidor lê). */
  folder: string;
  mtime: number;
  size: number;
}

interface Pending {
  agentId: string;
  at: number;
  messageId: string;
}

export type RequestResult = { ok: true; messageId: string } | { error: string; status: number };

export interface PresentationStoreOptions {
  /** Onde o servidor lê (no Docker, a montagem). */
  dir: string;
  /** A mesma pasta no computador do usuário (vai no pedido ao agente). */
  hostDir: string;
  /** Onde fica presentations.json (assistidas). */
  dataDir: string;
  /** Salas abertas agora. */
  rooms: () => ReadonlyArray<{ id: string; name: string }>;
  agent: (id: string) => AgentInfo | undefined;
  /** Manda o pedido ao agente (MessageRegistry.send). Ausente = mensagens desligadas: a TV não pede. */
  send?: (agentId: string, text: string) => { messageId: string } | { error: string };
  /** Situação da mensagem do pedido (MessageRegistry.get). */
  messageStatus?: (id: string) => OutboxStatus | undefined;
  /** Arquivo de fora da pasta (imagem citada com caminho absoluto): o leitor das entregas. */
  readFile?: (path: string) => Promise<FetchResult>;
  /** Algo mudou no estado das TVs (o snapshot sai de novo). */
  onChange: () => void;
  /** Apresentação nova numa sala. */
  onReady: (roomId: string, title: string) => void;
  now?: () => number;
}

function idOf(room: string, folder: string): string {
  return createHash('sha256').update(`${room}/${folder}`).digest('base64url').slice(0, 22);
}

export class PresentationStore {
  private readonly now: () => number;
  private entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private booted = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tvKey = '';

  constructor(private readonly opts: PresentationStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.loadSeen();
  }

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), SCAN_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** O pedido pela TV está ligado (há como mandar mensagem ao agente). */
  get canRequest(): boolean {
    return !!this.opts.send;
  }

  // ---------------------------------------------------------------- varredura

  /** Relê as pastas das salas abertas. Público para os testes. */
  scan(): void {
    const next = new Map<string, Entry>();
    const fresh: Entry[] = [];
    for (const room of this.opts.rooms()) {
      const rf = roomFolder(room.id);
      const base = join(this.opts.dir, rf);
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!FOLDER_RE.test(name)) continue;
        const folder = join(base, name);
        const file = join(folder, SLIDES_FILE);
        let st: { mtimeMs: number; size: number; isFile(): boolean };
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size === 0) continue;
        const id = idOf(rf, name);
        const prev = this.entries.get(id);
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.roomId === room.id) {
          next.set(id, prev);
          continue;
        }
        const markdown = this.readSlides(file);
        if (markdown === undefined) continue;
        const e: Entry = {
          id,
          roomId: room.id,
          title: presentationTitle(markdown) ?? name.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-?/, '').replace(/-/g, ' ') ?? name,
          at: Math.round(st.mtimeMs),
          slides: splitSlides(markdown).length,
          seen: this.seenSet.has(id),
          folder,
          mtime: st.mtimeMs,
          size: st.size,
        };
        if (!e.title) e.title = name;
        next.set(id, e);
        if (!prev) fresh.push(e);
      }
    }
    this.entries = next;
    if (this.booted) {
      for (const e of fresh.sort((a, b) => a.at - b.at)) {
        const p = this.pending.get(e.roomId);
        if (p && e.at >= p.at - 60_000) this.pending.delete(e.roomId);
        this.opts.onReady(e.roomId, e.title);
      }
    }
    this.booted = true;
    this.prunePending();
    this.changed();
  }

  private readSlides(file: string): string | undefined {
    try {
      const buf = readFileSync(file);
      return buf.subarray(0, PRESENTATION_MAX_BYTES).toString('utf8');
    } catch (err) {
      log.warn(tr('[apresentações] não deu para ler {0}: {1}', [file, errMsg(err)]));
      return undefined;
    }
  }

  /** Pedidos que venceram, cuja mensagem falhou ou cujo agente saiu: a TV sai do "Preparando…". */
  private prunePending(): void {
    const now = this.now();
    for (const [roomId, p] of this.pending) {
      const a = this.opts.agent(p.agentId);
      const status = this.opts.messageStatus?.(p.messageId);
      if (now - p.at > REQUEST_TIMEOUT_MS || status === 'failed' || !a || a.status === 'offline' || a.status === 'done') this.pending.delete(roomId);
    }
  }

  /** Avisa a mudança só quando o estado das TVs mudou de fato. */
  private changed(): void {
    const key = JSON.stringify([...this.tvs()].sort(([a], [b]) => (a < b ? -1 : 1)));
    if (key === this.tvKey) return;
    this.tvKey = key;
    this.opts.onChange();
  }

  // ---------------------------------------------------------------- consultas

  /** Estado da TV de cada sala que tem apresentação ou pedido (as outras: desligada). */
  tvs(): Map<string, RoomTv> {
    const out = new Map<string, RoomTv>();
    const latest = new Map<string, Entry>();
    const count = new Map<string, number>();
    for (const e of this.entries.values()) {
      count.set(e.roomId, (count.get(e.roomId) ?? 0) + 1);
      const l = latest.get(e.roomId);
      if (!l || e.at > l.at) latest.set(e.roomId, e);
    }
    for (const [roomId, e] of latest) out.set(roomId, { state: this.seenSet.has(e.id) ? 'ready' : 'new', title: e.title, count: count.get(roomId) ?? 0 });
    for (const roomId of this.pending.keys()) out.set(roomId, { ...(out.get(roomId) ?? { count: 0 }), state: 'preparing' });
    return out;
  }

  /** Apresentações de uma sala, a mais recente primeiro. */
  list(roomId: string): PresentationSummary[] {
    return [...this.entries.values()]
      .filter((e) => e.roomId === roomId)
      .sort((a, b) => b.at - a.at)
      .map((e) => this.summary(e));
  }

  private summary(e: Entry): PresentationSummary {
    return { id: e.id, roomId: e.roomId, title: e.title, at: e.at, slides: e.slides, seen: this.seenSet.has(e.id) };
  }

  /** Uma apresentação com o texto, ou undefined (id desconhecido ou arquivo sumiu). */
  content(id: string): PresentationContent | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    const markdown = this.readSlides(join(e.folder, SLIDES_FILE));
    return markdown === undefined ? undefined : { ...this.summary(e), markdown };
  }

  /** Uma imagem citada nos slides. */
  async image(id: string, src: string): Promise<{ data: Buffer; type: string; name: string } | { error: string; status: number }> {
    const e = this.entries.get(id);
    if (!e) return { error: tr('apresentação desconhecida'), status: 404 };
    const markdown = this.readSlides(join(e.folder, SLIDES_FILE));
    if (markdown === undefined || !imageSources(markdown).includes(src)) return { error: tr('imagem fora da apresentação'), status: 404 };
    const type = fileType(src.split(/[?#]/)[0]);
    if (!type || type.kind !== 'image') return { error: tr('tipo de arquivo não suportado'), status: 415 };
    const name = src.split(/[\\/]/).pop() || 'imagem';
    if (isAbsolute(src) || /^[a-z]:[\\/]/i.test(src)) {
      if (!this.opts.readFile) return { error: tr('imagens de fora da pasta desligadas'), status: 404 };
      const r = await this.opts.readFile(src.replace(/\\/g, '/'));
      return 'data' in r ? { data: r.data, type: type.type, name } : r;
    }
    // relativo: dentro da pasta da apresentação (e sem sair dela por link simbólico)
    try {
      const root = realpathSync(e.folder);
      const real = realpathSync(resolve(e.folder, src));
      const rel = relative(root, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return { error: tr('caminho inválido'), status: 400 };
      const st = statSync(real);
      if (!st.isFile()) return { error: tr('arquivo não encontrado'), status: 404 };
      if (st.size > IMAGE_MAX_BYTES) return { error: tr('arquivo grande demais'), status: 413 };
      return { data: readFileSync(real), type: type.type, name };
    } catch {
      return { error: tr('arquivo não encontrado'), status: 404 };
    }
  }

  // ---------------------------------------------------------------- ações

  /** Marca como assistida (a TV sai do "nova"). */
  markSeen(id: string): boolean {
    if (!this.entries.has(id)) return false;
    if (!this.seenSet.has(id)) {
      this.seen.push(id);
      if (this.seen.length > SEEN_MAX) this.seen = this.seen.slice(-SEEN_MAX);
      this.seenSet = new Set(this.seen);
      this.saveSeen();
      this.changed();
    }
    return true;
  }

  /** Pede uma apresentação ao agente principal da sala: manda o texto do pedido e deixa a TV em "Preparando…". */
  request(roomId: string, agentId: string): RequestResult {
    if (!this.opts.send) return { error: tr('o pedido pela TV precisa das mensagens pelo escritório (plugin habblaud-mensagens)'), status: 403 };
    const room = this.opts.rooms().find((r) => r.id === roomId);
    if (!room) return { error: tr('sala não encontrada'), status: 404 };
    const agent = this.opts.agent(agentId);
    if (!agent || agent.roomId !== roomId) return { error: tr('esse agente não está nesta sala'), status: 404 };
    if (agent.kind !== 'main') return { error: tr('só o agente principal recebe o pedido'), status: 409 };
    const now = this.now();
    const text = presentationRequestText(joinHostPath(this.opts.hostDir, roomFolder(roomId)), now);
    const sent = this.opts.send(agentId, text);
    if ('error' in sent) return { error: sent.error, status: 409 };
    this.pending.set(roomId, { agentId, at: now, messageId: sent.messageId });
    this.changed();
    return { ok: true, messageId: sent.messageId };
  }

  // ---------------------------------------------------------------- assistidas

  private loadSeen(): void {
    try {
      const raw = JSON.parse(readFileSync(join(this.opts.dataDir, STATE_FILE), 'utf8')) as { seen?: unknown };
      if (Array.isArray(raw.seen)) this.seen = raw.seen.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(-SEEN_MAX);
    } catch {
      this.seen = [];
    }
    this.seenSet = new Set(this.seen);
  }

  private saveSeen(): void {
    const file = join(this.opts.dataDir, STATE_FILE);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seen: this.seen }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      log.warn(tr('[apresentações] não deu para gravar {0}: {1}', [file, errMsg(err)]));
    }
  }
}
