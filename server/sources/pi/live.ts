// Eventos ao vivo da extensão do Pi (mod/habblaud-pi/habblaud.ts): chegam por POST /api/pi/events
// e são aplicados direto na PiSource (sources/pi/source.ts).

export interface PiLive {
  /**
   * Aplica um evento ao vivo vindo da extensão do Pi (`type`, `sessionId`, `cwd`, `sessionFile`, `model`,
   * `sessionName`, `toolCallId`, `toolName`, `args`, `isError`, `prompt`, `title`, `reason`...).
   * `account` = id da conta do Pi (ou deduzida de `piDir`/`sessionFile`). Devolve false se ignorado.
   */
  applyLiveEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
