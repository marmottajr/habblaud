// O arquivo de inscrições guarda o endereço de push e as chaves de cifra de cada aparelho. Quem o tiver, com a chave
// privada VAPID, manda notificação para o celular de quem roda o Habblaud: o modo 600 é requisito, não detalhe.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointTag, FILE_NAME, LABEL_MAX, PushStore } from './store';

const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const ENDPOINT = 'https://web.push.apple.com/abc123456789';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'habblaud-push-'));
}

describe('PushStore', () => {
  it('cria o arquivo a 600', () => {
    const d = dir();
    const store = new PushStore(d);
    store.load();
    store.upsert({ endpoint: ENDPOINT, keys: KEYS });
    expect(statSync(join(d, FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it('não deixa um temporário frouxo virar o arquivo final', () => {
    const d = dir();
    writeFileSync(join(d, `${FILE_NAME}.tmp`), 'sobra', { mode: 0o666 });
    const store = new PushStore(d);
    store.load();
    store.upsert({ endpoint: ENDPOINT, keys: KEYS });
    expect(statSync(join(d, FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  it('o mesmo aparelho reinscrito não vira uma segunda linha', () => {
    const store = new PushStore(dir());
    store.load();
    store.upsert({ endpoint: ENDPOINT, keys: KEYS, label: 'iPhone' });
    store.upsert({ endpoint: ENDPOINT, keys: KEYS, label: 'iPhone' });
    expect(store.list()).toHaveLength(1);
  });

  it('lê de volta o que gravou', () => {
    const d = dir();
    const a = new PushStore(d);
    a.load();
    a.upsert({ endpoint: ENDPOINT, keys: KEYS, label: 'iPhone' });
    a.setTypes(ENDPOINT, { 'needs-you': false });
    const b = new PushStore(d);
    b.load();
    expect(b.find(ENDPOINT)?.types).toEqual({ 'needs-you': false });
    expect(b.find(ENDPOINT)?.label).toBe('iPhone');
  });

  it('arquivo corrompido não derruba o início do servidor', () => {
    const d = dir();
    writeFileSync(join(d, FILE_NAME), '{isto não é json');
    const store = new PushStore(d);
    store.load();
    expect(store.list()).toEqual([]);
  });

  it('descarta linhas sem endpoint https ou sem chaves', () => {
    const d = dir();
    writeFileSync(join(d, FILE_NAME), JSON.stringify([{ endpoint: 'http://x/y', keys: KEYS }, { endpoint: ENDPOINT }, { endpoint: ENDPOINT, keys: KEYS }]));
    const store = new PushStore(d);
    store.load();
    expect(store.list()).toHaveLength(1);
  });

  it('corta o rótulo do aparelho', () => {
    const store = new PushStore(dir());
    store.load();
    const sub = store.upsert({ endpoint: ENDPOINT, keys: KEYS, label: 'x'.repeat(LABEL_MAX + 40) });
    expect(sub.label).toHaveLength(LABEL_MAX);
  });

  it('remove por endpoint', () => {
    const store = new PushStore(dir());
    store.load();
    store.upsert({ endpoint: ENDPOINT, keys: KEYS });
    expect(store.remove(ENDPOINT)).toBe(true);
    expect(store.remove(ENDPOINT)).toBe(false);
  });

  it('o rótulo de log não leva o endereço de push', () => {
    const tag = endpointTag(ENDPOINT);
    expect(tag).toBe('…23456789');
    expect(ENDPOINT.includes(tag.replace('…', ''))).toBe(true);
    expect(tag.length).toBeLessThan(12);
  });

  it('grava JSON legível e sem nada além das inscrições', () => {
    const d = dir();
    const store = new PushStore(d);
    store.load();
    store.upsert({ endpoint: ENDPOINT, keys: KEYS });
    const raw: unknown = JSON.parse(readFileSync(join(d, FILE_NAME), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(Object.keys((raw as Record<string, unknown>[])[0]).sort()).toEqual(['createdAt', 'endpoint', 'id', 'keys', 'types']);
  });
});
