// Mesas da sala: organizar quem senta onde, arrastando o agente até a mesa, no próprio escritório.
// Com a sala de equipe aberta (clicada), pega-se um agente fixo dela com o mouse e solta-se na mesa para onde ele
// vai; se a mesa tem dono, os dois trocam de lugar. A escolha é guardada com a aparência da sala (RoomStyle.seats)
// e a tela manda cada um para a mesa dele. No painel da sala fica só a dica e o botão de desfazer.
import type { AgentInfo, RoomInfo } from '../../../shared/types';
import type { SeatDrag } from '../world/api';
import { createAvatarPlaceholder, updateAvatar } from './avatar';
import type { UiComponent, UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { canStyleRoom, styleRequest } from './roomstyle';

/** Uma mesa do mapa (WorldApi.roomDesks): número, posição dentro da sala (0 a 1) e o agente fixo que é dela. */
export interface Mesa {
  n: number;
  x: number;
  y: number;
  staff?: string;
}

/**
 * As mesas depois de mandar um agente para outra: quem já tinha lugar continua onde está, e se a mesa de destino
 * era de alguém, os dois trocam (ou, se quem chega não tinha mesa, o outro fica sem).
 */
export function moverParaMesa(mesas: readonly Pick<Mesa, 'n' | 'staff'>[], slug: string, destino: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mesas) if (m.staff) out[m.staff] = m.n;
  const origem = out[slug];
  const dono = mesas.find((m) => m.n === destino)?.staff;
  if (dono && dono !== slug) {
    if (origem) out[dono] = origem;
    else delete out[dono];
  }
  out[slug] = destino;
  return out;
}

/** Os agentes fixos da sala (um por nome de arquivo), com o nome que aparece na tela. */
export function fixosDaSala(roomId: string, agents: readonly Pick<AgentInfo, 'roomId' | 'staff' | 'kind' | 'name' | 'job'>[]): { slug: string; nome: string; funcao?: string }[] {
  const vistos = new Map<string, { slug: string; nome: string; funcao?: string }>();
  for (const a of agents) if (a.roomId === roomId && a.kind === 'main' && a.staff && !vistos.has(a.staff)) vistos.set(a.staff, { slug: a.staff, nome: a.name, funcao: a.job });
  return [...vistos.values()];
}

/** A mesa mais perto do cursor, se ele está a até um quadrado e meio dela; senão, nenhuma. */
export function mesaSobCursor<T extends { n: number; x: number; y: number; tile: number }>(mesas: readonly T[], x: number, y: number): T | undefined {
  let melhor: T | undefined;
  let menor = Infinity;
  for (const m of mesas) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < menor && d <= m.tile * 1.5) {
      menor = d;
      melhor = m;
    }
  }
  return melhor;
}

/** Grava as mesas com o resto da aparência da sala; `undefined` tira as marcas. */
async function gravarMesas(room: RoomInfo, seats: Record<string, number> | undefined): Promise<void> {
  const { seats: _antes, ...resto } = room.style ?? {};
  await styleRequest(room.id, seats ? { ...resto, seats } : resto);
}

/** No painel da sala: a dica de como organizar as mesas e o botão de voltar ao automático. */
export class MesasPicker {
  readonly el: HTMLElement;
  private dica: HTMLElement;
  private msg: HTMLElement;
  private soltar: HTMLButtonElement;
  private room: RoomInfo | null = null;
  private ocupado = false;

  constructor() {
    this.dica = h('p', { class: 'ui-muted ui-small' });
    this.msg = h('p', { class: 'ui-ask__msg ui-ask__msg--erro', role: 'status', hidden: true });
    this.soltar = h('button', {
      class: 'ui-btn ui-rot__mini',
      type: 'button',
      text: 'Deixar o escritório escolher as mesas',
      title: 'Tira as mesas marcadas: cada agente senta na primeira mesa livre',
      hidden: true,
      on: { click: () => void this.desfazer() },
    });
    this.el = h('div', { class: 'ui-mesas' }, h('p', { class: 'ui-dem__rot', text: 'Mesas' }), this.dica, h('div', { class: 'ui-estilo__acoes' }, this.soltar), this.msg);
  }

  render(room: RoomInfo, temAgentes: boolean): void {
    this.room = room;
    setText(this.dica, temAgentes ? 'Para mudar alguém de mesa, arraste o agente até a mesa, aqui no escritório, com esta sala aberta. Soltou na mesa de outro, os dois trocam de lugar.' : 'Esta sala ainda não tem agentes para organizar.');
    setHidden(this.soltar, !room.style?.seats);
  }

  private async desfazer(): Promise<void> {
    const room = this.room;
    if (!room || this.ocupado) return;
    this.ocupado = true;
    try {
      await gravarMesas(room, undefined);
      setHidden(this.msg, true);
    } catch (err) {
      setText(this.msg, `Não foi possível mudar as mesas: ${err instanceof Error ? err.message : 'erro'}.`);
      setHidden(this.msg, false);
    } finally {
      this.ocupado = false;
    }
  }
}

/**
 * O arrasto no escritório: com a sala de equipe aberta, o mundo deixa arrastar os agentes fixos dela
 * (WorldApi.seatEditing) e avisa cada movimento (onSeatDrag). Aqui se desenha o agente "na mão", as mesas da sala
 * (com quem senta em cada uma) e, ao soltar, grava-se a mesa nova.
 */
export class MesasDrag implements UiComponent {
  readonly el: HTMLElement;
  private mao: HTMLElement;
  private avatar: HTMLElement;
  private nome: HTMLElement;
  private alvos: HTMLElement;
  private aviso: HTMLElement;
  private alvoBtns: HTMLElement[] = [];
  private editando: string | null = null;
  private sumirEm: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: UiContext) {
    this.avatar = createAvatarPlaceholder('sm');
    this.nome = h('span', { class: 'ui-mesa-mao__nome' });
    this.mao = h('div', { class: 'ui-mesa-mao', hidden: true }, this.avatar, this.nome);
    this.alvos = h('div', { class: 'ui-mesa-alvos', hidden: true });
    this.aviso = h('div', { class: 'ui-mesa-aviso', role: 'status', hidden: true });
    this.el = h('div', { class: 'ui-mesa-arrasto', attrs: { 'aria-hidden': 'true' } }, this.alvos, this.mao, this.aviso);
    ctx.world.onSeatDrag?.((d) => this.arrasto(d));
  }

  /** A sala aberta é de equipe (e não a do dono)? Então os agentes dela podem ser arrastados. */
  render(): void {
    const sel = this.ctx.selection();
    const snap = this.ctx.store.snapshot;
    const room = sel?.type === 'room' && snap && !snap.meta.demo ? snap.rooms.find((r) => r.id === sel.id) : undefined;
    const pode = room?.team && !room.office && canStyleRoom(this.ctx, room.id) ? room.id : null;
    if (pode === this.editando) return;
    this.editando = pode;
    this.ctx.world.seatEditing?.(pode);
  }

  private arrasto(d: SeatDrag): void {
    const snap = this.ctx.store.snapshot;
    const room = snap?.rooms.find((r) => r.id === d.roomId);
    const mesas = this.ctx.world.roomDesksScreen?.(d.roomId) ?? [];
    const alvo = mesaSobCursor(mesas, d.x, d.y);
    if (d.fim) {
      setHidden(this.mao, true);
      setHidden(this.alvos, true);
      // Soltou em cima de uma mesa que não é a dele: grava. Fora de mesa, ou na própria, nada muda.
      if (d.fim === 'soltou' && room && alvo && alvo.staff !== d.staff) void this.gravar(room, moverParaMesa(mesas, d.staff, alvo.n));
      return;
    }
    const fixos = new Map(fixosDaSala(d.roomId, snap?.agents ?? []).map((f) => [f.slug, f]));
    const eu = snap?.agents.find((a) => a.id === d.agentId);
    // O agente na mão, ao lado do cursor.
    if (eu) updateAvatar(this.avatar, eu, 'sm');
    setText(this.nome, eu?.name ?? d.staff);
    this.mao.style.left = `${Math.round(d.x)}px`;
    this.mao.style.top = `${Math.round(d.y)}px`;
    setHidden(this.mao, false);
    // As mesas da sala: de quem é cada uma, e a que vai receber o agente se ele for solto agora.
    while (this.alvoBtns.length < mesas.length) {
      const b = h('div', { class: 'ui-mesa-alvo' });
      this.alvoBtns.push(b);
      this.alvos.append(b);
    }
    this.alvoBtns.forEach((b, i) => {
      const m = mesas[i];
      setHidden(b, !m);
      if (!m) return;
      const dono = m.staff ? fixos.get(m.staff) : undefined;
      const minha = m.staff === d.staff;
      setText(b, minha ? 'mesa atual' : dono ? `trocar com ${dono.nome}` : 'livre');
      b.classList.toggle('is-alvo', m.n === alvo?.n && !minha);
      b.classList.toggle('is-minha', minha);
      b.style.left = `${Math.round(m.x)}px`;
      b.style.top = `${Math.round(m.y)}px`;
    });
    setHidden(this.alvos, false);
  }

  private async gravar(room: RoomInfo, seats: Record<string, number>): Promise<void> {
    try {
      await gravarMesas(room, seats);
    } catch (err) {
      setText(this.aviso, `Não foi possível mudar a mesa: ${err instanceof Error ? err.message : 'erro'}.`);
      setHidden(this.aviso, false);
      if (this.sumirEm) clearTimeout(this.sumirEm);
      this.sumirEm = setTimeout(() => setHidden(this.aviso, true), 6000);
    }
  }
}
