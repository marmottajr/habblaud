// `Hub.onNotice`: quem escuta os avisos transmitidos (hoje, as notificações push). Os avisos só saem do escritório
// pelo `commit()` que o Hub drena, então é aqui que se escuta — e sem mexer no que o SSE já manda.
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { Notice } from '../../shared/types';
import { Hub } from './sse';

function build(): { office: Office; hub: Hub } {
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/tmp', env: {}, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
  });
  late.office = office;
  return { office, hub: new Hub(office, { throttleMs: 10 }) };
}

/** Um agente que entra e passa a `waiting`: é o que gera o aviso de nível `alert` (office.ts). */
function waiting(office: Office): void {
  office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  office.setStatus('.claude:1', 'waiting', 'apagar /tmp/dados');
}

describe('Hub.onNotice', () => {
  it('entrega cada aviso transmitido a quem escuta', () => {
    const { office, hub } = build();
    const seen: Notice[] = [];
    hub.onNotice((n) => seen.push(n));
    waiting(office);
    hub.flush();
    expect(seen.some((n) => n.level === 'alert')).toBe(true);
  });

  it('o aviso chega inteiro, com nível e agente', () => {
    const { office, hub } = build();
    const seen: Notice[] = [];
    hub.onNotice((n) => seen.push(n));
    waiting(office);
    hub.flush();
    const alert = seen.find((n) => n.level === 'alert')!;
    expect(alert.agentId).toBe('.claude:1');
    expect(typeof alert.text).toBe('string');
  });

  it('cancelar a escuta para de entregar', () => {
    const { office, hub } = build();
    let n = 0;
    const off = hub.onNotice(() => n++);
    waiting(office);
    hub.flush();
    const first = n;
    expect(first).toBeGreaterThan(0);
    off();
    office.setStatus('.claude:1', 'working');
    office.setStatus('.claude:1', 'waiting', 'outra coisa');
    hub.flush();
    expect(n).toBe(first);
  });

  it('uma exceção de quem escuta não derruba a transmissão nem os outros ouvintes', () => {
    const { office, hub } = build();
    let outro = 0;
    hub.onNotice(() => {
      throw new Error('quem escuta explodiu');
    });
    hub.onNotice(() => outro++);
    waiting(office);
    expect(() => hub.flush()).not.toThrow();
    expect(outro).toBeGreaterThan(0);
  });

  it('sem ninguém a escutar, o flush continua a devolver o snapshot', () => {
    const { office, hub } = build();
    waiting(office);
    expect(hub.flush().agents).toHaveLength(1);
  });
});

/**
 * A premissa do projeto inteiro: com a app fechada e zero páginas ligadas, o aviso continua a sair do escritório e a
 * chegar a quem escuta. Os outros testes chamam `flush()` à mão, logo um `if (!this.clients.size) return` acrescentado
 * um dia por boa intenção passava a bateria toda e matava as notificações.
 */
describe('Hub.onNotice sem ninguém ligado', () => {
  it('o aviso chega ao ouvinte pelo caminho automático, com zero clientes SSE', async () => {
    const { office, hub } = build();
    const seen: Notice[] = [];
    hub.onNotice((n) => seen.push(n));
    hub.start();
    try {
      expect(hub.size).toBe(0);
      waiting(office);
      // Sem `flush()` à mão: quem transmite é o temporizador do próprio Hub, acordado pelo `onChange` do escritório.
      await new Promise<void>((ok) => setTimeout(ok, 120));
      expect(hub.size).toBe(0);
      expect(seen.some((n) => n.level === 'alert')).toBe(true);
    } finally {
      hub.stop();
    }
  });
});
