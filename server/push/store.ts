// Inscrições de push em disco: `<dataDir>/push-subscriptions.json`, modo 600, escrita atômica.
//
// O arquivo guarda o endereço do servidor de push de cada aparelho e as chaves que cifram o corpo. Quem tiver este
// arquivo e a chave privada VAPID manda notificação para os aparelhos de quem roda o Habblaud: por isso 600, por isso
// nunca sai da pasta de dados, e por isso nenhum log imprime o endpoint inteiro (ver `endpointTag`).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PushKeys } from './encrypt';
import { isWellFormedEndpoint } from './hosts';

export const FILE_NAME = 'push-subscriptions.json';
export const FILE_MODE = 0o600;
/** Rótulo do aparelho guardado junto da inscrição: curto, só para a pessoa se reconhecer na lista. */
export const LABEL_MAX = 60;
/**
 * Teto de aparelhos. Um utilizador com telemóvel, tablet e dois computadores fica muito longe disto; o teto existe
 * porque sem ele cada pedido à rota de inscrição acrescentava 4 KB ao ficheiro e uma chamada de rede a cada aviso
 *.
 */
export const MAX_SUBSCRIPTIONS = 10;

export interface PushSubscription {
  id: string;
  endpoint: string;
  keys: PushKeys;
  /** Tipos ligados neste aparelho (id do tipo -> ligado). Tipo ausente segue o padrão do registro. */
  types: Record<string, boolean>;
  createdAt: number;
  /** Último envio aceito pelo servidor de push (201/202). */
  lastOkAt?: number;
  label?: string;
}

/** Os últimos 8 caracteres do endpoint: o bastante para casar duas linhas de log, pouco para mandar um push. */
export function endpointTag(endpoint: string): string {
  return `…${endpoint.slice(-8)}`;
}

function sane(raw: unknown): PushSubscription | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  // Forma conferida com `new URL` e não por expressão regular: `https://[` passava o teste antigo, ficava gravado e
  // derrubava o processo no primeiro envio. Uma linha dessas, já no ficheiro, é descartada aqui.
  if (!isWellFormedEndpoint(o.endpoint) || typeof o.endpoint !== 'string') return undefined;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return undefined;
  const types: Record<string, boolean> = {};
  if (o.types && typeof o.types === 'object') {
    for (const [k, v] of Object.entries(o.types as Record<string, unknown>)) if (typeof v === 'boolean') types[k] = v;
  }
  return {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    endpoint: o.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    types,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    lastOkAt: typeof o.lastOkAt === 'number' ? o.lastOkAt : undefined,
    label: typeof o.label === 'string' ? o.label.slice(0, LABEL_MAX) : undefined,
  };
}

export class PushStore {
  private readonly file: string;
  private subs: PushSubscription[] = [];

  constructor(dataDir: string) {
    this.file = join(dataDir, FILE_NAME);
  }

  /** Lê o arquivo (ausente ou corrompido = lista vazia; nada estoura no início do servidor). */
  load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      this.subs = Array.isArray(raw) ? raw.map(sane).filter((s): s is PushSubscription => !!s) : [];
    } catch {
      this.subs = [];
    }
  }

  list(): readonly PushSubscription[] {
    return this.subs;
  }

  find(endpoint: string): PushSubscription | undefined {
    return this.subs.find((s) => s.endpoint === endpoint);
  }

  /** Já se chegou ao teto de aparelhos? (um aparelho que já está inscrito não conta: reinscrever-se é atualizar) */
  isFull(endpoint: string): boolean {
    return !this.find(endpoint) && this.subs.length >= MAX_SUBSCRIPTIONS;
  }

  /** Inscreve ou atualiza o aparelho pelo endpoint (o mesmo aparelho reinscrito não vira uma segunda linha). */
  upsert(input: { endpoint: string; keys: PushKeys; label?: string; types?: Record<string, boolean> }): PushSubscription {
    const found = this.find(input.endpoint);
    const sub: PushSubscription = found
      ? { ...found, keys: input.keys, label: input.label?.slice(0, LABEL_MAX) ?? found.label, types: input.types ?? found.types }
      : {
          id: randomUUID(),
          endpoint: input.endpoint,
          keys: input.keys,
          types: input.types ?? {},
          createdAt: Date.now(),
          label: input.label?.slice(0, LABEL_MAX),
        };
    this.subs = [...this.subs.filter((s) => s.endpoint !== input.endpoint), sub];
    this.save();
    return sub;
  }

  remove(endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length === before) return false;
    this.save();
    return true;
  }

  setTypes(endpoint: string, types: Record<string, boolean>): PushSubscription | undefined {
    const sub = this.find(endpoint);
    if (!sub) return undefined;
    sub.types = { ...sub.types, ...types };
    this.save();
    return sub;
  }

  markOk(endpoint: string): void {
    const sub = this.find(endpoint);
    if (!sub) return;
    sub.lastOkAt = Date.now();
    this.save();
  }

  /** Arquivo temporário + rename: um servidor morto no meio da escrita não deixa JSON pela metade. */
  private save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.subs, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
    // O `mode` do writeFileSync só vale na criação; um arquivo temporário que já existia pode ter vindo frouxo.
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, this.file);
    chmodSync(this.file, FILE_MODE);
  }
}
