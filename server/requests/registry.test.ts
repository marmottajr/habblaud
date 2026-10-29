// Registro dos pedidos externos: validação, repetição segura (source + externalId), escolha única, retirada, long-poll,
// prazo e esquecimento dos encerrados.
import { describe, expect, it } from 'vitest';
import { KEEP_MS, OPTIONS_MAX, parseRequest, PENDING_MAX, RequestRegistry, TTL_MIN_MS } from './registry';

const body = (over: Record<string, unknown> = {}) => ({
  source: 'painel',
  externalId: 'dec-1',
  title: 'Qual banco usar?',
  text: 'O projeto loja precisa de um banco.',
  options: [
    { id: 'pg', label: 'Postgres', description: 'O de sempre' },
    { id: 'sqlite', label: 'SQLite' },
  ],
  recommended: 'pg',
  ...over,
});

function setup() {
  let now = 1_000_000;
  let changes = 0;
  const reg = new RequestRegistry({ onChange: () => changes++, now: () => now });
  return { reg, advance: (ms: number) => (now += ms), changes: () => changes };
}

function idOf(r: ReturnType<RequestRegistry['register']>): string {
  if ('error' in r) throw new Error(r.error);
  return r.result.id;
}

describe('parseRequest', () => {
  it('aceita o pedido completo e corta os textos longos', () => {
    const p = parseRequest(body({ title: 'x'.repeat(500) }));
    expect(p.title).toHaveLength(200);
    expect(p.options).toEqual([{ id: 'pg', label: 'Postgres', description: 'O de sempre' }, { id: 'sqlite', label: 'SQLite' }]);
    expect(p.recommended).toBe('pg');
  });

  it('recusa corpo sem campos, opções repetidas, recomendada que não existe e opções demais', () => {
    expect(() => parseRequest(null)).toThrow();
    expect(() => parseRequest(body({ source: '' }))).toThrow(/source/);
    expect(() => parseRequest(body({ title: '  ' }))).toThrow(/title/);
    expect(() => parseRequest(body({ options: [] }))).toThrow(/options/);
    expect(() => parseRequest(body({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }))).toThrow(/repetido/);
    expect(() => parseRequest(body({ recommended: 'mysql' }))).toThrow(/recommended/);
    const many = Array.from({ length: OPTIONS_MAX + 1 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }));
    expect(() => parseRequest(body({ options: many, recommended: undefined }))).toThrow(/options/);
    expect(() => parseRequest(body({ externalId: 'x'.repeat(201) }))).toThrow(/externalId/);
  });

  it('ttl em segundos, limitado', () => {
    expect(parseRequest(body({ ttl: 1 })).ttlMs).toBe(TTL_MIN_MS);
    expect(parseRequest(body({ ttl: 600 })).ttlMs).toBe(600_000);
    expect(() => parseRequest(body({ ttl: 'muito' }))).toThrow(/ttl/);
  });
});

describe('RequestRegistry', () => {
  it('registra, publica nos pendentes e devolve o mesmo pedido ao repetir source + externalId', () => {
    const { reg, changes } = setup();
    const a = reg.register(body());
    expect(a).toMatchObject({ created: true, result: { status: 'pending', source: 'painel', externalId: 'dec-1' } });
    const b = reg.register(body({ title: 'outro título' }));
    expect(b).toMatchObject({ created: false });
    expect(idOf(b)).toBe(idOf(a));
    expect(reg.pending()).toHaveLength(1);
    expect(reg.pending()[0]).toMatchObject({ title: 'Qual banco usar?', recommended: 'pg' });
    expect(changes()).toBe(1);
    // Outra origem com o mesmo externalId é outro pedido.
    expect(idOf(reg.register(body({ source: 'outro' })))).not.toBe(idOf(a));
  });

  it('escolha única: a segunda dá conflito; opção desconhecida é inválida; desconhecido é not-found', () => {
    const { reg } = setup();
    const id = idOf(reg.register(body()));
    expect(reg.decide(id, 'mysql')).toBe('invalid');
    expect(reg.decide(id, 'sqlite')).toBe('ok');
    expect(reg.decide(id, 'pg')).toBe('conflict');
    expect(reg.decide('nao-existe', 'pg')).toBe('not-found');
    expect(reg.result(id)).toMatchObject({ status: 'decided', option: 'sqlite' });
    expect(reg.pending()).toEqual([]);
    // Registrar de novo um pedido já escolhido devolve o resultado (não abre outro).
    expect(reg.register(body())).toMatchObject({ created: false, result: { status: 'decided', option: 'sqlite' } });
    expect(reg.withdraw(id)).toBe('conflict');
  });

  it('retirar: some dos pendentes e não aceita mais escolha', () => {
    const { reg } = setup();
    const id = idOf(reg.register(body()));
    expect(reg.withdraw(id)).toBe('ok');
    expect(reg.withdraw(id)).toBe('not-found');
    expect(reg.decide(id, 'pg')).toBe('not-found');
    expect(reg.result(id)).toMatchObject({ status: 'withdrawn' });
    // Registrar de novo depois de retirar abre um pedido novo; o antigo continua consultável.
    const again = reg.register(body());
    expect(again).toMatchObject({ created: true, result: { status: 'pending' } });
    expect(idOf(again)).not.toBe(id);
    expect(reg.result(id)).toMatchObject({ status: 'withdrawn' });
  });

  it('expira no prazo e esquece os encerrados depois de KEEP_MS', () => {
    const { reg, advance } = setup();
    const id = idOf(reg.register(body({ ttl: 120 })));
    advance(120_000);
    expect(reg.result(id)).toMatchObject({ status: 'expired' });
    expect(reg.decide(id, 'pg')).toBe('not-found');
    // Expirado: o mesmo externalId abre um pedido novo, que sobrevive ao esquecimento do antigo.
    const fresh = idOf(reg.register(body()));
    expect(fresh).not.toBe(id);
    advance(KEEP_MS + 1);
    expect(reg.result(id)).toBeUndefined();
    expect(reg.result(fresh)).toMatchObject({ status: 'pending' });
    expect(reg.register(body())).toMatchObject({ created: false, result: { id: fresh } });
  });

  it('long-poll: resolve na escolha; sem escolha, no tempo pedido, ainda pendente', async () => {
    const { reg } = setup();
    const id = idOf(reg.register(body()));
    const w = reg.wait(id, 5_000)!;
    reg.decide(id, 'pg');
    await expect(w.result).resolves.toMatchObject({ status: 'decided', option: 'pg' });
    const id2 = idOf(reg.register(body({ externalId: 'dec-2' })));
    await expect(reg.wait(id2, 20)!.result).resolves.toMatchObject({ status: 'pending' });
    expect(reg.wait('nao-existe', 20)).toBeUndefined();
  });

  it('limite de pendentes', () => {
    const { reg } = setup();
    for (let i = 0; i < PENDING_MAX; i++) idOf(reg.register(body({ externalId: `d${i}` })));
    expect(reg.register(body({ externalId: 'mais-um' }))).toEqual({ error: 'full' });
    // Repetir um que já existe continua valendo.
    expect(reg.register(body({ externalId: 'd0' }))).toMatchObject({ created: false });
  });
});
