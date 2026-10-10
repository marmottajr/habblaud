// Personalizar a sala (painel que abre ao clicar nela): o layout dos móveis, o estilo (piso, parede e móveis), a
// cor (da paleta ou livre) e o lado da ilha de mesas. Cada layout tem um ícone, que também aparece ao lado do nome
// da sala. A escolha fica no servidor (POST /api/rooms/style, server/model/room-styles.ts) e vale para todas as
// abas; a sala é refeita na hora (client/src/world/sim/sim.ts, restyleRoom). Sem nada escolhido, a sala é a que a
// semente dela sorteia.
import { OFFICE_STYLE_INFO, ROOM_COLOR_RE, ROOM_COLORS, ROOM_LAYOUT_INFO, ROOM_LAYOUTS, ROOM_LOOK_INFO, ROOM_LOOKS, type OfficeColors, type OfficeStyleId, type RoomLayoutId, type RoomLookId, type RoomStyle } from '../../../shared/roomstyle';
import { isDemoId } from '../../../shared/timeline';
import type { RoomInfo } from '../../../shared/types';
import type { FloorKind, RoomTheme } from '../art/api';
import { colorTheme, styledTheme } from '../art/roomlook';
import { roomTheme } from '../art/theme';
import { roomVariant } from '../world/layout/room';
import type { UiContext } from './context';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { pixelIcon } from './icons';
import { isLocalHostname } from './permission';

export type LayoutChoice = RoomLayoutId | 'auto';
export const LAYOUT_CHOICES: readonly LayoutChoice[] = ['auto', ...ROOM_LAYOUTS];
export type LookChoice = RoomLookId | 'auto';
export const LOOK_CHOICES: readonly LookChoice[] = ['auto', ...ROOM_LOOKS];

/** O ícone de cada layout (10x10, na cor do texto). */
export const LAYOUT_ICONS: Record<LayoutChoice, string> = {
  // brilho: o escritório escolhe
  auto: pixelIcon(['....#.....', '....#.....', '...###....', '.#######..', '...###....', '....#.....', '....#...#.', '.......###', '........#.', '..........']),
  // duas ilhas de mesas, com o corredor no meio
  equipe: pixelIcon(['..........', '####..####', '####..####', '..........', '####..####', '####..####', '..........', '####..####', '####..####', '..........']),
  // quatro gabinetes: a sala dividida em cruz, uma mesa em cada
  diretoria: pixelIcon(['....#.....', '.##.#.##..', '.##.#.##..', '....#.....', '#########.', '....#.....', '.##.#.##..', '.##.#.##..', '....#.....', '..........']),
  // sofá
  criativo: pixelIcon(['..........', '..........', '.#......#.', '.#......#.', '.########.', '.########.', '.########.', '.#......#.', '..........', '..........']),
  // mesa redonda com quatro lugares
  reunioes: pixelIcon(['....##....', '..........', '...####...', '#.######.#', '#.######.#', '...####...', '..........', '....##....', '..........', '..........']),
  // arquivo de gavetas
  operacao: pixelIcon(['.########.', '.#......#.', '.#.####.#.', '.#......#.', '.########.', '.#......#.', '.#.####.#.', '.#......#.', '.########.', '..........']),
  // mesa comprida com três lugares de cada lado
  conferencia: pixelIcon(['..........', '.#..#..#..', '..........', '########..', '########..', '########..', '..........', '.#..#..#..', '..........', '..........']),
  // uma pessoa atrás de uma mesa
  individual: pixelIcon(['....##....', '...####...', '....##....', '..######..', '..........', '.########.', '.########.', '.#......#.', '.#......#.', '..........']),
};

/** O layout em uso na sala, para o ícone ao lado do nome. */
export const layoutOf = (r: Pick<RoomInfo, 'style'> | null | undefined): LayoutChoice => r?.style?.layout ?? 'auto';

/** O estilo em uso na sala. */
export const lookOf = (r: Pick<RoomInfo, 'style'> | null | undefined): LookChoice => r?.style?.look ?? 'auto';

/** A cor de destaque da sala (a faixa da lista e o quadrado ao lado do nome): a escolhida, ou a da própria sala. */
export const accentOf = (r: Pick<RoomInfo, 'seed' | 'style'>): string => styledTheme(r.seed, r.style).accent;

/** A ilha de mesas está do lado invertido? (O escolhido, ou o que a semente sorteou.) */
export const mirrorOf = (r: Pick<RoomInfo, 'seed' | 'style'>): boolean => r.style?.mirror ?? roomVariant(r.seed).mirror;

/** A aparência depois de uma escolha: "auto" num campo volta aquele campo ao automático. */
export function comEscolha(atual: RoomStyle | undefined, mudanca: { layout?: LayoutChoice; look?: LookChoice; color?: number | string | 'auto'; mirror?: boolean }): RoomStyle {
  const out: RoomStyle = { ...(atual ?? {}) };
  if (mudanca.layout !== undefined) {
    if (mudanca.layout === 'auto') delete out.layout;
    else out.layout = mudanca.layout;
  }
  if (mudanca.look !== undefined) {
    if (mudanca.look === 'auto') delete out.look;
    else out.look = mudanca.look;
  }
  if (mudanca.color !== undefined) {
    if (mudanca.color === 'auto') delete out.color;
    else out.color = typeof mudanca.color === 'string' ? mudanca.color.toLowerCase() : mudanca.color;
  }
  if (mudanca.mirror !== undefined) out.mirror = mudanca.mirror;
  return out;
}

/** A cor do piso na miniatura do estilo (os pisos desenhados não têm uma cor só: é a que mais aparece). */
const FLOOR_COLORS: Partial<Record<FloorKind, string>> = { marble: '#e7e8ea', wood: '#b98a5a', concrete: '#b3b7be' };
const DESK_COLORS: Record<string, string> = { white: '#f3f4f6', wood: '#b07a4a', dark: '#6a4e3c', black: '#2e323b' };

/** As quatro cores da miniatura de um estilo: parede, rodapé, piso e mesa. */
export function previewOf(theme: RoomTheme): { parede: string; rodape: string; piso: string; mesa: string } {
  const piso = theme.floor === 'carpet' ? (theme.floorColor ?? theme.carpet) : (FLOOR_COLORS[theme.floor ?? 'marble'] ?? '#e7e8ea');
  return { parede: theme.wall.base, rodape: theme.wall.trim ?? theme.wall.base, piso, mesa: DESK_COLORS[theme.deskVariant] ?? '#f3f4f6' };
}

/** Dá para personalizar esta sala daqui? As mesmas condições de renomear (ui/roomrename.ts). */
export function canStyleRoom(ctx: UiContext, roomId: string): boolean {
  return !isDemoId(roomId) && !ctx.store.mock && !ctx.store.replaying && !!ctx.store.snapshot?.meta.terminal && isLocalHostname(location.hostname);
}

export async function styleRequest(id: string, style: RoomStyle): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/rooms/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, style }) });
  } catch {
    throw new Error('o Habblaud não respondeu');
  }
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `erro ${res.status}`);
}

/** Os controles de "Aparência da sala": layouts (com ícone), estilos, cores e o lado da ilha. */
export class RoomStylePicker {
  readonly el: HTMLElement;
  private layouts = new Map<LayoutChoice, HTMLButtonElement>();
  private looks = new Map<LookChoice, HTMLButtonElement>();
  private cores = new Map<number | 'auto', HTMLButtonElement>();
  private livre: HTMLLabelElement;
  private livreInput: HTMLInputElement;
  private inverter: HTMLButtonElement;
  private voltar: HTMLButtonElement;
  private msg: HTMLElement;
  private room: RoomInfo | null = null;
  private ocupado = false;
  private sig = '';

  constructor() {
    const grade = h('div', { class: 'ui-estilo__layouts', role: 'group', attrs: { 'aria-label': 'Layout da sala' } });
    for (const id of LAYOUT_CHOICES) {
      const b = h('button', { class: 'ui-estilo__layout', type: 'button', title: ROOM_LAYOUT_INFO[id].dica, attrs: { 'aria-pressed': 'false' }, on: { click: () => void this.mudar({ layout: id }) } });
      b.innerHTML = LAYOUT_ICONS[id];
      b.append(h('span', { text: ROOM_LAYOUT_INFO[id].nome }));
      this.layouts.set(id, b);
      grade.append(b);
    }
    // Estilos: cada botão mostra uma miniatura (parede, rodapé, piso e a mesa) na cor de hoje da sala.
    const estilos = h('div', { class: 'ui-estilo__looks', role: 'group', attrs: { 'aria-label': 'Estilo da sala' } });
    for (const id of LOOK_CHOICES) {
      const b = h(
        'button',
        { class: 'ui-estilo__look', type: 'button', title: ROOM_LOOK_INFO[id].dica, attrs: { 'aria-pressed': 'false' }, on: { click: () => void this.mudar({ look: id }) } },
        h('span', { class: 'ui-estilo__mini', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'ui-estilo__mesa' })),
        h('span', { text: ROOM_LOOK_INFO[id].nome }),
      );
      this.looks.set(id, b);
      estilos.append(b);
    }
    const paleta = h('div', { class: 'ui-estilo__cores', role: 'group', attrs: { 'aria-label': 'Cor da sala' } });
    const auto = h('button', { class: 'ui-estilo__cor ui-estilo__cor--auto', type: 'button', text: 'Auto', title: 'A cor que o escritório sorteou para esta sala', attrs: { 'aria-pressed': 'false' }, on: { click: () => void this.mudar({ color: 'auto' }) } });
    this.cores.set('auto', auto);
    paleta.append(auto);
    for (let i = 0; i < ROOM_COLORS; i++) {
      const b = h('button', { class: 'ui-estilo__cor', type: 'button', title: `Cor ${i + 1}`, attrs: { 'aria-pressed': 'false', 'aria-label': `Cor ${i + 1}` }, on: { click: () => void this.mudar({ color: i }) } });
      try {
        b.style.setProperty('--cor', roomTheme(i).accent);
      } catch {
        // Sem tema: a bolinha fica na cor padrão.
      }
      this.cores.set(i, b);
      paleta.append(b);
    }
    // Cor livre: o seletor de cores do sistema. A sala muda quando a pessoa fecha a escolha.
    this.livreInput = h('input', { type: 'color', attrs: { 'aria-label': 'Escolher outra cor', value: '#3f7fd8' } });
    this.livreInput.addEventListener('change', () => {
      if (ROOM_COLOR_RE.test(this.livreInput.value.toLowerCase())) void this.mudar({ color: this.livreInput.value });
    });
    this.livre = h('label', { class: 'ui-estilo__cor ui-estilo__cor--livre', title: 'Outra cor: escolha qualquer cor para esta sala', attrs: { 'data-on': 'false' } }, this.livreInput, h('span', { text: 'Outra cor' }));
    paleta.append(this.livre);

    this.inverter = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: 'Inverter os lados', title: 'Troca de lado a ilha de mesas e o canto de reunião', on: { click: () => void this.mudar({ mirror: this.room ? !mirrorOf(this.room) : true }) } });
    this.voltar = h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: 'Voltar ao automático', title: 'Layout, estilo, cor e lado voltam ao que o escritório sorteou', hidden: true, on: { click: () => void this.gravar(this.room?.style?.seats ? { seats: this.room.style.seats } : {}) } });
    this.msg = h('p', { class: 'ui-ask__msg ui-ask__msg--erro', role: 'status', hidden: true });
    this.el = h(
      'div',
      { class: 'ui-estilo' },
      h('p', { class: 'ui-dem__rot', text: 'Layout' }),
      grade,
      h('p', { class: 'ui-dem__rot', text: 'Estilo' }),
      estilos,
      h('p', { class: 'ui-dem__rot', text: 'Cor' }),
      paleta,
      h('div', { class: 'ui-estilo__acoes' }, this.inverter, this.voltar),
      this.msg,
    );
  }

  /** Mostra a escolha de hoje da sala. `office` = o estilo geral do escritório (o que vale no botão "Do escritório"). */
  render(room: RoomInfo, office?: OfficeStyleId, colors?: OfficeColors): void {
    this.room = room;
    const sig = `${room.id}|${room.seed}|${office ?? ''}|${colors?.primary ?? ''}|${colors?.secondary ?? ''}|${JSON.stringify(room.style ?? null)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const layout = layoutOf(room);
    for (const [id, b] of this.layouts) setAttr(b, 'aria-pressed', String(id === layout));
    // As miniaturas dos estilos acompanham a cor de hoje da sala.
    const look = lookOf(room);
    const base = colorTheme(room.seed, room.style?.color);
    for (const [id, b] of this.looks) {
      setAttr(b, 'aria-pressed', String(id === look));
      // a miniatura é a sala como ela ficaria com aquele estilo (o "Do escritório" segue o geral e as cores dele)
      const p = previewOf(styledTheme(room.seed, { ...room.style, look: id === 'auto' ? undefined : id }, office, colors));
      if (id === 'auto') setTitle(b, `${ROOM_LOOK_INFO.auto.dica}. Hoje: ${OFFICE_STYLE_INFO[office ?? 'classico'].nome}`);
      const mini = b.firstElementChild as HTMLElement;
      mini.style.setProperty('--parede', p.parede);
      mini.style.setProperty('--rodape', p.rodape);
      mini.style.setProperty('--piso', p.piso);
      mini.style.setProperty('--mesa', p.mesa);
    }
    const cor = room.style?.color;
    for (const [id, b] of this.cores) setAttr(b, 'aria-pressed', String(id === (cor ?? 'auto')));
    const livre = typeof cor === 'string';
    setAttr(this.livre, 'data-on', String(livre));
    this.livreInput.value = livre ? cor : base.accent;
    this.livre.style.setProperty('--cor', livre ? cor : 'transparent');
    setText(this.livre.lastElementChild!, livre ? 'Sua cor' : 'Outra cor');
    setHidden(this.voltar, !room.style);
    setTitle(this.inverter, mirrorOf(room) ? 'A ilha de mesas está do lado invertido. Clique para voltar' : 'Troca de lado a ilha de mesas e o canto de reunião');
  }

  private mudar(mudanca: Parameters<typeof comEscolha>[1]): Promise<void> {
    return this.room ? this.gravar(comEscolha(this.room.style, mudanca)) : Promise.resolve();
  }

  private async gravar(style: RoomStyle): Promise<void> {
    const room = this.room;
    if (!room || this.ocupado) return;
    this.ocupado = true;
    try {
      await styleRequest(room.id, style);
      setHidden(this.msg, true);
    } catch (err) {
      setText(this.msg, `Não foi possível mudar a sala: ${err instanceof Error ? err.message : 'erro'}.`);
      setHidden(this.msg, false);
    } finally {
      this.ocupado = false;
    }
  }
}
