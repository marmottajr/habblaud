// Testes de server/pi/http.ts (POST /api/pi/events).
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { parsePiEvent, piAccountOf } from './http';
import type { AccountEntry } from '../accounts/service';

function makeEntry(id: string, dir: string, configDir = dir): AccountEntry {
  return {
    id,
    provider: 'pi',
    dir,
    detected: { id, provider: 'pi', configDir, short: 'P', name: 'Pi', color: '#5cc97b' },
  };
}

describe('parsePiEvent', () => {
  it('aceita evento válido com piDir e account opcionais', () => {
    const out = parsePiEvent({
      account: '.pi',
      piDir: '/home/user/.pi/agent',
      event: { type: 'session_start', sessionId: 'abc12345', cwd: '/proj' },
    });
    expect(out).toEqual({
      account: '.pi',
      piDir: '/home/user/.pi/agent',
      event: { type: 'session_start', sessionId: 'abc12345', cwd: '/proj' },
    });
  });

  it('recusa corpo sem event.type ou event.sessionId com 400', () => {
    expect(() => parsePiEvent({})).toThrow(/esperado/);
    expect(() => parsePiEvent({ event: { type: 'session_start' } })).toThrow(/esperado/);
  });
});

describe('piAccountOf', () => {
  it('resolve conta pela pasta piDir antes do nome de fallback', () => {
    const entries = [makeEntry('.pi', '/home/user/.pi/agent'), makeEntry('.pi-work', '/home/user/.pi-work/agent')];
    expect(piAccountOf(entries, '.pi', '/home/user/.pi-work/agent')).toBe('.pi-work');
    expect(piAccountOf(entries, '.pi', undefined)).toBe('.pi');
  });
});

describe('handlePiEvent via HTTP', () => {
  it('encaminha o evento para PiLive e responde {ok: true}', async () => {
    const { handlePiEvent } = await import('./http');
    const applyLiveEvent = vi.fn().mockReturnValue(true);
    const entries = [makeEntry('.pi', '/home/user/.pi/agent')];

    const server = http.createServer((req, res) => {
      void handlePiEvent(req, res, { live: { applyLiveEvent }, entries: () => entries });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/pi/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piDir: '/home/user/.pi/agent', event: { type: 'agent_start', sessionId: 'sess-001' } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(applyLiveEvent).toHaveBeenCalledWith('.pi', {
        type: 'agent_start',
        sessionId: 'sess-001',
        piDir: '/home/user/.pi/agent',
      });
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
