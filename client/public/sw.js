// Service worker do Habblaud: existe só para as notificações push. Não guarda nada em cache e não intercepta fetch —
// a página continua a vir do servidor como antes.
//
// JavaScript puro de propósito: este arquivo não passa pelo bundler (client/public vai inteiro para dist/client) e o
// servidor o entrega com `no-cache` (server/http/static.ts), que é o que um service worker precisa para se atualizar.

/** Texto de reserva se o corpo do push vier vazio ou ilegível (um push sem notificação faz o iOS cancelar a inscrição). */
const FALLBACK = { title: 'Habblaud', body: '', url: '/?app=1', tag: 'habblaud' };

/** Só caminho da própria origem: nada com esquema, nada começando por `//`. */
function safePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return FALLBACK.url;
  return url;
}

function parse(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (!data || typeof data.title !== 'string' || !data.title) return FALLBACK;
    return {
      title: data.title,
      body: typeof data.body === 'string' ? data.body : '',
      url: safePath(data.url),
      tag: typeof data.tag === 'string' && data.tag ? data.tag : FALLBACK.tag,
    };
  } catch {
    return FALLBACK;
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const n = parse(event);
  // Sempre uma notificação visível: o iOS revoga a inscrição de quem recebe push e não mostra nada.
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      // Mesmo `tag` por tipo: o aviso novo substitui o anterior em vez de empilhar na tela de bloqueio.
      tag: n.tag,
      renotify: true,
      icon: '/assets/brand/icon-192.png',
      badge: '/assets/brand/favicon-32.png',
      data: { url: n.url },
    }),
  );
});

/** A página avisa que recebeu a mensagem; sem isso o service worker não sabe se ela a tratou. */
const OPEN_MESSAGE = 'habblaud-push-open';

/**
 * Janela já aberta: foca e **pede à página para ir ela própria ao caminho**, por `postMessage`. No iPhone a PWA fica
 * viva em segundo plano, logo este é o caso comum, e o `WindowClient.navigate()` não é de confiança aí: sem ele, a
 * app ganhava foco e ficava no ecrã onde estava, o que parece funcionar e não leva a lado nenhum. A navegação pelo
 * service worker fica como reserva, e o `openWindow` como última.
 */
function openInExisting(w, target) {
  return w
    .focus()
    .then((focused) => {
      const client = focused || w;
      try {
        client.postMessage({ type: OPEN_MESSAGE, url: target });
      } catch {
        // página sem ouvinte (versão antiga em memória): sobra a navegação abaixo
      }
      return client;
    })
    .then((client) => (client.navigate ? client.navigate(target).catch(() => undefined) : undefined))
    .catch(() => undefined);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        return openInExisting(w, target);
      }
      return self.clients.openWindow(target);
    }),
  );
});
