// Parte pura do plugin habblaud-mensagens que cuida das perguntas paralelas. O resto do plugin (rodadas, $.model.fork,
// sinal de vida) só roda pelo `claude plugin test` (mod/habblaud-mensagens/tests); aqui o contrato com o servidor.
import { describe, expect, it } from 'vitest';
import { ASIDE_ANSWER_MAX as SERVER_ANSWER_MAX, parseAsideProgress } from '../../shared/asides';
// Importação dinâmica: o plugin importa tipos de 'claude-code', que o typecheck do servidor não conhece.
const PLUGIN = '../../mod/habblaud-mensagens/hooks/register';
const { ASIDE_ANSWER_MAX, asideBody, asidePrompt, clipAnswer, forkOutcome, inboxBody, parseAside, parseInbox, wantsCancel } = await import(/* @vite-ignore */ PLUGIN);

const SID = '0199b0c0-1234-7abc-8def-0123456789ab';

describe('plugin habblaud-mensagens: perguntas paralelas', () => {
  it('o corpo da caixa de entrada declara asides: true (é o que liga o chat no servidor)', () => {
    expect(JSON.parse(inboxBody('s', undefined))).toEqual({ session: 's', asides: true });
    expect(JSON.parse(inboxBody('s', '.claude'))).toEqual({ session: 's', account: '.claude', asides: true });
  });

  it('o corpo de POST /api/mod/aside passa pelo parser do servidor, e o limite de resposta é o mesmo', () => {
    expect(ASIDE_ANSWER_MAX).toBe(SERVER_ANSWER_MAX);
    expect(parseAsideProgress(JSON.parse(asideBody(SID, 'q-1', 'complete', 'oi')))).toEqual({ sessionId: SID, turnId: 'q-1', text: 'oi', state: 'complete' });
    expect(parseAsideProgress(JSON.parse(asideBody(SID, 'q-1', 'running', '')))).toMatchObject({ state: 'running', text: '' });
    expect(parseAsideProgress(JSON.parse(asideBody(SID, 'q-1', 'failed', '', 'motivo')))).toMatchObject({ state: 'failed', error: 'motivo' });
    expect(parseAsideProgress(JSON.parse(asideBody(SID, 'q-1', 'cancelled', '')))).toMatchObject({ state: 'cancelled' });
  });

  it('forkOutcome: texto, null, recusa com motivo (sessão interrompida) e resposta vazia', () => {
    expect(forkOutcome({ text: ' oi ', usage: {} })).toEqual({ ok: true, text: 'oi' });
    expect(forkOutcome({ isAnswered: true, text: 'oi' })).toEqual({ ok: true, text: 'oi' });
    expect(forkOutcome(null)).toMatchObject({ ok: false });
    expect(forkOutcome(undefined)).toMatchObject({ ok: false });
    const reason = 'the session was stopped and nobody has sent input since';
    expect(forkOutcome({ isAnswered: false, reason })).toEqual({ ok: false, error: reason });
    expect(forkOutcome({ isAnswered: false })).toEqual({ ok: false, error: 'o Claude Code não respondeu' });
    expect(forkOutcome({ text: '   ' })).toEqual({ ok: false, error: 'a resposta veio vazia' });
  });

  it('resposta enorme é cortada com reticências, como o servidor corta', () => {
    const out = clipAnswer('x'.repeat(ASIDE_ANSWER_MAX + 5));
    expect(out.length).toBe(ASIDE_ANSWER_MAX);
    expect(out.endsWith('\n…')).toBe(true);
    expect(clipAnswer('curta')).toBe('curta');
  });

  it('o prompt leva a pergunta no fim, depois das anteriores e das respostas delas', () => {
    const p = asidePrompt({ turnId: 'q', question: 'P2?', history: [{ question: 'P1?', answer: 'R1' }, { question: 'P0?', answer: '' }] });
    expect(p).toMatch(/P1\?[\s\S]*R1[\s\S]*P0\?[\s\S]*Side question: P2\?$/);
    expect(p).not.toContain('Your earlier answer: \n');
  });

  it('inbox: o aside é lido; sem turnId ou pergunta, o item vira mensagem vazia (falha no ack)', () => {
    expect(parseAside({ turnId: 'q', question: 'oi', history: [{ question: 'a', answer: 'b' }, 7, { question: 'c' }] })).toEqual({
      turnId: 'q',
      question: 'oi',
      history: [
        { question: 'a', answer: 'b' },
        { question: 'c', answer: '' },
      ],
    });
    expect(parseAside({ turnId: '', question: 'oi' })).toBeUndefined();
    expect(parseAside({ turnId: 'q' })).toBeUndefined();
    expect(parseAside([])).toBeUndefined();
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: '', aside: { turnId: 'q', question: 'oi' } }, { id: 'b', text: '', aside: 5 }] }))).toEqual([
      { id: 'a', text: '', aside: { turnId: 'q', question: 'oi', history: [] } },
      { id: 'b', text: '' },
    ]);
  });

  it('wantsCancel só diz sim para {cancel: true} numa resposta 2xx', () => {
    const res = (status: number, text: string) => ({ status, ok: status >= 200 && status < 300, headers: {}, text });
    expect(wantsCancel(res(200, '{"cancel":true}'))).toBe(true);
    expect(wantsCancel(res(200, '{"cancel":false}'))).toBe(false);
    expect(wantsCancel(res(200, 'nao json'))).toBe(false);
    expect(wantsCancel(res(500, '{"cancel":true}'))).toBe(false);
    expect(wantsCancel(undefined)).toBe(false);
  });
});
