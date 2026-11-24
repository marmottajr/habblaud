// Eventos dos hooks do Antigravity CLI (a parte "ao vivo" da fonte do Antigravity): o script de hook manda o stdin do
// evento para POST /api/antigravity/events e a rota repassa aqui. A fonte (sources/antigravity/source.ts) implementa.

export interface AntigravityLive {
  /**
   * Aplica um evento de hook do Antigravity CLI (o stdin dele em camelCase: `hookEventName`, `conversationId`,
   * `parentConversationId`, `agentName`, `workspacePaths`, `cwd`, `transcriptPath`, `modelName`, `lastUserInput`,
   * `toolCall`, `error`, `terminationReason`...) ao escritório. `account` = conta do Antigravity de quem mandou (id da
   * conta ou a pasta de dados; ausente = deduzida do `transcriptPath` ou da conversa). Devolve false para evento
   * desconhecido ou conversa que não casa com nenhuma conta do Antigravity.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
