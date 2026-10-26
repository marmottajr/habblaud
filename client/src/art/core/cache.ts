// Cache com limite para os sprites gerados: ao encher, descarta a quarta parte mais antiga (ordem de inserção do
// Map), em vez de zerar tudo e regenerar a tela inteira de uma vez.
export class Cache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly limit: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string, make: () => T): T {
    let v = this.map.get(key);
    if (v === undefined) {
      if (this.map.size >= this.limit) this.evict();
      v = make();
      this.map.set(key, v);
    }
    return v;
  }

  private evict(): void {
    let n = Math.max(1, Math.ceil(this.limit / 4));
    for (const k of this.map.keys()) {
      if (n-- <= 0) break;
      this.map.delete(k);
    }
  }
}
