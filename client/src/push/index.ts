// Notificações push desta página (Web Push): registro do service worker, inscrição no toque do botão e conversa com
// /api/push/*.
//
// No iOS só funciona na web app adicionada à tela de início (Safari 16.4+), e o pedido de permissão tem de sair de um
// gesto direto da pessoa — por isso `enable()` só é chamado no clique do botão, nunca na carga da página.

import type { PushDiagnosis } from './diagnose';

export type PushState = 'unsupported' | 'off' | 'denied' | 'on';

export interface PushStatus {
  publicKey: string;
  types: { id: string; label: string; enabled: boolean }[];
  subscribed: boolean;
  devices: number;
  testReadyIn?: number;
}

/** Mensagem do service worker a pedir à página que vá a um caminho (toque na notificação com a app já aberta). */
export const OPEN_MESSAGE = 'habblaud-push-open';

/**
 * O caminho que uma mensagem do service worker pede, ou undefined quando não é para nós. Função pura: é o que se pode
 * testar sem navegador, e é onde a restrição à própria origem tem de estar.
 */
export function openRequestPath(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { type?: unknown; url?: unknown };
  if (d.type !== OPEN_MESSAGE || typeof d.url !== 'string') return undefined;
  if (!d.url.startsWith('/') || d.url.startsWith('//')) return undefined;
  return d.url;
}

/**
 * Liga o ouvinte das mensagens do service worker. Chamado uma vez, no registo: é o caminho do toque na notificação
 * quando a app já está aberta (no iPhone, o caso comum), porque aí o `WindowClient.navigate()` não é de confiança.
 */
export function listenForOpen(go: (url: string) => void = (url) => location.assign(url)): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const onMessage = (ev: MessageEvent): void => {
    const url = openRequestPath(ev.data);
    if (url) go(url);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** O navegador tem as três peças (service worker, PushManager, Notification)? */
export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const raw = atob((text + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Rótulo curto do aparelho para a pessoa se reconhecer na lista (não é identificação, é memória). */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'navegador';
}

/** Código HTTP da última chamada (0 = nem resposta houve): é o que a linha de diagnóstico mostra. */
let lastCode = 0;

async function api<T>(path: string, body?: unknown): Promise<T | undefined> {
  lastCode = 0;
  try {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    lastCode = res.status;
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Como o navegador está a mostrar a página (no iPhone, `standalone` é a web app da tela de início). */
function displayMode(): string {
  try {
    for (const mode of ['standalone', 'fullscreen', 'minimal-ui', 'browser']) if (matchMedia(`(display-mode: ${mode})`).matches) return mode;
    return 'desconhecido';
  } catch {
    return '?';
  }
}

export class PushClient {
  private reg?: ServiceWorkerRegistration;
  private status?: PushStatus;
  private statusCode = 0;
  private swError?: string;
  private stopListening?: () => void;

  /**
   * Pergunta ao servidor. Nada aqui esconde nada: quem decide o que mostrar é a seção, com o diagnóstico na mão.
   *
   * Duas chamadas: `/status` traz a chave pública e os tipos com os valores de omissão; com uma inscrição neste
   * aparelho, `/state` traz os valores GUARDADOS para ele. Sem a segunda, os interruptores mostravam o padrão e o
   * primeiro toque num tipo desligado voltava a desligá-lo.
   */
  async load(): Promise<PushStatus | undefined> {
    this.status = await api<PushStatus>('/api/push/status');
    this.statusCode = lastCode;
    if (this.status) await this.refreshState();
    return this.status;
  }

  /** Relê o estado deste aparelho (depois de uma inscrição ou de mudar um tipo). */
  async refreshState(): Promise<PushStatus | undefined> {
    const sub = await this.current().catch(() => null);
    if (!sub) return this.status;
    const mine = await api<PushStatus>('/api/push/state', { endpoint: sub.endpoint });
    if (mine) this.status = mine;
    return this.status;
  }

  /** Registra o service worker, guardando a mensagem do erro quando falha (é o passo que mais falha no iOS). */
  async register(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      this.swError = 'sem serviceWorker';
      return false;
    }
    try {
      // Escopo explícito: o service worker vive na raiz e precisa de alcançar `/?app=1`.
      this.reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      this.swError = undefined;
      this.stopListening ??= listenForOpen();
      return true;
    } catch (err) {
      this.swError = ((err as Error)?.message || String(err)).slice(0, 120);
      return false;
    }
  }

  /** Código da última resposta de `/api/push/status`: 404 = recurso desligado no servidor. */
  get lastStatusCode(): number {
    return this.statusCode;
  }

  /** Tudo o que se sabe sobre por que o push dá ou não dá neste aparelho. */
  async diagnose(): Promise<PushDiagnosis> {
    const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { standalone?: boolean });
    return {
      serviceWorker: !!nav && 'serviceWorker' in nav,
      pushManager: typeof window !== 'undefined' && 'PushManager' in window,
      notification: typeof window !== 'undefined' && 'Notification' in window,
      secureContext: typeof window !== 'undefined' && !!window.isSecureContext,
      displayMode: displayMode(),
      iosStandalone: nav?.standalone,
      statusCode: this.statusCode,
      hasKey: !!this.status?.publicKey,
      swError: this.swError,
      subscribed: !!(await this.current().catch(() => null)),
      permission: typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : undefined,
    };
  }

  async current(): Promise<PushSubscription | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || typeof window === 'undefined' || !('PushManager' in window)) return null;
    const reg = this.reg ?? (await navigator.serviceWorker.getRegistration());
    if (!reg) return null;
    this.reg = reg;
    return reg.pushManager.getSubscription();
  }

  async state(): Promise<PushState> {
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return (await this.current()) ? 'on' : 'off';
  }

  /** Pede a permissão e inscreve ESTE aparelho. Chamar só de dentro de um clique. */
  async enable(): Promise<PushState> {
    if (!pushSupported()) return 'unsupported';
    const status = this.status ?? (await this.load());
    if (!status?.publicKey) return 'off';
    if (!(await this.register())) return 'off';
    if ((await Notification.requestPermission()) !== 'granted') return Notification.permission === 'denied' ? 'denied' : 'off';
    const reg = this.reg!;
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(status.publicKey) }));
    const sent = await api<PushStatus>('/api/push/subscribe', {
      endpoint: sub.endpoint,
      keys: { p256dh: bytesToB64url(sub.getKey('p256dh')), auth: bytesToB64url(sub.getKey('auth')) },
      label: deviceLabel(),
    });
    if (!sent) return 'off';
    this.status = sent;
    return 'on';
  }

  async disable(): Promise<void> {
    const sub = await this.current();
    if (!sub) return;
    await api('/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => undefined);
  }

  async setType(id: string, on: boolean): Promise<PushStatus | undefined> {
    const sub = await this.current();
    if (!sub) return undefined;
    const r = await api<PushStatus>('/api/push/prefs', { endpoint: sub.endpoint, types: { [id]: on } });
    if (r) this.status = r;
    return r;
  }

  /** Manda um push de teste só para este aparelho. */
  async test(): Promise<boolean> {
    const sub = await this.current();
    if (!sub) return false;
    return !!(await api<{ ok: boolean }>('/api/push/test', { endpoint: sub.endpoint }));
  }

  get types(): { id: string; label: string; enabled: boolean }[] {
    return this.status?.types ?? [];
  }
}
