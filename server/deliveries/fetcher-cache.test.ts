import { describe, expect, it } from 'vitest';
import { FileFetcher } from './fetcher';

const ok = (p: string) => ({ path: p, size: 3 });
const CACHE_MAX_BYTES = 80 * 1024 * 1024;
// O teto por arquivo em `remember` é CACHE_MAX_BYTES / 4; 1/5 do teto cabe.
const FIFTH = CACHE_MAX_BYTES / 5;

/**
 * O contador do cache (`cacheBytes`) tem de bater com a soma real das entradas.
 *
 * `get` devolve a entrada para o fim da fila com `delete` + `set`, e `set` numa
 * chave existente substitui o Buffer sem devolver os bytes da entrada antiga.
 * O total então cresce a cada acerto até passar do teto, e a expulsão passa a
 * descartar arquivos antigos que ainda caberiam.
 */
describe('FileFetcher: contabilidade do cache', () => {
  /** Total realmente guardado, somando os Buffers que estão no Map. */
  function realBytes(f: FileFetcher): number {
    const cache = (f as unknown as { cache: Map<string, Buffer> }).cache;
    let total = 0;
    for (const v of cache.values()) total += v.length;
    return total;
  }

  function countedBytes(f: FileFetcher): number {
    return (f as unknown as { cacheBytes: number }).cacheBytes;
  }

  it('o total contado é sempre a soma real das entradas', async () => {
    const f = new FileFetcher({ check: ok, read: () => Buffer.alloc(FIFTH) });
    (f as unknown as { host: { seen(): void } }).host.seen(); // o auxiliar está presente
    const settle = () => {
      for (const r of f.poll()) f.ack({ results: [{ id: r.id, ok: true, data: Buffer.alloc(FIFTH).toString('base64') }] });
    };

    // Dois arquivos distintos, depois um acerto em cada: o padrão de quem volta
    // para a mesma imagem.
    for (const n of [1, 2]) {
      const p = f.get(`/a/${n}.png`);
      settle();
      await p;
    }
    for (const n of [1, 2]) await f.get(`/a/${n}.png`);

    expect(realBytes(f)).toBe(2 * FIFTH);
    expect(countedBytes(f)).toBe(realBytes(f));
  });

  /**
   * Um `remember` sobre uma chave que já está no cache é o caso do arquivo que
   * chega do auxiliar depois de outra cópia já ter sido guardada.
   */
  it('lembrar de novo o mesmo caminho troca o valor, sem somar duas vezes', () => {
    const f = new FileFetcher({ check: ok });
    const cache = (f as unknown as { cache: Map<string, Buffer> }).cache;
    const remember = (path: string, data: Buffer) =>
      (f as unknown as { remember(p: string, d: Buffer): void }).remember(path, data);

    remember('/a/x.png', Buffer.alloc(FIFTH));
    // um segundo valor para a mesma chave (outra leitura, mesmo arquivo)
    remember('/a/x.png', Buffer.alloc(FIFTH));

    expect(realBytes(f)).toBe(FIFTH);
    expect(countedBytes(f)).toBe(FIFTH);
    expect(cache.size).toBe(1);
  });
});