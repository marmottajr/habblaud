import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ompProviderOf, parseOmpProviders, parseOmpUsage } from './usage';

const RAW = readFileSync(join(__dirname, 'fixtures', 'usage.json'), 'utf8');
const NOW = 1792518300000;

// Fixture: a saída real de `omp usage --json --redact`, com os metadados (e-mails, ids, créditos) trocados por fictícios.
describe('parseOmpUsage (saída real de omp usage --json --redact)', () => {
  it('anthropic: janelas compartilhadas de 5 h e 7 d; a do tier (fable) fica de fora', () => {
    expect(parseOmpUsage(RAW, 'anthropic', NOW)).toEqual({
      source: 'omp',
      ompProvider: 'anthropic',
      fetchedAt: 1792518261576,
      fiveHour: { utilization: 11, resetsAt: 1792533000000 },
      sevenDay: { utilization: 41, resetsAt: 1792519200000 },
    });
  });

  it('provedor sem janelas de 5 h/7 d: sem números, com a nota do omp quando há', () => {
    expect(parseOmpUsage(RAW, 'ollama-cloud', NOW)).toEqual({
      source: 'omp',
      ompProvider: 'ollama-cloud',
      fetchedAt: 1792518080897,
      note: 'Ollama does not expose a standalone quota usage API; per-response token usage is reported during requests.',
    });
    expect(parseOmpUsage(RAW, 'openai-codex', NOW)).toEqual({ source: 'omp', ompProvider: 'openai-codex', fetchedAt: 1792518080893 });
  });

  it('janela repetida por grupo (google-antigravity): vale a primeira compartilhada', () => {
    const u = parseOmpUsage(RAW, 'google-antigravity', NOW)!;
    expect(u.fiveHour).toEqual({ utilization: 0, resetsAt: 1792536081000 });
    expect(u.sevenDay).toEqual({ utilization: 0, resetsAt: 1793122881000 });
  });

  it('sem report do provedor ou JSON inválido: undefined; leitura do futuro vira agora', () => {
    expect(parseOmpUsage(RAW, 'xai', NOW)).toBeUndefined();
    expect(parseOmpUsage('{', 'anthropic', NOW)).toBeUndefined();
    expect(parseOmpUsage('{"reports":null}', 'anthropic', NOW)).toBeUndefined();
    expect(parseOmpUsage(RAW, 'anthropic', 1000)?.fetchedAt).toBe(1000);
  });

  it('cota esgotada: noQuota, sem janelas (nunca 100% nem 0%)', () => {
    const raw = JSON.stringify({
      reports: [
        {
          provider: 'anthropic',
          fetchedAt: NOW - 1000,
          limits: [
            { scope: { shared: true }, window: { durationMs: 18000000, resetsAt: 5000 }, amount: { usedFraction: 1 }, status: 'exhausted' },
            { scope: { shared: true }, window: { durationMs: 604800000 }, amount: { usedFraction: 0.5 }, status: 'ok' },
          ],
        },
      ],
    });
    expect(parseOmpUsage(raw, 'anthropic', NOW)).toEqual({ source: 'omp', ompProvider: 'anthropic', fetchedAt: NOW - 1000, noQuota: true });
  });

  it('nada de metadata (e-mails, ids) no resultado', () => {
    expect(JSON.stringify(parseOmpUsage(RAW, 'anthropic', NOW))).not.toMatch(/email|accountId|orgName/);
  });
});

describe('parseOmpProviders (todos os provedores, saída real)', () => {
  it('cada report vira um provedor com todos os limites (inclusive os de tier/grupo), o plano e a nota', () => {
    const list = parseOmpProviders(RAW, NOW)!;
    expect(list.map((p) => p.provider)).toEqual(['anthropic', 'openai-codex', 'google-antigravity', 'ollama-cloud']);
    expect(list[0].limits.map((l) => l.label)).toEqual(['Claude 5 Hour', 'Claude 7 Day', 'Claude 7 Day (Fable)']);
    expect(list[0].limits[0]).toEqual({ label: 'Claude 5 Hour', windowMs: 18_000_000, utilization: 11, resetsAt: 1792533000000 });
    expect(list[1]).toMatchObject({ plan: 'free', limits: [{ label: '30 days', windowMs: 30 * 86_400_000, utilization: 0 }] });
    expect(list[3]).toMatchObject({ limits: [], note: expect.stringMatching(/^Ollama /) });
  });

  it('limite repetido (o Google repete um por modelo do grupo) entra uma vez; esgotado fica marcado', () => {
    const google = parseOmpProviders(RAW, NOW)![2];
    expect(google.limits.map((l) => `${l.label} ${l.windowMs}`)).toEqual(['Gemini 604800000', 'Gemini 18000000', 'Claude & GPT (shared) 604800000', 'Claude & GPT (shared) 18000000']);
    const raw = JSON.stringify({ reports: [{ provider: 'x', limits: [{ label: 'Tudo', window: { durationMs: 1 }, amount: { usedFraction: 1 }, status: 'exhausted' }] }] });
    expect(parseOmpProviders(raw, NOW)![0].limits[0]).toMatchObject({ utilization: 100, exhausted: true });
  });

  it('sem e-mails nem ids; JSON inválido = undefined', () => {
    expect(JSON.stringify(parseOmpProviders(RAW, NOW))).not.toMatch(/email|accountId|orgName|@/);
    expect(parseOmpProviders('{', NOW)).toBeUndefined();
  });
});

describe('ompProviderOf', () => {
  it('provedor de "provedor/modelo"', () => {
    expect(ompProviderOf('anthropic/claude-opus-5-5')).toBe('anthropic');
    expect(ompProviderOf('ollama-cloud/gemma4:31b-cloud')).toBe('ollama-cloud');
    expect(ompProviderOf('x')).toBeUndefined();
    expect(ompProviderOf('/x')).toBeUndefined();
    expect(ompProviderOf(undefined)).toBeUndefined();
  });
});
