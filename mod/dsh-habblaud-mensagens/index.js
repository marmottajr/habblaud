// Mensagens pelo escritório para o DeepSeek Harness (DSH): leva para a sessão o que você digita no Habblaud (nos
// detalhes do agente ou no rodapé do terminal), como se você tivesse digitado no DSH.
//
// O equivalente, no DSH, do plugin mod/habblaud-mensagens do Claude Code, com o mesmo protocolo:
//
// 1. A cada 2 s, para cada sessão viva do DSH (ctx.agents.list()), pergunta ao Habblaud local se há mensagens
//    para ela: POST http://127.0.0.1:<HABBLAUD_PORT ou 4747>/api/mod/inbox com {session}. O id é o uuid da sessão
//    (sem o "session-"), o mesmo que o Habblaud lê da pasta session-<uuid>. A pergunta também marca a presença da
//    sessão: é ela que acende, no escritório, a caixa de mensagem do agente. Subagentes recebem sempre [] (o
//    servidor só entrega ao agente principal). Fora do ar ou respondendo algo que não seja 2xx, passa a perguntar
//    a cada 30 s até ele voltar.
// 2. Cada mensagem, na ordem, entra na fila da sessão por ctx.sessionController.prompt({mode: 'queue'}): com o
//    agente livre vira o próximo turno; ocupado, entra quando ele terminar. O requestId é derivado do id da
//    mensagem, então uma entrega repetida não duplica o prompt.
// 3. Um POST /api/mod/inbox/ack com {session, results: [{id, ok, error?}]}. Sem mensagens, sem ack.
//
// Regras: nada lança para fora (falha = silêncio, a próxima rodada tenta de novo); uma rodada por vez; a rede é só
// 127.0.0.1.

export const inject = ['agents', 'sessionController']

const DEFAULT_PORT = 4747
const POLL_MS = 2_000
const OFFLINE_POLL_MS = 30_000
const FETCH_TIMEOUT_MS = 2_000
const PROMPT_TIMEOUT_MS = 15_000
const MAX_SESSIONS = 32
const MAX_REASON = 500

function portOf(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

function reasonText(raw, fallback) {
  const msg = typeof raw === 'string' ? raw : raw && typeof raw.message === 'string' ? raw.message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

/** Resposta de /api/mod/inbox: a lista, ou undefined (fora do formato = fora do ar). */
function parseInbox(text) {
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.messages)) return undefined
  const out = []
  for (const m of j.messages) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' })
  }
  return out
}

/** O id que o Habblaud conhece: o uuid, sem o prefixo "session-". */
function habblaudSession(id) {
  const s = String(id ?? '')
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

export function apply(ctx, config = {}) {
  const port = portOf(config.port ?? process.env.HABBLAUD_PORT)
  const base = `http://127.0.0.1:${port}`
  let stopped = false
  let timer
  let polling = false

  async function postJson(path, body) {
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        // Sem o Content-Type, o guarda do servidor recusa o POST (415).
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      return { ok: res.ok, text: await res.text() }
    } catch {
      return undefined
    }
  }

  async function deliver(sessionId, messages) {
    const results = []
    for (const m of messages) {
      if (!m.text.trim()) {
        results.push({ id: m.id, ok: false, error: 'mensagem vazia' })
        continue
      }
      try {
        await ctx.sessionController.prompt(
          { requestId: `habblaud-${m.id}`, sessionId, mode: 'queue', content: [{ type: 'text', text: m.text }] },
          AbortSignal.timeout(PROMPT_TIMEOUT_MS),
        )
        results.push({ id: m.id, ok: true })
      } catch (err) {
        results.push({ id: m.id, ok: false, error: reasonText(err, 'a sessão do DSH não aceitou a mensagem') })
      }
    }
    return results
  }

  /** Uma rodada por todas as sessões vivas; devolve false se o Habblaud não respondeu. */
  async function round() {
    let agents = []
    try {
      agents = ctx.agents.list().slice(0, MAX_SESSIONS)
    } catch {
      return true
    }
    let online = true
    for (const agent of agents) {
      if (stopped) return online
      const sessionId = agent?.id
      if (!sessionId) continue
      const session = habblaudSession(sessionId)
      const res = await postJson('/api/mod/inbox', { session })
      const messages = res?.ok ? parseInbox(res.text) : undefined
      if (!messages) {
        online = false
        break
      }
      if (!messages.length) continue
      const results = await deliver(sessionId, messages)
      await postJson('/api/mod/inbox/ack', { session, results })
    }
    return online
  }

  function schedule(ms) {
    if (stopped) return
    timer = setTimeout(async () => {
      if (polling) return schedule(POLL_MS)
      polling = true
      let online = true
      try {
        online = await round()
      } catch (err) {
        ctx.logger?.debug?.(`habblaud-mensagens: ${reasonText(err, 'falha na rodada')}`)
      } finally {
        polling = false
      }
      schedule(online ? POLL_MS : OFFLINE_POLL_MS)
    }, ms)
    timer.unref?.()
  }

  ctx.effect(() => {
    stopped = false
    schedule(POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, 'habblaud-mensagens: inbox poll')
}
