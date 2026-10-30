// Serviço de Web Push: identidade VAPID, tipos de aviso, inscrições e envio com freios.
//
// Desligado por padrão: sem HABBLAUD_PUSH_VAPID_PRIVATE e sem `<dataDir>/push-vapid.json`, `createPushService` gera o
// par na primeira vez — exceto com HABBLAUD_PUSH=0, que devolve undefined e faz as rotas /api/push/* não existirem.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';
import { parsePushEndpoint, parsePushHosts } from './hosts';
import { generateVapidKeys, publicFromPrivate } from './vapid';
import { endpointTag, PushStore, type PushSubscription } from './store';
import { sendPush, type Urgency } from './sender';
import { FILE_MODE } from './store';

export const KEY_FILE = 'push-vapid.json';
/** Texto da notificação: molde curto, sem dado nenhum dentro. O limite existe para nada vazar por descuido. */
export const TEXT_MAX = 80;

export interface PushType {
  id: string;
  /** Rótulo visível na lista de tipos (já traduzido por quem registra). */
  label: string;
  /** Ligado em um aparelho que acabou de se inscrever. */
  enabled: boolean;
  ttlS: number;
  urgency: Urgency;
}

export interface NotifyInput {
  title: string;
  body?: string;
  /** Caminho da própria origem para abrir no toque (o service worker recusa qualquer coisa com esquema ou `//`). */
  url?: string;
  /** Agrupa o freio por origem do aviso (um agente que pisca dez vezes dá um push). */
  key?: string;
}

/** Um push por `tipo|key` nesta janela. */
export const PER_KEY_MS = 60_000;
/**
 * Teto **por tipo**: dez pushes do mesmo tipo em dez minutos. Era global, e uma manhã de «precisa de você» engolia a
 * resposta do Ana na sala, que é o aviso que você está mesmo à espera.
 */
export const BURST_MAX = 10;
export const BURST_WINDOW_MS = 10 * 60_000;
/**
 * Travão do processo, acima dos tetos por tipo: ninguém passa daqui, venha de onde vier. Existe para o caso que
 * nenhum teto por tipo cobre, muitos tipos a transbordar ao mesmo tempo, e é propositadamente folgado.
 */
export const BURST_TOTAL_MAX = 20;
/** Um resumo por meia janela de rajada: a seguir a uma transbordagem, a próxima pode voltar a avisar. */
export const SUMMARY_EVERY_MS = BURST_WINDOW_MS / 2;
/** POST /api/push/test: um por minuto por processo. */
export const TEST_MS = 60_000;
/** Escritas de inscrição (subscribe, unsubscribe, prefs) por minuto, por processo. */
export const WRITES_PER_MIN = 10;
export const WRITE_WINDOW_MS = 60_000;
/** Idade máxima de uma entrada do freio por tipo e origem. Acima disto a entrada não serve e sai. */
export const KEY_KEEP_MS = 10 * PER_KEY_MS;
/**
 * Espera antes do push de resumo, depois de o teto bater. Existe para o resumo dizer um número que serve: mandado no
 * instante do primeiro aviso engolido, diria sempre "1 aviso novo".
 *
 * **Ciclo de vida do temporizador do resumo:** quem o acorda é o `notify()`, no primeiro aviso engolido sem
 * temporizador a correr; quem o mata é o próprio disparo (que o põe a `null`), o `stop()` do serviço, e o
 * `flushSummary()` quando reagenda; que teste prova que dispara e que não fica retido: «o resumo do segundo lote sai
 * sozinho, sem ninguém chamar o flush» em `service.test.ts`.
 */
export const SUMMARY_DELAY_MS = 20_000;
/** Tipo do resumo: não entra na lista de tipos (não se liga nem se desliga; é o que sobra quando o teto bate). */
export const SUMMARY_TOPIC = 'summary';

export interface PushServiceDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class PushService {
  readonly publicKey: string;
  private readonly privateKey: string;
  private readonly subject: string;
  private readonly store: PushStore;
  private readonly types = new Map<string, PushType>();
  private readonly hosts: readonly string[];
  /** Marcas de tempo das escritas de inscrição desta janela (teto de ritmo das três rotas). */
  private writes: number[] = [];
  private readonly lastByKey = new Map<string, number>();
  /** Marcas de tempo dos pushes, por tipo (teto por tipo) e no total (travão do processo). */
  private burstByType = new Map<string, number[]>();
  private burstAll: number[] = [];
  private suppressed = 0;
  /** De que tipos eram os avisos engolidos: o resumo só vai a quem tem algum deles ligado. */
  private suppressedTypes = new Set<string>();
  private lastTestAt = 0;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Quando saiu o último resumo. Era um booleano que só se desarmava com a rajada toda a envelhecer. */
  private lastSummaryAt = 0;

  constructor(
    keys: { privateKey: string; publicKey: string },
    private readonly deps: PushServiceDeps,
  ) {
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.subject = deps.env.HABBLAUD_PUSH_CONTACT?.trim() || 'mailto:habblaud@localhost';
    this.hosts = parsePushHosts(deps.env.HABBLAUD_PUSH_HOSTS);
    this.store = new PushStore(deps.dataDir);
    this.store.load();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  registerType(type: PushType): void {
    this.types.set(type.id, type);
  }

  typeList(): readonly PushType[] {
    return [...this.types.values()];
  }

  /** Estado para a página: a chave pública, os tipos e se ESTE endpoint já está inscrito. */
  status(endpoint?: string): { publicKey: string; types: { id: string; label: string; enabled: boolean }[]; subscribed: boolean; devices: number } {
    const sub = endpoint ? this.store.find(endpoint) : undefined;
    return {
      publicKey: this.publicKey,
      types: this.typeList().map((t) => ({ id: t.id, label: t.label, enabled: sub ? (sub.types[t.id] ?? t.enabled) : t.enabled })),
      subscribed: !!sub,
      devices: this.store.list().length,
    };
  }

  /** Algum aparelho tem este tipo ligado? É o que permite a quem dispara não acordar nada quando ninguém quer. */
  wants(typeId: string): boolean {
    const type = this.types.get(typeId);
    if (!type) return false;
    return this.store.list().some((s) => (s.types[typeId] ?? type.enabled));
  }

  /** O endpoint tem forma de URL `https://` e anfitrião de um serviço de push conhecido? */
  accepts(endpoint: unknown): boolean {
    return !!parsePushEndpoint(endpoint, this.hosts);
  }

  /** Lista de anfitriões em uso (para a página e para o log do arranque; não é segredo). */
  get pushHosts(): readonly string[] {
    return this.hosts;
  }

  /**
   * Teto de ritmo das escritas de inscrição. Devolve os segundos a esperar, ou 0 quando passa; **gasta** uma marca
   * quando passa, logo chama-se uma vez por pedido.
   */
  takeWrite(): number {
    const now = this.now();
    this.writes = this.writes.filter((t) => now - t < WRITE_WINDOW_MS);
    if (this.writes.length >= WRITES_PER_MIN) return Math.max(1, Math.ceil((WRITE_WINDOW_MS - (now - this.writes[0])) / 1000));
    this.writes.push(now);
    return 0;
  }

  /** Quantas entradas o freio por tipo e origem guarda agora (para o teste da poda). */
  get keyCount(): number {
    return this.lastByKey.size;
  }

  /** Já se chegou ao teto de aparelhos inscritos? */
  isFull(endpoint: string): boolean {
    return this.store.isFull(endpoint);
  }

  subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }): PushSubscription {
    const sub = this.store.upsert(input);
    // Cada escrita de inscrição deixa rasto. Só os últimos 8 caracteres do endpoint, nunca as chaves.
    this.deps.log?.(`push inscrição ${endpointTag(sub.endpoint)} gravada (${this.store.list().length} aparelhos)`);
    return sub;
  }

  unsubscribe(endpoint: string): boolean {
    const removed = this.store.remove(endpoint);
    if (removed) this.deps.log?.(`push inscrição ${endpointTag(endpoint)} apagada (${this.store.list().length} aparelhos)`);
    return removed;
  }

  setTypes(endpoint: string, types: Record<string, boolean>): boolean {
    const ok = !!this.store.setTypes(endpoint, types);
    if (ok) {
      const resumo = Object.entries(types)
        .map(([id, on]) => `${id}=${on ? 'ligado' : 'desligado'}`)
        .join(' ');
      this.deps.log?.(`push preferências ${endpointTag(endpoint)}: ${resumo}`);
    }
    return ok;
  }

  /** Passou o minuto de /test? (Consulta sem gastar: quem gasta é `send`.) */
  testReadyIn(): number {
    return Math.max(0, TEST_MS - (this.now() - this.lastTestAt));
  }

  async test(endpoint: string, text: { title: string; body: string }): Promise<{ sent: boolean; status: number; error?: string }> {
    if (this.testReadyIn() > 0) return { sent: false, status: 429 };
    const sub = this.store.find(endpoint);
    if (!sub) return { sent: false, status: 404 };
    this.lastTestAt = this.now();
    const r = await this.deliver(sub, { title: text.title, body: text.body, url: '/?app=1' }, { ttlS: 60, urgency: 'high', topic: 'test' });
    return { sent: r.ok, status: r.status, error: r.error };
  }

  /** Dispara um tipo para todos os aparelhos que o têm ligado, com os freios do processo. */
  async notify(typeId: string, input: NotifyInput): Promise<void> {
    const type = this.types.get(typeId);
    if (!type) return;
    const subs = this.store.list().filter((s) => (s.types[typeId] ?? type.enabled));
    if (!subs.length) return;

    const key = `${typeId}|${input.key ?? ''}`;
    const now = this.now();
    // Poda: uma entrada mais velha do que a janela já não travava nada e só ocupava memória num processo que corre
    // meses.
    for (const [k, at] of this.lastByKey) if (now - at > KEY_KEEP_MS) this.lastByKey.delete(k);
    const last = this.lastByKey.get(key) ?? 0;
    if (now - last < PER_KEY_MS) return;

    const fresh = (list: number[]): number[] => list.filter((t) => now - t < BURST_WINDOW_MS);
    const mine = fresh(this.burstByType.get(typeId) ?? []);
    this.burstAll = fresh(this.burstAll);
    // Poda dos tipos que pararam de disparar (um mapa por tipo não cresce, mas também não precisa de ficar).
    for (const [id, list] of this.burstByType) {
      const kept = fresh(list);
      if (kept.length) this.burstByType.set(id, kept);
      else this.burstByType.delete(id);
    }
    if (mine.length >= BURST_MAX || this.burstAll.length >= BURST_TOTAL_MAX) {
      this.suppressed++;
      this.suppressedTypes.add(typeId);
      /**
       * Um resumo por meia janela, com um atraso curto para o número significar algo.
       *
       * O agendamento acontece SEMPRE que não haja temporizador a correr; quem decide se o resumo pode sair é o
       * `flushSummary`, e o atraso espera o que falta da meia janela. Enquanto a condição da janela estava aqui, um
       * aviso engolido dentro da meia janela não agendava nada e ficava retido para sempre — o resumo do segundo
       * lote podia nunca sair.
       */
      if (!this.summaryTimer) {
        const delay = Math.max(SUMMARY_DELAY_MS, SUMMARY_EVERY_MS - (now - this.lastSummaryAt));
        this.summaryTimer = setTimeout(() => {
          this.summaryTimer = null;
          // `.catch()` obrigatório: uma promessa rejeitada sem tratamento mata o processo em Node 22.
          this.flushSummary().catch((err) => this.deps.log?.(`push: resumo falhou (${(err as Error).message})`));
        }, delay);
        this.summaryTimer.unref?.();
      }
      return;
    }
    this.lastByKey.set(key, now);
    mine.push(now);
    this.burstByType.set(typeId, mine);
    this.burstAll.push(now);

    const payload = { title: clip(input.title), body: input.body ? clip(input.body) : undefined, url: safePath(input.url), tag: typeId };
    for (const sub of [...subs]) await this.deliver(sub, payload, { ttlS: type.ttlS, urgency: type.urgency, topic: typeId });
  }

  /** Quantos avisos o teto engoliu desde o último resumo (zera na leitura, com os tipos). */
  takeSuppressed(): number {
    const n = this.suppressed;
    this.suppressed = 0;
    this.suppressedTypes.clear();
    return n;
  }

  /** Quantos estão engolidos neste momento, sem consumir (o resumo recusado não pode comer o contador). */
  get suppressedCount(): number {
    return this.suppressed;
  }

  /**
   * O push único de resumo: "{N} avisos novos no Habblaud", sem dizer de quem nem de quê. Chamado pelo temporizador
   * da rajada; exposto para o teste não ter de esperar 20 s.
   */
  async flushSummary(): Promise<void> {
    // Verificar ANTES de consumir: ao contrário, um resumo recusado levava o contador com ele e o número desaparecia.
    if (!this.suppressed) return;
    const falta = SUMMARY_EVERY_MS - (this.now() - this.lastSummaryAt);
    if (falta > 0) {
      // Cedo de mais: volta a agendar para o resto da meia janela, senão o que está engolido fica retido.
      if (!this.summaryTimer) {
        this.summaryTimer = setTimeout(() => {
          this.summaryTimer = null;
          this.flushSummary().catch((err) => this.deps.log?.(`push: resumo falhou (${(err as Error).message})`));
        }, falta);
        this.summaryTimer.unref?.();
      }
      return;
    }
    // Só os aparelhos com algum dos tipos ENGOLIDOS ligado: um aparelho que desligou o `needs-you` não tem de receber
    // o resumo de uma rajada de `needs-you`.
    const types = [...this.suppressedTypes];
    const n = this.takeSuppressed();
    this.lastSummaryAt = this.now();
    const subs = this.store.list().filter((s) => types.some((id) => (s.types[id] ?? this.types.get(id)?.enabled ?? false)));
    for (const sub of [...subs]) {
      await this.deliver(sub, { title: tr('{0} avisos novos no Habblaud', [n]), url: '/?app=1', tag: SUMMARY_TOPIC }, { ttlS: 600, urgency: 'high', topic: SUMMARY_TOPIC });
    }
  }

  /** Para o temporizador do resumo (desligar o servidor sem deixar nada pendurado). */
  stop(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
  }

  private async deliver(
    sub: PushSubscription,
    payload: { title: string; body?: string; url?: string; tag?: string },
    opts: { ttlS: number; urgency: Urgency; topic?: string },
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    // Tudo em try/catch, incluindo a escrita em disco do `remove` e do `markOk`: era por aqui que uma inscrição
    // deformada, ou um erro do sistema de ficheiros, saía como promessa rejeitada e matava o processo.
    try {
      const r = await sendPush(sub, JSON.stringify(payload), opts, {
        privateKey: this.privateKey,
        publicKey: this.publicKey,
        subject: this.subject,
        hosts: this.hosts,
        fetch: this.deps.fetch,
        now: this.deps.now,
        log: this.deps.log,
      });
      if (r.gone) this.store.remove(sub.endpoint);
      else if (r.ok) this.store.markOk(sub.endpoint);
      return { ok: r.ok, status: r.status, error: r.error };
    } catch (err) {
      this.deps.log?.(`push ${endpointTag(sub.endpoint)} -> falhou (${(err as Error).message})`);
      return { ok: false, status: 0, error: (err as Error).message.slice(0, 300) };
    }
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

/** Só caminho da própria origem: sem esquema, sem `//`, sempre começando por `/`. */
export function safePath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith('/') || url.startsWith('//')) return undefined;
  return url.slice(0, 200);
}

function truthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Lê o par do ambiente; sem ele, de `<dataDir>/push-vapid.json`; sem o arquivo, gera e grava a 600. */
export function loadVapidKeys(dataDir: string, env: NodeJS.ProcessEnv): { privateKey: string; publicKey: string } {
  const fromEnv = env.HABBLAUD_PUSH_VAPID_PRIVATE?.trim();
  if (fromEnv) return { privateKey: fromEnv, publicKey: publicFromPrivate(fromEnv) };
  const file = join(dataDir, KEY_FILE);
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const priv = (raw as { privateKey?: unknown }).privateKey;
    if (typeof priv === 'string' && priv.trim()) return { privateKey: priv.trim(), publicKey: publicFromPrivate(priv.trim()) };
  } catch {
    // arquivo ausente ou ilegível: gera abaixo
  }
  const keys = generateVapidKeys();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ privateKey: keys.privateKey, publicKey: keys.publicKey }, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
  chmodSync(file, FILE_MODE);
  return keys;
}

/** O serviço, ou undefined com HABBLAUD_PUSH=0 (aí nenhuma rota /api/push/* existe). */
export function createPushService(deps: PushServiceDeps): PushService | undefined {
  const flag = deps.env.HABBLAUD_PUSH?.trim();
  if (flag && !truthy(flag)) return undefined;
  try {
    return new PushService(loadVapidKeys(deps.dataDir, deps.env), deps);
  } catch (err) {
    deps.log?.(`push desligado: ${(err as Error).message}`);
    return undefined;
  }
}
