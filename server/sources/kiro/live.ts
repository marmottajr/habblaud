// Eventos do hook do Kiro (mod/habblaud-kiro/hook.mjs -> POST /api/kiro/events, server/kiro/http.ts): a parte "ao
// vivo" da fonte do Kiro. O 2.x manda os nomes em camelCase (userPromptSubmit), o 3.x em PascalCase: aqui ficam no 3.x.

export type KiroHookName = 'AgentSpawn' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';

const NAMES: Record<string, KiroHookName> = {
  agentspawn: 'AgentSpawn',
  userpromptsubmit: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  stop: 'Stop',
};

export function kiroHookName(raw: unknown): KiroHookName | undefined {
  return typeof raw === 'string' ? NAMES[raw.toLowerCase()] : undefined;
}

export interface KiroHookPayload {
  hook_event_name: KiroHookName;
  session_id: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  assistant_response?: string;
}

export interface KiroHookEvent {
  /** Pasta do Kiro de quem mandou (KIRO_HOME ou ~/.kiro), no computador onde o hook roda. */
  kiroHome?: string;
  /** Processos do Kiro acima do hook (só no Linux). */
  pids: number[];
  /** process.platform do hook. */
  platform?: string;
  event: KiroHookPayload;
}

export interface KiroLive {
  /** Aplica um evento do hook ao escritório. false = sessão ou evento que não deu para usar. */
  applyHookEvent(e: KiroHookEvent): boolean;
}
