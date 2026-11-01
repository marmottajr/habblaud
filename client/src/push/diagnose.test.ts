// A linha de diagnóstico do push é para alguém ler em voz alta ao telefone. Estes testes travam a ordem dos passos
// (o primeiro que falha é o que se diz) e garantem que nada do escritório entra nela.
import { describe, expect, it } from 'vitest';
import { describePushDiagnosis, pushBlocker, type PushDiagnosis } from './diagnose';

const ok: PushDiagnosis = {
  serviceWorker: true,
  pushManager: true,
  notification: true,
  secureContext: true,
  displayMode: 'standalone',
  iosStandalone: true,
  statusCode: 200,
  hasKey: true,
  subscribed: true,
  permission: 'granted',
};

describe('pushBlocker', () => {
  it('com tudo de pé não há nada a dizer', () => {
    expect(pushBlocker(ok)).toBeUndefined();
  });

  it('nomeia o primeiro passo que falhou, na ordem em que se resolve', () => {
    expect(pushBlocker({ ...ok, serviceWorker: false, secureContext: false, statusCode: 0 })).toBe('sem serviceWorker');
    expect(pushBlocker({ ...ok, secureContext: false, statusCode: 0 })).toBe('a página não está em contexto seguro');
    expect(pushBlocker({ ...ok, statusCode: 0 })).toBe('/api/push/status: sem resposta');
    expect(pushBlocker({ ...ok, statusCode: 401 })).toBe('/api/push/status: 401');
    expect(pushBlocker({ ...ok, hasKey: false })).toBe('o servidor não tem chave de push');
    expect(pushBlocker({ ...ok, swError: 'MIME type text/html' })).toBe('registo do sw falhou: MIME type text/html');
    expect(pushBlocker({ ...ok, pushManager: false })).toBe('sem pushManager (abra pelo ícone da tela de início)');
    expect(pushBlocker({ ...ok, notification: false })).toBe('sem Notification');
  });

  it('o erro do service worker vem antes da falta de pushManager', () => {
    // No iPhone os dois aparecem juntos quando a app não está em standalone; o erro do registo é o que ajuda mais.
    expect(pushBlocker({ ...ok, swError: 'erro x', pushManager: false })).toBe('registo do sw falhou: erro x');
  });
});

describe('describePushDiagnosis', () => {
  it('cabe numa linha e traz as cinco peças que distinguem as causas', () => {
    const line = describePushDiagnosis({ ...ok, subscribed: false, permission: 'default' });
    expect(line).toBe('sw: ok · push: ok · display-mode: standalone · navigator.standalone: sim · /api/push/status: 200 · permissão: default · inscrito: não');
    expect(line).not.toContain('\n');
  });

  it('diz o que falta, com a mensagem do erro do registo', () => {
    const line = describePushDiagnosis({ ...ok, swError: 'MIME text/html', pushManager: false, displayMode: 'browser', iosStandalone: false });
    expect(line).toContain('sw: erro (MIME text/html)');
    expect(line).toContain('push: falta');
    expect(line).toContain('display-mode: browser');
    expect(line).toContain('navigator.standalone: não');
  });

  it('fora do Safari, navigator.standalone aparece como ausente', () => {
    expect(describePushDiagnosis({ ...ok, iosStandalone: undefined })).toContain('navigator.standalone: —');
  });

  it('sem resposta do servidor, o código aparece vazio e não como zero', () => {
    const line = describePushDiagnosis({ ...ok, statusCode: 0 });
    expect(line).toContain('/api/push/status: —');
    expect(line).not.toContain('inscrito:');
  });
});
