// Testes do plugin de mensagens, rodados pelo próprio Claude Code: `claude plugin test` dentro de
// mod/habblaud-mensagens (sem sessão, sem login, sem rede). Os stubs respondem no lugar do Claude Code e do
// Habblaud: env, relógio (mock.clock), $.session.id, $.session.surfaces, $.http.fetch (as duas rotas do
// servidor) e o prompt.submit de baixo (a sessão: aceita, um hook recusa, a chamada lança ou fica presa).
import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { accountIdOf, ackBody, asideBody, asidePrompt, clipAnswer, configDirOf, forkOutcome, inboxBody, MAX_REASON, normalizePath, parseInbox, portOf, reasonText, type InboxMessage, ASIDE_ANSWER_MAX } from '../hooks/register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const PORT = '4850'
const INBOX_URL = `http://127.0.0.1:${PORT}/api/mod/inbox`
const ACK_URL = `${INBOX_URL}/ack`
const ASIDE_URL = `http://127.0.0.1:${PORT}/api/mod/aside`
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** Resposta do Habblaud ao inbox: mensagens, 'offline' (conexão recusada), 'hang' (não responde) ou um HTTP cru. */
type Answer = InboxMessage[] | 'offline' | 'hang' | { status: number; text: string }
/** O que a sessão faz com um prompt: entra, um hook recusa, a chamada lança, ou fica presa (sessão ocupada). */
type Fate = 'ok' | 'drop' | 'throw' | 'hang'
/** O que `$.model.fork` faz com uma pergunta paralela: responde, volta null (API/sem conversa), recusa com motivo, lança ou demora. */
type ForkFate = { text: string; afterMs?: number } | null | { isAnswered: false; reason: string } | 'throw' | 'hang'

interface World {
  env?: Record<string, string>
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Padrão: nenhuma mensagem. */
  inbox?: () => Answer
  /** Padrão: o ack responde 200. */
  ack?: () => 'ok' | 'offline' | 'hang'
  /** Padrão: 'ok'. */
  fate?: (text: string) => Fate
  /** Padrão: responde 'resposta' na hora. */
  fork?: (prompt: string) => ForkFate
  /** O que o Habblaud responde a POST /api/mod/aside: cancel manda descartar. Padrão: ok. */
  aside?: () => 'ok' | 'cancel'
}

interface Sent {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

/** Uma fila de respostas: cada pergunta leva a próxima; acabou, nenhuma mensagem. */
function batches(...list: Answer[]): () => Answer {
  return () => list.shift() ?? []
}

/** Registra todos os stubs (antes da primeira chamada em $, como o kit exige) e devolve o que foi capturado. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/fulano', CLAUDE_CONFIG_DIR: '~/.claude-conta2', HABBLAUD_PORT: PORT })
  const sent: Sent[] = []
  const submits: Array<{ text: string; origin: unknown }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async ($, e) => {
    const body = e.init?.body
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: body === undefined ? undefined : JSON.parse(body) })
    if (e.url === ASIDE_URL) return { value: response(200, JSON.stringify({ cancel: w.aside?.() === 'cancel' })) }
    if (e.url.endsWith('/ack')) {
      const a = w.ack ? w.ack() : 'ok'
      if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
      if (a === 'hang') {
        await clock.sleep(60_000)
        return { deny: 'tarde demais' }
      }
      return { value: response(200, '{"ok":true}') }
    }
    const a = w.inbox ? w.inbox() : []
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'tarde demais' }
    }
    return { value: Array.isArray(a) ? response(200, JSON.stringify({ messages: a })) : response(a.status, a.text) }
  })
  on('prompt.submit', async ($, e) => {
    submits.push({ text: e.text, origin: e.origin })
    const fate = w.fate ? w.fate(e.text) : 'ok'
    if (fate === 'drop') return { drop: `recusada por um hook: ${e.text}` }
    if (fate === 'throw') throw new Error('a sessão\nfechou')
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: e.text }
  })
  const forks: string[] = []
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    const f = w.fork ? w.fork(e.prompt) : { text: 'resposta' }
    if (f === 'throw') throw new Error('a sessão\nfechou')
    if (f === 'hang') await clock.sleep(600_000)
    if (f && typeof f === 'object' && 'afterMs' in f && f.afterMs) await clock.sleep(f.afterMs)
    return { value: f === 'hang' ? null : (f as never) }
  })
  return {
    clock,
    forks,
    asides: () => sent.filter((x) => x.url === ASIDE_URL),
    sent,
    submits,
    inboxes: () => sent.filter((s) => s.url === INBOX_URL),
    acks: () => sent.filter((s) => s.url === ACK_URL),
    texts: () => submits.map((s) => s.text),
  }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('rodadas', () => {
  test('a cada 2 s pergunta ao Habblaud (marca a presença); sem mensagens, nada vai para a sessão e não há ack', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.sent).toEqual([])
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: INBOX_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', account: '.claude-conta2', asides: true } }])
    await w.clock.advance(4_000)
    expect(w.inboxes().length).toBe(3)
    expect(w.acks()).toEqual([])
    expect(w.submits).toEqual([])
  })

  test('entrega na ordem, como se você tivesse digitado (texto intacto), e confirma tudo num POST só', async ($, on) => {
    const typed = '  e depois:\n- abre o PR\n\n(sem pressa)  '
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'roda os testes' }, { id: 'm2', text: typed }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['roda os testes', typed])
    expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'habblaud-mensagens', asUser: true })
    expect(w.acks()).toEqual([{ url: ACK_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] } }])
    await w.clock.advance(2_000)
    expect(w.sent.map((s) => s.url)).toEqual([INBOX_URL, ACK_URL, INBOX_URL])
    expect(w.submits.length).toBe(2)
  })

  test('recusa de um hook e exceção viram falha com o motivo; sem texto, falha sem ir para a sessão', async ($, on) => {
    const raw = JSON.stringify({
      messages: [
        { id: 'a', text: 'pode ir' },
        { id: 'b', text: 'proibida' },
        { id: 'c', text: 'quebra' },
        { id: 'd', text: '  \n ' },
        { id: 'e', text: 42 },
        // sem id: não há como confirmar, fica de fora
        { text: 'órfã' },
      ],
    })
    const w = world(on, {
      inbox: batches({ status: 200, text: raw }),
      fate: (t) => (t === 'proibida' ? 'drop' : t === 'quebra' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['pode ir', 'proibida', 'quebra'])
    expect(w.acks()[0]?.body).toEqual({
      session: 'sess-1',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'recusada por um hook: proibida' },
        // O hook de baixo que lança é pulado e, sem nada embaixo dele, a chamada rejeita: o motivo é o do kit.
        { id: 'c', ok: false, error: expect.stringMatching(/\S/) },
        { id: 'd', ok: false, error: 'mensagem vazia' },
        { id: 'e', ok: false, error: 'mensagem vazia' },
      ],
    })
  })

  test('sessão ocupada: passou de 2 s, conta como entregue e as seguintes vão em seguida, na ordem; as rodadas seguem', async ($, on) => {
    const w = world(on, {
      inbox: batches([
        { id: 'm1', text: 'primeira' },
        { id: 'm2', text: 'segunda' },
        { id: 'm3', text: 'terceira' },
      ]),
      fate: (t) => (t === 'primeira' ? 'hang' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira'])
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira', 'segunda', 'terceira'])
    expect(w.acks().map((a) => a.body)).toEqual([
      {
        session: 'sess-1',
        results: [
          { id: 'm1', ok: true },
          { id: 'm2', ok: true },
          { id: 'm3', ok: true },
        ],
      },
    ])
    const asked = w.inboxes().length
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBeGreaterThan(asked)
  })

  test('uma rodada por vez: com a sessão ocupada e o ack travado, a pergunta do meio é pulada', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'primeira' }]), fate: () => 'hang', ack: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    // A rodada vai de 2 s (pergunta) a 4 s (prazo do submit) e daí a 6 s (prazo do ack): a de 4 s não começa.
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBe(1)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBeGreaterThan(1)
    expect(w.texts()).toEqual(['primeira'])
  })

  test('ack que falha = silêncio: as rodadas seguem', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'oi' }]), ack: () => 'offline' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    expect(w.texts()).toEqual(['oi'])
  })

  test('Habblaud fora do ar, 403 (mensagens desligadas) ou 404 (versão sem a rota): recua para 30 s até voltar', async ($, on) => {
    let answer: Answer = 'offline'
    const w = world(on, { inbox: () => answer })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(28_000)
    expect(w.inboxes().length).toBe(1)
    answer = { status: 403, text: '{"error":"mensagens pelo escritório desligadas"}' }
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    answer = { status: 404, text: '{"error":"rota desconhecida"}' }
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(3)
    answer = []
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(4)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(5)
    expect(w.acks()).toEqual([])
  })

  test('Habblaud travado: desiste em 2 s e recua para 30 s', async ($, on) => {
    let hang = true
    const w = world(on, { inbox: () => (hang ? 'hang' : []) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.inboxes().length).toBe(1)
    hang = false
    await w.clock.advance(1_000)
    expect(w.inboxes().length).toBe(2)
  })

  test('sessão sem superfície (claude -p, SDK): nem pergunta ao Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent).toEqual([])
  })

  test('sessão do app desktop fora da tela (SDK sem superfície): pergunta mesmo assim', async ($, on) => {
    const w = world(on, { surfaces: [], env: { HOME: '/home/fulano', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HABBLAUD_PORT: PORT } })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
  })

  test('sem HOME nem CLAUDE_CONFIG_DIR: pergunta sem a conta, na porta padrão', async ($, on) => {
    const w = world(on, { env: {} })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: 'http://127.0.0.1:4747/api/mod/inbox', method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', asides: true } }])
  })
})

describe('perguntas paralelas', () => {
  const ASIDE = { turnId: 'q-1', question: 'o que você está fazendo?', history: [{ question: 'e antes?', answer: 'lia o código' }] }

  test('o item com aside vai ao $.model.fork, nunca à sessão: ack na hora, sinal de vida e a resposta inteira no fim', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'a1', text: '', aside: ASIDE }]), fork: () => ({ text: '  Revendo os testes.  ', afterMs: 3_000 }) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.submits).toEqual([])
    expect(w.acks().map((a) => a.body)).toEqual([{ session: 'sess-1', results: [{ id: 'a1', ok: true }] }])
    expect(w.forks).toEqual([asidePrompt(ASIDE)])
    expect(w.forks[0]).toContain('o que você está fazendo?')
    expect(w.forks[0]).toContain('lia o código')
    await w.clock.advance(4_000)
    const posts = w.asides().map((a) => a.body as { state: string; text: string; turnId: string; sessionId: string })
    expect(posts.length).toBeGreaterThan(1)
    expect(posts.slice(0, -1).every((p) => p.state === 'running' && p.text === '' && p.turnId === 'q-1' && p.sessionId === 'sess-1')).toBe(true)
    expect(posts[posts.length - 1]).toEqual({ sessionId: 'sess-1', turnId: 'q-1', text: 'Revendo os testes.', state: 'complete' })
  })

  test('fork sem resposta, recusado (sessão interrompida), com exceção ou vazio: a página recebe o motivo como erro', async ($, on) => {
    const fates: ForkFate[] = [null, { isAnswered: false, reason: 'the session was stopped and nobody has sent input since' }, 'throw', { text: '  ' }]
    const w = world(on, {
      inbox: batches(...fates.map((_, i) => [{ id: `a${i}`, text: '', aside: { ...ASIDE, turnId: `q-${i}` } }] as InboxMessage[])),
      fork: () => fates.shift() ?? null,
    })
    await $.session.start(START)
    await w.clock.advance(8_000)
    const finals = w.asides().map((a) => a.body as { turnId: string; state: string; error?: string }).filter((b) => b.state !== 'running')
    expect(finals.map((f) => [f.turnId, f.state])).toEqual([['q-0', 'failed'], ['q-1', 'failed'], ['q-2', 'failed'], ['q-3', 'failed']])
    expect(finals[1]?.error).toBe('the session was stopped and nobody has sent input since')
    expect(finals.every((f) => typeof f.error === 'string' && f.error.length > 0)).toBe(true)
  })

  test('uma por vez: a segunda enquanto a primeira roda falha no ack; item sem pergunta falha sem ir a lugar nenhum', async ($, on) => {
    const w = world(on, {
      inbox: batches([{ id: 'a1', text: '', aside: ASIDE }], [{ id: 'a2', text: '', aside: { ...ASIDE, turnId: 'q-2' } }, { id: 'a3', text: '', aside: 'ruim' as never }]),
      fork: () => ({ text: 'ok', afterMs: 10_000 }),
    })
    await $.session.start(START)
    await w.clock.advance(4_000)
    expect(w.acks().map((a) => a.body)).toEqual([
      { session: 'sess-1', results: [{ id: 'a1', ok: true }] },
      { session: 'sess-1', results: [{ id: 'a2', ok: false, error: 'já há uma pergunta paralela em andamento' }, { id: 'a3', ok: false, error: 'mensagem vazia' }] },
    ])
    expect(w.submits).toEqual([])
    expect(w.forks.length).toBe(1)
    await w.clock.advance(12_000)
  })

  test('o servidor mandou descartar (pergunta parada): manda cancelled na hora, libera a sessão e não manda a resposta do fork', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'a1', text: '', aside: ASIDE }]), fork: () => ({ text: 'tarde', afterMs: 20_000 }), aside: () => 'cancel' })
    await $.session.start(START)
    await w.clock.advance(5_000)
    const states = w.asides().map((a) => (a.body as { state: string }).state)
    expect(states).toContain('cancelled')
    await w.clock.advance(30_000)
    expect(w.asides().map((a) => (a.body as { state: string }).state)).not.toContain('complete')
  })
})

describe('funções puras', () => {
  test('forkOutcome: texto, null, recusa com motivo e resposta vazia', () => {
    expect(forkOutcome({ text: ' oi ', usage: {} })).toEqual({ ok: true, text: 'oi' })
    expect(forkOutcome({ isAnswered: true, text: 'oi' })).toEqual({ ok: true, text: 'oi' })
    expect(forkOutcome(null)).toMatchObject({ ok: false })
    expect(forkOutcome({ isAnswered: false, reason: 'the session was stopped and nobody has sent input since' })).toEqual({
      ok: false,
      error: 'the session was stopped and nobody has sent input since',
    })
    expect(forkOutcome({ isAnswered: false })).toMatchObject({ ok: false, error: 'o Claude Code não respondeu' })
    expect(forkOutcome({ text: '   ' })).toEqual({ ok: false, error: 'a resposta veio vazia' })
  })

  test('resposta enorme é cortada com reticências; corpo do aside e prompt com o histórico', () => {
    const clipped = clipAnswer('x'.repeat(ASIDE_ANSWER_MAX + 5))
    expect(clipped.length).toBe(ASIDE_ANSWER_MAX)
    expect(clipped.endsWith('\n…')).toBe(true)
    expect(JSON.parse(asideBody('s', 'q', 'failed', '', 'x'))).toEqual({ sessionId: 's', turnId: 'q', text: '', state: 'failed', error: 'x' })
    expect(JSON.parse(asideBody('s', 'q', 'running', ''))).toEqual({ sessionId: 's', turnId: 'q', text: '', state: 'running' })
    expect(asidePrompt({ turnId: 'q', question: 'P2?', history: [{ question: 'P1?', answer: 'R1' }, { question: 'P0?', answer: '' }] })).toMatch(/P1\?[\s\S]*R1[\s\S]*P0\?[\s\S]*Side question: P2\?$/)
  })

  test('inbox: o aside é lido e o malformado some', () => {
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: '', aside: { turnId: 'q', question: 'oi', history: [{ question: 'a', answer: 'b' }, 7] } }, { id: 'b', text: '', aside: { turnId: '' } }] }))).toEqual([
      { id: 'a', text: '', aside: { turnId: 'q', question: 'oi', history: [{ question: 'a', answer: 'b' }] } },
      { id: 'b', text: '' },
    ])
  })

  test('inbox: formato estranho = fora do ar; item sem id fica de fora; sem texto vira texto vazio', () => {
    expect(parseInbox('<html>')).toBeUndefined()
    expect(parseInbox('[]')).toBeUndefined()
    expect(parseInbox('{"messages":{}}')).toBeUndefined()
    expect(parseInbox('{"messages":[]}')).toEqual([])
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: ' x\n' }, { id: '', text: 'y' }, { text: 'z' }, null, { id: 'b' }] }))).toEqual([
      { id: 'a', text: ' x\n' },
      { id: 'b', text: '' },
    ])
  })

  test('corpos das duas rotas', () => {
    expect(JSON.parse(inboxBody('s', '.claude'))).toEqual({ session: 's', account: '.claude', asides: true })
    expect(JSON.parse(inboxBody('s', undefined))).toEqual({ session: 's', asides: true })
    expect(JSON.parse(ackBody('s', [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'não' }]))).toEqual({
      session: 's',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'não' },
      ],
    })
  })

  test('motivo da falha: uma linha, tamanho limitado, e o padrão quando não há texto', () => {
    expect(reasonText('um\nhook\t recusou ', 'padrão')).toBe('um hook recusou')
    expect(reasonText(new Error('boom'), 'padrão')).toBe('boom')
    expect(reasonText({ message: 'de outro mundo' }, 'padrão')).toBe('de outro mundo')
    expect(reasonText('   ', 'padrão')).toBe('padrão')
    expect(reasonText(undefined, 'padrão')).toBe('padrão')
    const long = reasonText('x'.repeat(2_000), 'padrão')
    expect(long.length).toBe(MAX_REASON)
    expect(long.endsWith('…')).toBe(true)
  })

  test('conta e porta como o mod habblaud calcula (também no Windows)', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(configDirOf('C:\\Users\\f\\.claude-conta2\\', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(accountIdOf('/')).toBeUndefined()
    expect(portOf('4850')).toBe(4850)
    expect(portOf('0')).toBe(4747)
    expect(portOf('abc')).toBe(4747)
    expect(portOf(undefined)).toBe(4747)
  })
})
