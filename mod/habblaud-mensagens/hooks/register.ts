// Mensagens pelo escritório (Claude Code 2.1.287+): leva para a sessão o que você digita no Habblaud (no painel
// do agente ou no terminal da tecla T), como se você tivesse digitado no terminal.
//
// O que faz, e `claude plugin validate` lista exatamente o que o módulo chama (a saída está no mod/README.md):
//
// 1. A cada 2 s, só onde a sessão desenha (`$.session.surfaces()` vazia = `claude -p`/SDK: nada a fazer) ou numa
//    sessão do app desktop (CLAUDE_CODE_ENTRYPOINT=claude-desktop: SDK por baixo, sem superfície fora da tela), pergunta
//    ao Habblaud local se há mensagens para ela: POST http://127.0.0.1:<HABBLAUD_PORT ou 4747>/api/mod/inbox com
//    {session, account, asides}. A pergunta também marca a presença da sessão: é ela que acende, no escritório, a caixa de
//    mensagem deste agente. Fora do ar, ou respondendo qualquer coisa que não seja 2xx (403 = mensagens desligadas
//    no Habblaud; 404 = uma versão sem a rota), passa a perguntar a cada 30 s até ele voltar.
// 2. Cada mensagem, na ordem, vai para a sessão por `$.prompt.submit({ text, asUser: true })`: o modelo a lê como
//    sua, sem o "The habblaud-mensagens plugin sent a message" (o registro da sessão ainda nomeia o plugin). O
//    texto vai exatamente como chegou. `{drop}` (um hook recusou) ou exceção = falha, com o motivo.
//    Com a sessão no meio de um turno, o Claude Code guarda o prompt até ela ficar livre e a chamada pode demorar a
//    voltar: a espera por mensagem é de no máximo 2 s. Passou disso, a mensagem está na fila da sessão e conta
//    como entregue, e as seguintes da mesma rodada vão em seguida, na ordem, sem esperar. Assim a rodada nunca
//    passa de uns poucos segundos: a presença (10 s no servidor) e a confirmação (30 s) não vencem por uma
//    sessão ocupada. O preço: um hook que recuse a mensagem depois desses 2 s não chega ao escritório.
// 3. Um único POST /api/mod/inbox/ack com {session, results: [{id, ok, error?}]}. Sem mensagens, sem ack.
// 4. Pergunta paralela (o /btw do Habblaud): o corpo da rodada leva `asides: true`, que declara ao servidor que este
//    plugin as responde (plugin antigo não declara e nunca recebe uma). Um item com `aside` NÃO vai à sessão como
//    prompt: `$.model.fork({ prompt })` manda a conversa de agora mais a pergunta ao modelo da sessão, sem
//    ferramentas e sem entrar na conversa. A rodada só inicia a pergunta e confirma na hora (o fork leva segundos);
//    um sinal de vida por segundo e, no fim, a resposta inteira (ou o motivo da falha) vão por
//    POST /api/mod/aside {sessionId, turnId, text, state, error?}. O fork não faz streaming nem aborta: parar a
//    pergunta na página descarta o resultado.
//
// Por que um plugin à parte do mod `habblaud`: aquele só observa (uso do plano, aviso embaixo do prompt,
// /habblaud) e nunca muda o que a sessão faz. Este age: digita na sessão em seu nome. Separado, dá para ficar sem
// ele (npm run mod:install -- --sem-mensagens) e a análise estática de cada um continua curta.
//
// Regras: nenhum hook lança (um hook que lança é pulado, mas o que ele deixou pela metade fica): cada passo tem seu
// try/catch e falha = silêncio. Uma rodada por vez (um Habblaud lento não acumula perguntas). Nada de $.process,
// $.fs, leitura da conversa nem decisão de ferramenta; do $.model, só o `fork` das perguntas paralelas; a rede é só
// 127.0.0.1. O estado fica em variáveis do módulo: um hot reload recomeça do zero (uma mensagem buscada e não
// confirmada falha no servidor em 30 s; uma pergunta paralela em andamento é dada como perdida em 30 s).
// O Claude Code pode carregar o plugin de uma cópia só dele: os ajudantes de caminho são cópias dos de
// mod/habblaud/hooks/register.ts, não importações.
//
// Análise estática do Claude Code: cada chamada é escrita por extenso ($.noun.método), o nome do evento é
// sempre uma string literal e `$` só é passado para funções declaradas no topo deste arquivo.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Porta padrão do Habblaud (a mesma do servidor, do mod e do docker-compose). */
export const DEFAULT_PORT = 4747
/** Intervalo das perguntas ao Habblaud; fora do ar, recua para o segundo até ele voltar. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** Quanto esperar o Habblaud local responder (`$.http.fetch` não aceita AbortSignal: a corrida é com um timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Quanto esperar `$.prompt.submit` voltar antes de dar a mensagem como na fila da sessão. */
export const SUBMIT_WAIT_MS = 2_000
/** Tamanho máximo do motivo de uma falha (vem de um hook ou de uma exceção; o texto da mensagem nunca é cortado). */
export const MAX_REASON = 500
/** Sinal de vida da pergunta paralela (o servidor a dá por perdida em 30 s sem notícia). */
export const ASIDE_HEARTBEAT_MS = 1_000
/** Quanto esperar o `$.model.fork` (ele não tem prazo próprio nem como ser abortado). */
export const ASIDE_MAX_MS = 180_000
/** Tamanho máximo da resposta enviada; o que passar é cortado com '\n…' (o mesmo limite do servidor). */
export const ASIDE_ANSWER_MAX = 64 * 1024
/** Esperas entre as tentativas de mandar o desfecho da pergunta (rede ou 5xx); 4 tentativas no total. */
export const ASIDE_POST_RETRY_MS: readonly number[] = [300, 1_000, 3_000]

/** Mensagem como POST /api/mod/inbox entrega (shared/types.ts, InboxMessage). */
export interface InboxMessage {
  id: string
  /** O texto como foi digitado; vazio quando o servidor mandou algo que não é texto. */
  text: string
  /** Pergunta paralela (shared/asides.ts, AsideRequest, só o que o plugin usa): vai ao `$.model.fork`, nunca à sessão. */
  aside?: AsideItem
}

/** Pergunta paralela e as anteriores da mesma conversa. */
export interface AsideItem {
  turnId: string
  question: string
  history: Array<{ question: string; answer: string }>
}

/** Estado enviado em POST /api/mod/aside (shared/asides.ts, AsideProgress). */
export type AsideState = 'running' | 'complete' | 'failed' | 'cancelled'

/** Desfecho de um `$.model.fork`. */
type AsideOutcome = { ok: true; text: string } | { ok: false; error: string }

/** Resultado de uma mensagem, como POST /api/mod/inbox/ack recebe. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

/** Desfecho de um `$.prompt.submit`. */
type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  /** Id da conta (o nome da pasta, como o servidor chama); ausente sem HOME (ou USERPROFILE) nem CLAUDE_CONFIG_DIR. */
  accountId?: string
  port: number
  /** Sessão do app desktop do Claude (CLAUDE_CODE_ENTRYPOINT=claude-desktop): roda como SDK e só tem superfície
   *  enquanto está na tela do app, mas é interativa e recebe prompts mesmo assim. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em tests/habblaud-mensagens.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normaliza um caminho (barras repetidas, `.`, `..` e a barra do fim): o ambiente do mod não tem node:path. Cópia
 * de mod/habblaud: caminhos do Windows (com drive ou UNC) saem com `/` e o drive conta como raiz; nos outros, `\`
 * é parte do nome.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? (win && slashed.startsWith('//') ? '/' : '')
  const rest = slashed.slice(drive.length)
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push(seg)
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return drive + (abs ? `/${joined}` : joined || (drive ? '' : '.'))
}

/** `~` no começo vira o HOME. */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** Config dir da conta: o primeiro item de CLAUDE_CONFIG_DIR (com `~` expandido) ou ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Id da conta = nome da pasta (AccountInfo.id do servidor, ex.: ".claude-conta2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Corpo de POST /api/mod/inbox: a conta só quando se sabe qual é. */
export function inboxBody(session: string, account: string | undefined): string {
  // `asides: true` declara que este plugin responde perguntas paralelas: sem o campo (plugin antigo), o servidor não manda nenhuma.
  return JSON.stringify(account ? { session, account, asides: true } : { session, asides: true })
}

/** Corpo de POST /api/mod/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ session, results })
}

/** Lê o `aside` de um item da caixa de entrada; sem turnId ou pergunta, undefined (o item cai como mensagem vazia e falha). */
export function parseAside(raw: unknown): AsideItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const a = raw as Record<string, unknown>
  if (typeof a.turnId !== 'string' || !a.turnId || typeof a.question !== 'string') return undefined
  const history: AsideItem['history'] = []
  if (Array.isArray(a.history)) {
    for (const h of a.history) {
      if (!h || typeof h !== 'object') continue
      const x = h as Record<string, unknown>
      if (typeof x.question === 'string') history.push({ question: x.question, answer: typeof x.answer === 'string' ? x.answer : '' })
    }
  }
  return { turnId: a.turnId, question: a.question, history }
}

/**
 * Lê a resposta de POST /api/mod/inbox; fora do formato = undefined (vale "fora do ar"). Item sem id fica de fora
 * (não há como confirmá-lo); com id e sem texto, entra com texto vazio, para ser confirmado como falha em vez de o
 * servidor esperar 30 s.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    const aside = parseAside(m.aside)
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '', ...(aside ? { aside } : {}) })
  }
  return out
}

/** O motivo de uma falha numa linha só, com tamanho limitado: o texto de um `{drop}` ou a mensagem de uma exceção. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Estado do módulo (some num hot reload) e o que fala com o Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** Uma rodada por vez: um Habblaud lento ou uma sessão ocupada não empilham rodadas. */
let polling = false
/** A pergunta paralela em andamento (uma por sessão): `cancelled` vira true quando o servidor manda descartar. */
let asideRun: { cancelled: boolean } | undefined

/** O ambiente da sessão, lido uma vez por carga (cada nome escrito por extenso, como a análise exige). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // No Windows, HOME só existe se alguém o definir: vale o USERPROFILE (a mesma ordem do mod habblaud).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  const accountId = configDir ? accountIdOf(configDir) : undefined
  if (accountId) next.accountId = accountId
  env = next
  return next
}

/** O que `promise` resolver em até `ms`; passou disso, undefined (a promessa segue sozinha). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** POST de um JSON ao Habblaud local com prazo de 2 s: a resposta, ou undefined (fora do ar, travado). Nunca lança. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // Sem o Content-Type, o guarda do servidor recusa o POST (415).
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** Uma mensagem para a sessão, como se você a tivesse digitado. Nunca lança. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'um hook da sessão recusou a mensagem') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'a sessão não aceitou a mensagem') }
  }
}

/** Pergunta paralela: a de agora e as anteriores da conversa, como um prompt só para o `$.model.fork`. */
export function asidePrompt(req: AsideItem): string {
  const past = req.history.map((h) => `Earlier side question: ${h.question}${h.answer ? `\nYour earlier answer: ${h.answer}` : ''}`)
  return [
    'This is a side question from the user, asked while the session keeps running. Answer it directly and briefly, using only what is already in the conversation above. You have no tools here: do not try to call any, and do not continue or redo the task.',
    ...past,
    `Side question: ${req.question}`,
  ].join('\n\n')
}

/**
 * O que `$.model.fork` devolveu, como resposta ou como erro para a página. Aceita as formas que o Claude Code usa:
 * `null` (sem conversa ainda, ou a API falhou) e o objeto com `text` (e, nas versões novas, `isAnswered`/`reason`: a
 * sessão interrompida volta como "the session was stopped and nobody has sent input since", mostrada como veio).
 */
export function forkOutcome(raw: unknown): AsideOutcome {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'o Claude Code não respondeu: a sessão ainda não tem conversa ou a API falhou' }
  const r = raw as { text?: unknown; isAnswered?: unknown; reason?: unknown }
  if (r.isAnswered === false) return { ok: false, error: reasonText(r.reason, 'o Claude Code não respondeu') }
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  return text ? { ok: true, text: clipAnswer(text) } : { ok: false, error: 'a resposta veio vazia' }
}

/** Corta a resposta em ASIDE_ANSWER_MAX caracteres, marcando o corte com '\n…' (o servidor corta igual). */
export function clipAnswer(text: string): string {
  return text.length <= ASIDE_ANSWER_MAX ? text : `${text.slice(0, ASIDE_ANSWER_MAX - 2)}\n…`
}

/** Corpo de POST /api/mod/aside: `text` é a resposta inteira (o `$.model.fork` não faz streaming). */
export function asideBody(session: string, turnId: string, state: AsideState, text: string, error?: string): string {
  return JSON.stringify({ sessionId: session, turnId, text, state, ...(error ? { error } : {}) })
}

/** O servidor pede para descartar o resultado (a pergunta foi parada): `{cancel: true}` na resposta de POST /api/mod/aside. */
export function wantsCancel(res: HttpResponse | undefined): boolean {
  if (!res?.ok) return false
  try {
    return (JSON.parse(res.text) as { cancel?: unknown } | null)?.cancel === true
  } catch {
    return false
  }
}

/** Pausa de `ms` (o prazo é o mesmo `$.clock.after` dos pedidos: nenhum $.clock.sleep a mais na análise). */
async function pause($: EngineInterface, ms: number): Promise<void> {
  await waitAtMost($, new Promise<never>(() => {}), ms)
}

/** A pergunta à sessão pelo `$.model.fork`, sem entrar na conversa. Nunca lança. */
async function forkOne($: EngineInterface, prompt: string): Promise<AsideOutcome> {
  try {
    return forkOutcome(await $.model.fork({ prompt }))
  } catch (err) {
    return { ok: false, error: reasonText(err, 'a sessão não aceitou a pergunta') }
  }
}

/** Manda o desfecho da pergunta; repete quando o pedido não chegou ou o servidor falhou (4xx é recusa definitiva). */
async function postFinal($: EngineInterface, port: number, body: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const r = await postJson($, port, '/api/mod/aside', body)
    if (r && r.status < 500) return
    const wait = ASIDE_POST_RETRY_MS[attempt]
    if (wait === undefined) return
    await pause($, wait)
  }
}

/**
 * Roda a pergunta paralela fora da rodada (o `$.model.fork` leva segundos, e a rodada não pode passar de 2 s):
 * um sinal de vida a cada segundo (o servidor dá a pergunta por perdida em 30 s sem notícia) e, no fim, a resposta
 * inteira. O `$.model.fork` não tem como ser abortado: se o usuário para a pergunta (o servidor responde
 * `{cancel: true}` ao sinal de vida), a pergunta é dada como parada na hora e o resultado, quando chegar, é
 * descartado. Nunca lança.
 */
async function runAside($: EngineInterface, port: number, session: string, req: AsideItem, run: { cancelled: boolean }): Promise<void> {
  let beat: { cancel: () => void } | undefined
  try {
    beat = $.clock.every(ASIDE_HEARTBEAT_MS, () => {
      void postJson($, port, '/api/mod/aside', asideBody(session, req.turnId, 'running', '')).then((res) => {
        if (run.cancelled || !wantsCancel(res)) return
        run.cancelled = true
        beat?.cancel()
        // A sessão fica livre para a próxima pergunta; o fork que sobrou termina sozinho.
        if (asideRun === run) asideRun = undefined
        void postFinal($, port, asideBody(session, req.turnId, 'cancelled', ''))
      })
    })
    const out = await waitAtMost($, forkOne($, asidePrompt(req)), ASIDE_MAX_MS)
    beat?.cancel()
    beat = undefined
    if (run.cancelled) return
    if (!out) await postFinal($, port, asideBody(session, req.turnId, 'failed', '', 'o Claude Code demorou demais para responder'))
    else if (out.ok) await postFinal($, port, asideBody(session, req.turnId, 'complete', out.text))
    else await postFinal($, port, asideBody(session, req.turnId, 'failed', '', out.error))
  } catch {
    // silêncio: sem o desfecho, o servidor dá a pergunta por perdida em 30 s
  } finally {
    beat?.cancel()
    if (asideRun === run) asideRun = undefined
  }
}

/** Inicia a pergunta paralela e confirma na hora (a resposta sai por outra rota). Uma por vez por sessão. */
function startAside($: EngineInterface, port: number, session: string, id: string, req: AsideItem): AckResult {
  if (!req.question.trim()) return { id, ok: false, error: 'pergunta vazia' }
  if (asideRun) return { id, ok: false, error: 'já há uma pergunta paralela em andamento' }
  const run = { cancelled: false }
  asideRun = run
  void runAside($, port, session, req, run)
  return { id, ok: true }
}

/** Manda as mensagens à sessão, na ordem, e devolve o resultado de cada uma. Nunca lança. */
async function deliver($: EngineInterface, port: number, session: string, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** Uma chamada passou do prazo: a sessão está ocupada e as seguintes entram na fila atrás dela, sem esperar. */
  let queued = false
  for (const m of messages) {
    if (m.aside) {
      // Pergunta paralela: nunca vai à sessão como prompt.
      results.push(startAside($, port, session, m.id, m.aside))
      continue
    }
    if (!m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'mensagem vazia' })
      continue
    }
    const submitted = submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)agenda as rodadas: 2 s com o Habblaud no ar, 30 s fora do ar. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** Uma rodada: busca as mensagens desta sessão, manda cada uma e confirma. Nunca lança. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const res = await postJson($, e.port, '/api/mod/inbox', inboxBody(session, e.accountId))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (!messages.length) return
    const results = await deliver($, e.port, session, messages)
    // Falhou a confirmação: o servidor dá as mensagens como falhas em 30 s ("a sessão não confirmou a entrega").
    await postJson($, e.port, '/api/mod/inbox/ack', ackBody(session, results))
  } catch {
    // silêncio: a próxima rodada tenta de novo
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // sem as rodadas, a sessão segue como sempre
    }
    return next(e)
  })
}
