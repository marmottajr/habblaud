// Ritmo do laço do escritório: 60 qps só quando a câmera se mexe ou há entrada; parado, 30 (15 sem foco).
// Puro (sem DOM): testado em pacing.test.ts.

/** Escritório parado, janela com foco. */
export const IDLE_FPS = 30;
/** Escritório parado, janela sem foco (ex.: num segundo monitor). */
export const UNFOCUSED_FPS = 15;
/** Por quanto tempo depois de uma entrada (mouse, roda, toque, teclado) o laço segue no ritmo do monitor. */
export const ACTIVE_GRACE_MS = 1000;

/**
 * Limite de quadros por segundo (0 = o do monitor). `uiCap` é o limite pedido pela interface (`setFrameCap`, ex.: 30
 * com o terminal aberto); `active` = câmera em movimento, entrada recente ou timelapse.
 */
export function frameCapFor(s: { uiCap: number; active: boolean; focused: boolean }): number {
  if (s.active) return s.uiCap;
  const idle = s.focused ? IDLE_FPS : UNFOCUSED_FPS;
  return s.uiCap > 0 ? Math.min(s.uiCap, idle) : idle;
}
