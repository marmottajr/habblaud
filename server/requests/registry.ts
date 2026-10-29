// Pedidos externos: um serviço local (um painel de decisões, um script) registra uma pergunta com opções e espera a
// escolha feita no escritório, sem precisar de uma sessão do Claude.
//
// O serviço manda o pedido para POST /api/requests e espera em GET /api/requests/:id/wait (long-poll) ou consulta
// GET /api/requests/:id. A página escolhe em POST /api/requests/:id/decision. O registro:
// - devolve o mesmo pedido quando o serviço registra de novo o mesmo par source + externalId, pendente ou escolhido
//   (repetir é seguro); expirado ou retirado, abre um pedido novo;
// - publica os pedidos pendentes no snapshot (OfficeSnapshot.requests) e avisa o Office a cada mudança;
// - aceita uma escolha só (a segunda dá conflito) e só entre as opções do pedido;
// - expira os pedidos sem escolha no prazo e guarda o resultado dos encerrados por KEEP_MS, para a consulta.
// Tudo fica na memória: depois de reiniciar o Habblaud, o serviço registra de novo.
import { randomBytes } from 'node:crypto';
import { tr } from '../../shared/i18n';
import type { ExternalRequestInfo, ExternalRequestOption } from '../../shared/types';

/** Espera máxima de um long-poll (o serviço chama de novo se o pedido continuar pendente). */
export const WAIT_MAX_MS = 60_000;
/** Prazo padrão de um pedido sem escolha, e os limites do `ttl` (segundos) que o serviço pode pedir. */
export const TTL_DEFAULT_MS = 24 * 3_600_000;
export const TTL_MIN_MS = 60_000;
export const TTL_MAX_MS = 7 * 24 * 3_600_000;
/** Por quanto tempo um pedido encerrado (escolhido, expirado ou retirado) ainda responde à consulta. */
export const KEEP_MS = 3_600_000;
export const PENDING_MAX = 100;
export const OPTIONS_MAX = 8;

const LIMITS = { source: 40, externalId: 200, title: 200, text: 4_000, optionId: 64, label: 120, description: 300 };

export type ExternalRequestStatus = 'pending' | 'decided' | 'expired' | 'withdrawn';

/** O que o serviço lê na consulta e no long-poll. */
export interface ExternalRequestResult {
  id: string;
  source: string;
  externalId: string;
  status: ExternalRequestStatus;
  /** ExternalRequestOption.id escolhido (só em `decided`). */
  option?: string;
  decidedAt?: number;
  expiresAt: number;
}

export type RegisterResult = { created: boolean; result: ExternalRequestResult } | { error: 'invalid'; message: string } | { error: 'full' };
export type DecideResult = 'ok' | 'not-found' | 'conflict' | 'invalid';
export type WithdrawResult = 'ok' | 'not-found' | 'conflict';

export interface RequestRegistryOptions {
  /** Chamado a cada mudança na lista de pendentes (Office.markDirty). */
  onChange: () => void;
  now?: () => number;
  /** Intervalo da checagem de prazos. */
  tickMs?: number;
}

interface Entry {
  info: ExternalRequestInfo;
  status: ExternalRequestStatus;
  option?: string;
  decidedAt?: number;
  /** Quando o pedido saiu de `pending` (conta o KEEP_MS). */
  closedAt?: number;
  waiters: Set<() => void>;
}

/** Corpo inválido: a mensagem diz o que faltou. */
export class InvalidRequest extends Error {}

function text(value: unknown, max: number, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new InvalidRequest(tr('{0}: obrigatório', [field]));
    return undefined;
  }
  if (typeof value !== 'string') throw new InvalidRequest(tr('{0}: esperado texto', [field]));
  const v = value.trim();
  if (!v) {
    if (required) throw new InvalidRequest(tr('{0}: obrigatório', [field]));
    return undefined;
  }
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Identificadores não são cortados: o serviço precisa receber de volta exatamente o que mandou. */
function ident(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidRequest(tr('{0}: obrigatório', [field]));
  if (value.length > max) throw new InvalidRequest(tr('{0}: até {1} caracteres', [field, max]));
  return value;
}

export interface ParsedRequest {
  source: string;
  externalId: string;
  title: string;
  text?: string;
  options: ExternalRequestOption[];
  recommended?: string;
  ttlMs: number;
}

/** Valida o corpo de POST /api/requests. Lança InvalidRequest. */
export function parseRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidRequest(tr('esperado um objeto JSON'));
  const b = body as Record<string, unknown>;
  const source = ident(b.source, LIMITS.source, 'source');
  const externalId = ident(b.externalId, LIMITS.externalId, 'externalId');
  const title = text(b.title, LIMITS.title, 'title', true)!;
  const body_ = text(b.text, LIMITS.text, 'text', false);
  if (!Array.isArray(b.options) || b.options.length < 1 || b.options.length > OPTIONS_MAX) {
    throw new InvalidRequest(tr('options: de 1 a {0} opções', [OPTIONS_MAX]));
  }
  const ids = new Set<string>();
  const options = b.options.map((o, i): ExternalRequestOption => {
    if (!o || typeof o !== 'object') throw new InvalidRequest(tr('{0}: esperado {id, label, description?}', [`options[${i}]`]));
    const r = o as Record<string, unknown>;
    const id = ident(r.id, LIMITS.optionId, `options[${i}].id`);
    if (ids.has(id)) throw new InvalidRequest(tr('{0}: repetido', [`options[${i}].id`]));
    ids.add(id);
    const description = text(r.description, LIMITS.description, `options[${i}].description`, false);
    return { id, label: text(r.label, LIMITS.label, `options[${i}].label`, true)!, ...(description ? { description } : {}) };
  });
  let recommended: string | undefined;
  if (b.recommended !== undefined && b.recommended !== null) {
    if (typeof b.recommended !== 'string' || !ids.has(b.recommended)) throw new InvalidRequest(tr('recommended: precisa ser o id de uma das opções'));
    recommended = b.recommended;
  }
  let ttlMs = TTL_DEFAULT_MS;
  if (b.ttl !== undefined && b.ttl !== null) {
    if (typeof b.ttl !== 'number' || !Number.isFinite(b.ttl)) throw new InvalidRequest(tr('ttl: esperado um número de segundos'));
    ttlMs = Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, b.ttl * 1_000));
  }
  return { source, externalId, title, ...(body_ ? { text: body_ } : {}), options, ...(recommended ? { recommended } : {}), ttlMs };
}

export class RequestRegistry {
  private readonly entries = new Map<string, Entry>();
  /** source + externalId -> id. */
  private readonly byExternal = new Map<string, string>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RequestRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.opts.tickMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const e of this.entries.values()) this.wake(e);
  }

  register(body: unknown): RegisterResult {
    let p: ParsedRequest;
    try {
      p = parseRequest(body);
    } catch (err) {
      if (err instanceof InvalidRequest) return { error: 'invalid', message: err.message };
      throw err;
    }
    this.sweep();
    const key = `${p.source}\n${p.externalId}`;
    const known = this.entries.get(this.byExternal.get(key) ?? '');
    if (known && (known.status === 'pending' || known.status === 'decided')) return { created: false, result: this.resultOf(known) };
    if (this.pendingCount() >= PENDING_MAX) return { error: 'full' };
    const now = this.now();
    const id = randomBytes(9).toString('base64url');
    const { ttlMs, ...rest } = p;
    const entry: Entry = { info: { id, ...rest, createdAt: now, expiresAt: now + ttlMs }, status: 'pending', waiters: new Set() };
    this.entries.set(id, entry);
    this.byExternal.set(key, id);
    this.opts.onChange();
    return { created: true, result: this.resultOf(entry) };
  }

  /** Resultado atual (undefined = desconhecido ou encerrado há mais de KEEP_MS). */
  result(id: string): ExternalRequestResult | undefined {
    this.sweep();
    const e = this.entries.get(id);
    return e ? this.resultOf(e) : undefined;
  }

  /**
   * Long-poll: resolve quando o pedido sai de `pending` ou depois de `ms`, com o resultado do momento. `cancel` larga a
   * espera (a conexão caiu). Undefined = pedido desconhecido.
   */
  wait(id: string, ms: number): { result: Promise<ExternalRequestResult>; cancel: () => void } | undefined {
    this.sweep();
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.status !== 'pending') return { result: Promise.resolve(this.resultOf(e)), cancel: () => {} };
    let done!: () => void;
    const result = new Promise<ExternalRequestResult>((ok) => {
      const timer = setTimeout(() => done(), Math.min(ms, WAIT_MAX_MS));
      done = () => {
        clearTimeout(timer);
        e.waiters.delete(done);
        ok(this.resultOf(e));
      };
      e.waiters.add(done);
    });
    return { result, cancel: () => e.waiters.delete(done) };
  }

  /** A escolha feita na página. */
  decide(id: string, option: string): DecideResult {
    this.sweep();
    const e = this.entries.get(id);
    if (!e || e.status === 'expired' || e.status === 'withdrawn') return 'not-found';
    if (e.status === 'decided') return 'conflict';
    if (!e.info.options.some((o) => o.id === option)) return 'invalid';
    e.option = option;
    e.decidedAt = this.now();
    this.close(e, 'decided');
    return 'ok';
  }

  /** O serviço retira o pedido (resolvido em outro lugar). */
  withdraw(id: string): WithdrawResult {
    this.sweep();
    const e = this.entries.get(id);
    if (!e || e.status === 'expired' || e.status === 'withdrawn') return 'not-found';
    if (e.status === 'decided') return 'conflict';
    this.close(e, 'withdrawn');
    return 'ok';
  }

  /** Pendentes, do mais antigo para o mais recente (vão no snapshot). */
  pending(): ExternalRequestInfo[] {
    const out: ExternalRequestInfo[] = [];
    for (const e of this.entries.values()) if (e.status === 'pending') out.push(e.info);
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Expira os pendentes vencidos e esquece os encerrados há mais de KEEP_MS. */
  sweep(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      if (e.status === 'pending' && now >= e.info.expiresAt) this.close(e, 'expired');
      else if (e.status !== 'pending' && now - (e.closedAt ?? now) > KEEP_MS) {
        this.entries.delete(id);
        const key = `${e.info.source}\n${e.info.externalId}`;
        // O par pode já apontar para um pedido novo (registrado de novo depois de expirar ou ser retirado).
        if (this.byExternal.get(key) === id) this.byExternal.delete(key);
      }
    }
  }

  private close(e: Entry, status: Exclude<ExternalRequestStatus, 'pending'>): void {
    e.status = status;
    e.closedAt = this.now();
    this.wake(e);
    this.opts.onChange();
  }

  private wake(e: Entry): void {
    for (const w of [...e.waiters]) w();
  }

  private pendingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === 'pending') n++;
    return n;
  }

  private resultOf(e: Entry): ExternalRequestResult {
    return {
      id: e.info.id,
      source: e.info.source,
      externalId: e.info.externalId,
      status: e.status,
      ...(e.option !== undefined ? { option: e.option } : {}),
      ...(e.decidedAt !== undefined ? { decidedAt: e.decidedAt } : {}),
      expiresAt: e.info.expiresAt,
    };
  }
}
