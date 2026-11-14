import type { UiContext } from './context';

/**
 * Modo TV (`?tv=1`, ou `?tv=<segundos>`): para deixar o escritório aberto numa TV (ex.: Fire TV).
 * - Layout com 1920 px de largura, igual ao do computador (TVs anunciam ~960 px e tudo fica enorme).
 * - Passeia sozinho pelas salas com agentes ativos (trabalhando, esperando você ou rodando comando), abrindo o painel da sala,
 *   com prioridade para quem está esperando você; sem ninguém ativo, mostra a visão geral.
 */
export function tvModeFromUrl(): number | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('tv');
  if (v === null) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 5 ? s : 15;
}

export function startTvMode(ctx: UiContext, seconds: number): void {
  const meta = document.querySelector('meta[name="viewport"]');
  meta?.setAttribute('content', 'width=1920, viewport-fit=cover');
  document.documentElement.classList.add('tv-mode');

  // Passeia pelas salas com agentes ativos: selecionar a sala abre o painel dela (agentes + atividade recente).
  let idx = 0;
  let current: string | null = null;
  const tick = (): void => {
    const agents = ctx.store.snapshot?.agents ?? [];
    const active = agents.filter((a) => a.status === 'working' || a.status === 'waiting' || a.status === 'shell');
    const rooms = [...new Set(active.map((a) => a.roomId).filter((r): r is string => !!r))];
    if (!rooms.length) {
      if (current !== null) ctx.select(null);
      ctx.world.overview();
      current = null;
      return;
    }
    const waitingRoom = active.find((a) => a.status === 'waiting')?.roomId;
    let next = waitingRoom ?? rooms[idx++ % rooms.length];
    if (!waitingRoom && next === current && rooms.length > 1) next = rooms[idx++ % rooms.length];
    if (next === current && ctx.selection()?.type === 'room') return;
    current = next;
    ctx.select({ type: 'room', id: next }, { focus: true });
  };
  const start = (): void => {
    tick();
    setInterval(tick, seconds * 1000);
  };
  if (ctx.store.snapshot) setTimeout(start, 800);
  else {
    const off = ctx.store.on('snapshot', () => {
      off();
      setTimeout(start, 800);
    });
  }
}
