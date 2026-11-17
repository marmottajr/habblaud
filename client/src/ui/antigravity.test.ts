import { describe, expect, it } from 'vitest';
import type { AgentInfo, RecentSession } from '../../../shared/types';
import { composerMode } from './composer-model';
import { filterSessions, parseRecentSessions } from './history';
import {
  PROVIDER_NAME,
  accountChipLabel,
  accountProvider,
  fallbackShort,
  isAntigravity,
  looksLikeAntigravityId,
  showsProviderTag,
} from './provider';
import { terminalFooter } from './terminal';

function antigravityAgent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agy-1',
    kind: 'main',
    provider: 'antigravity',
    roomId: '/tmp/proj',
    name: 'Antigravity',
    look: 'm',
    role: 'Agente principal',
    sessionId: 'sess-1',
    account: 'antigravity-cli',
    status: 'waiting',
    waitingFor: 'sua resposta',
    recent: [],
    tasks: [],
    startedAt: 500,
    lastEventAt: 1_000,
    statusSince: 1_000,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    canMessage: false,
    ...over,
  };
}

describe('UI Antigravity CLI', () => {
  it('identifica provider antigravity, ids, letras de fallback e selo', () => {
    expect(PROVIDER_NAME.antigravity).toBe('Antigravity');
    expect(isAntigravity({ provider: 'antigravity' })).toBe(true);
    expect(isAntigravity({ provider: 'codex' })).toBe(false);

    expect(looksLikeAntigravityId('antigravity-cli')).toBe(true);
    expect(looksLikeAntigravityId('.antigravity-cli-work')).toBe(true);
    expect(looksLikeAntigravityId('agy')).toBe(true);
    expect(looksLikeAntigravityId('.claude')).toBe(false);

    expect(accountProvider(undefined, 'antigravity-cli')).toBe('antigravity');
    expect(accountProvider({ provider: 'antigravity' }, 'outra')).toBe('antigravity');

    expect(fallbackShort('antigravity-cli')).toBe('G');
    expect(fallbackShort('antigravity-trabalho', 'antigravity')).toBe('T');
    expect(fallbackShort('agy~2', 'antigravity')).toBe('G');

    expect(showsProviderTag('antigravity', 'Principal')).toBe(true);
    expect(showsProviderTag('antigravity', 'Antigravity CLI')).toBe(false);
    expect(accountChipLabel({ name: 'Trabalho', provider: 'antigravity', plan: 'Pro' }, 'agy', 'antigravity')).toBe('Trabalho · Antigravity · plano Pro');
  });

  it('histórico preserva provider antigravity e filtra por antigravity/agy', () => {
    const parsed = parseRecentSessions({
      sessions: [
        { account: 'antigravity-cli', sessionId: 'c1', projectDir: '/tmp/app', lastAt: 200, size: 10, open: true, provider: 'antigravity', title: 'Ajustar build' },
        { account: '.claude', sessionId: 'c2', projectDir: '/tmp/web', lastAt: 100, size: 5, open: false, title: 'Outro' },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0].provider).toBe('antigravity');
    expect(parsed[1].provider).toBeUndefined();

    const list: RecentSession[] = parsed;
    expect(filterSessions(list, 'antigravity').map((s) => s.sessionId)).toEqual(['c1']);
    expect(filterSessions(list, 'agy').map((s) => s.sessionId)).toEqual(['c1']);
  });

  it('composerMode orienta a responder no terminal do Antigravity CLI', () => {
    const ag = antigravityAgent();
    expect(composerMode(ag, { enabled: false, local: true, replaying: false })).toEqual({
      kind: 'off',
      text: 'Para responder, use o Antigravity CLI',
    });
    expect(composerMode(ag, { enabled: true, local: true, replaying: false })).toEqual({
      kind: 'off',
      text: 'Para responder, use o terminal do Antigravity CLI',
    });
  });

  it('terminalFooter mostra dica de responder no Antigravity quando aguardando sem permissão', () => {
    const footer = terminalFooter(antigravityAgent(), [], 2_000);
    expect(footer.kind).toBe('waiting');
    expect(footer.text).toContain('responda no Antigravity');
  });
});
