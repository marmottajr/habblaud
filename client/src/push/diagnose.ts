// Diagnóstico das notificações push, em uma linha. Separado do resto para ser função pura: o texto que a pessoa lê
// (e dita a quem pode consertar) é testável sem navegador.
//
// Existe porque a seção se escondia em silêncio quando qualquer peça faltava, e "não aparece nada" não distingue um
// navegador sem Push API de uma sessão expirada no servidor.
import { tr } from '../../../shared/i18n';

export interface PushDiagnosis {
  /** `serviceWorker` em `navigator`. */
  serviceWorker: boolean;
  /** `PushManager` em `window` (no iPhone, só na web app da tela de início). */
  pushManager: boolean;
  /** `Notification` em `window`. */
  notification: boolean;
  /** `window.isSecureContext`: sem isso o navegador nega service worker, mesmo em HTTPS com CA própria. */
  secureContext: boolean;
  /** `standalone`, `browser`, `minimal-ui`, `fullscreen` ou `?` quando `matchMedia` não responde. */
  displayMode: string;
  /** `navigator.standalone`, que só o Safari define (undefined nos outros). */
  iosStandalone?: boolean;
  /** Código de `GET /api/push/status`; 0 = nem resposta houve. */
  statusCode: number;
  /** O servidor mandou chave pública? (sem ela não há como inscrever) */
  hasKey: boolean;
  /** Mensagem do erro de `register('/sw.js')`, quando falhou. */
  swError?: string;
  /** Este aparelho já tem inscrição no navegador. */
  subscribed: boolean;
  /** `Notification.permission`. */
  permission?: string;
}

/** O primeiro passo que falhou, em texto curto; undefined quando está tudo de pé. */
export function pushBlocker(d: PushDiagnosis): string | undefined {
  if (!d.serviceWorker) return tr('sem serviceWorker');
  if (!d.secureContext) return tr('a página não está em contexto seguro');
  if (d.statusCode === 0) return tr('/api/push/status: sem resposta');
  if (d.statusCode !== 200) return tr('/api/push/status: {0}', [d.statusCode]);
  if (!d.hasKey) return tr('o servidor não tem chave de push');
  if (d.swError) return tr('registo do sw falhou: {0}', [d.swError]);
  if (!d.pushManager) return tr('sem pushManager (abra pelo ícone da tela de início)');
  if (!d.notification) return tr('sem Notification');
  return undefined;
}

/**
 * A linha de diagnóstico inteira: o passo que falhou primeiro, seguido do que mais ajuda a distinguir as causas.
 * Curta de propósito: é para ser lida em voz alta.
 */
export function describePushDiagnosis(d: PushDiagnosis): string {
  const parts = [
    `sw: ${d.serviceWorker ? (d.swError ? `erro (${d.swError})` : 'ok') : 'falta'}`,
    `push: ${d.pushManager ? 'ok' : 'falta'}`,
    `display-mode: ${d.displayMode}`,
    `navigator.standalone: ${d.iosStandalone === undefined ? '—' : d.iosStandalone ? 'sim' : 'não'}`,
    `/api/push/status: ${d.statusCode || '—'}`,
  ];
  if (d.permission) parts.push(`permissão: ${d.permission}`);
  if (d.statusCode === 200) parts.push(`inscrito: ${d.subscribed ? 'sim' : 'não'}`);
  return parts.join(' · ');
}
