/**
 * Habblaud — extensão ao vivo para o Pi coding agent.
 *
 * Envia eventos de ciclo de vida da sessão para o Habblaud local (`POST /api/pi/events`) e
 * permite receber mensagens enviadas pelo escritório (`POST /api/mod/inbox` -> `pi.sendUserMessage`).
 *
 * Sem dependências externas (usa apenas APIs nativas do Node 22+ e fetch). Nunca bloqueia nem
 * interrompe o Pi quando o Habblaud estiver desligado.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

interface PiSessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getSessionName?(): string | undefined;
}

interface PiContextLike {
  cwd: string;
  sessionManager: PiSessionManagerLike;
  model?: { id?: string } | undefined;
  isIdle(): boolean;
}

interface PiApiLike {
  on(event: string, handler: (event: any, ctx: PiContextLike) => any): () => void;
  sendUserMessage?(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  getSessionName?(): string | undefined;
}

const DEFAULT_PORT = 4747;
const EVENT_TIMEOUT_MS = 1_500;
const SHUTDOWN_TIMEOUT_MS = 800;
const HEARTBEAT_MS = 25_000;
const INBOX_POLL_MS = 2_500;
const MAX_ARG_STR = 600;
const MAX_PROMPT_STR = 1_000;

function readPort(): number {
  const fromEnv = Number.parseInt(process.env.HABBLAUD_PI_PORT ?? process.env.HABBLAUD_PORT ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), '.habblaud', 'pi-extension.json'), 'utf8');
    const cfg = JSON.parse(raw) as { port?: unknown };
    if (typeof cfg.port === 'number' && cfg.port > 0 && cfg.port < 65536) return cfg.port;
  } catch {
    // usa porta padrão
  }
  return DEFAULT_PORT;
}

function detectPiDir(ctx: PiContextLike): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return resolve(envDir);
  try {
    const sdir = ctx.sessionManager.getSessionDir();
    // <piDir>/sessions/<encoded-cwd> -> volta dois níveis
    if (sdir) return resolve(dirname(dirname(sdir)));
  } catch {
    // cai no padrão
  }
  return join(homedir(), '.pi', 'agent');
}

function trimString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function trimArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = trimString(v, MAX_ARG_STR);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export default function habblaudExtension(pi: PiApiLike): void {
  const baseUrl = `http://127.0.0.1:${readPort()}`;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let lastCtx: PiContextLike | null = null;
  let inboxBusy = false;

  const sessionMeta = (ctx: PiContextLike) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const piDir = detectPiDir(ctx);
    const sessionName = pi.getSessionName?.() ?? ctx.sessionManager.getSessionName?.();
    return {
      piDir,
      sessionId,
      ...(sessionFile ? { sessionFile } : {}),
      cwd: ctx.cwd,
      ...(ctx.model?.id ? { model: ctx.model.id } : {}),
      ...(sessionName ? { sessionName } : {}),
    };
  };

  const postJson = async (path: string, body: unknown, timeoutMs = EVENT_TIMEOUT_MS): Promise<Response | undefined> => {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  };

  const sendEvent = (ctx: PiContextLike, type: string, extra: Record<string, unknown> = {}, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> => {
    lastCtx = ctx;
    const meta = sessionMeta(ctx);
    if (!meta.sessionId) return Promise.resolve();
    const { piDir, ...eventMeta } = meta;
    return postJson(
      '/api/pi/events',
      {
        piDir,
        event: {
          type,
          ...eventMeta,
          idle: ctx.isIdle(),
          ...extra,
        },
      },
      timeoutMs,
    ).then(() => undefined);
  };

  const pollInbox = async (): Promise<void> => {
    if (inboxBusy || !lastCtx || !pi.sendUserMessage) return;
    const session = lastCtx.sessionManager.getSessionId();
    if (!session) return;
    inboxBusy = true;
    try {
      const res = await postJson('/api/mod/inbox', { session });
      if (!res || !res.ok) return;
      const data = (await res.json()) as { messages?: Array<{ id: string; text: string }> };
      const msgs = Array.isArray(data?.messages) ? data.messages : [];
      if (!msgs.length) return;
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const m of msgs) {
        if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') continue;
        try {
          pi.sendUserMessage(m.text, { deliverAs: 'followUp' });
          results.push({ id: m.id, ok: true });
        } catch (err) {
          results.push({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (results.length) await postJson('/api/mod/inbox/ack', { session, results });
    } catch {
      // ignora quando Habblaud não está rodando ou mensagens estão desligadas
    } finally {
      inboxBusy = false;
    }
  };

  const stopTimers = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = null;
    }
  };

  const startTimers = (ctx: PiContextLike): void => {
    stopTimers();
    lastCtx = ctx;
    heartbeatTimer = setInterval(() => {
      if (lastCtx) void sendEvent(lastCtx, 'heartbeat');
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    if (pi.sendUserMessage) {
      inboxTimer = setInterval(() => {
        void pollInbox();
      }, INBOX_POLL_MS);
      inboxTimer.unref?.();
    }
  };

  pi.on('session_start', (event, ctx) => {
    startTimers(ctx);
    void sendEvent(ctx, 'session_start', { reason: event?.reason });
  });

  pi.on('session_info_changed', (event, ctx) => {
    void sendEvent(ctx, 'session_info_changed', { sessionName: trimString(event?.name, 120) });
  });

  pi.on('before_agent_start', (event, ctx) => {
    const prompt = event?.messageType === 'user' ? trimString(event?.prompt, MAX_PROMPT_STR) : undefined;
    void sendEvent(ctx, 'before_agent_start', prompt ? { prompt } : {});
  });

  pi.on('agent_start', (_event, ctx) => {
    void sendEvent(ctx, 'agent_start');
  });

  pi.on('tool_execution_start', (event, ctx) => {
    void sendEvent(ctx, 'tool_execution_start', {
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      args: trimArgs(event?.args),
    });
  });

  pi.on('tool_execution_end', (event, ctx) => {
    void sendEvent(ctx, 'tool_execution_end', {
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      isError: event?.isError === true,
      durationMs: typeof event?.durationMs === 'number' ? event.durationMs : undefined,
    });
  });

  pi.on('ui_prompt_start', (event, ctx) => {
    void sendEvent(ctx, 'ui_prompt_start', {
      kind: event?.kind,
      title: trimString(event?.title, 120),
    });
  });

  pi.on('ui_prompt_end', (event, ctx) => {
    void sendEvent(ctx, 'ui_prompt_end', {
      kind: event?.kind,
      title: trimString(event?.title, 120),
    });
  });

  pi.on('model_select', (event, ctx) => {
    void sendEvent(ctx, 'model_select', { model: event?.model?.id });
  });

  pi.on('session_compact', (_event, ctx) => {
    void sendEvent(ctx, 'session_compact');
  });

  pi.on('agent_end', (_event, ctx) => {
    void sendEvent(ctx, 'agent_end');
  });

  pi.on('agent_settled', (event, ctx) => {
    void sendEvent(ctx, 'agent_settled', { aborted: event?.aborted === true });
  });

  pi.on('session_shutdown', async (event, ctx) => {
    stopTimers();
    await sendEvent(ctx, 'session_shutdown', { reason: event?.reason }, SHUTDOWN_TIMEOUT_MS);
    lastCtx = null;
  });
}
