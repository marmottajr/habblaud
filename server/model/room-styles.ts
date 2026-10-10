// Aparência das salas escolhida pelo usuário (layout dos móveis, estilo, cor, lado), persistida por pasta em
// <dataDir>/room-styles.json, junto com o estilo geral do escritório (Configurações). Sem escolha, a sala usa o que a semente dela sorteia. É só aparência: nada daqui é
// enviado às sessões do Claude Code.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OFFICE_STYLES, parseOfficeColors, parseOfficeStyle, parseRoomStyle, type OfficeColors, type OfficeStyleId, type RoomStyle } from '../../shared/roomstyle';
import { errMsg, log } from '../log';
import { pathKey } from './room-aliases';

const MAX_ROOMS = 400;

export class RoomStyles {
  private styles = new Map<string, RoomStyle>();
  private officeStyle: OfficeStyleId = 'classico';
  /** As cores escolhidas, guardadas por estilo: cada modo tem as suas (trocar de modo traz as dele). */
  private colorsBy: Partial<Record<OfficeStyleId, OfficeColors>> = {};

  /** `file` null = só em memória (testes). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { styles?: Record<string, unknown>; office?: unknown; officeColors?: unknown; officeColorsBy?: unknown };
      this.officeStyle = parseOfficeStyle(j.office);
      const por = (j.officeColorsBy && typeof j.officeColorsBy === 'object' && !Array.isArray(j.officeColorsBy) ? j.officeColorsBy : {}) as Record<string, unknown>;
      for (const estilo of OFFICE_STYLES) {
        const c = parseOfficeColors(por[estilo]);
        if (c.primary || c.secondary) this.colorsBy[estilo] = c;
      }
      // Formato antigo (as cores valiam para qualquer modo): ficam com o modo que estava em uso.
      const antigas = parseOfficeColors(j.officeColors);
      if ((antigas.primary || antigas.secondary) && !this.colorsBy[this.officeStyle]) this.colorsBy[this.officeStyle] = antigas;
      for (const [k, v] of Object.entries(j.styles ?? {}).slice(0, MAX_ROOMS)) {
        const s = parseRoomStyle(v);
        if (s) this.styles.set(pathKey(k), s);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`room-styles.json ilegível (${errMsg(err)}); as salas ficam com a aparência sorteada.`);
    }
  }

  get(path: string): RoomStyle | undefined {
    const s = this.styles.get(pathKey(path));
    return s ? { ...s } : undefined;
  }

  /** O estilo geral do escritório ("classico" enquanto ninguém escolher outro). */
  office(): OfficeStyleId {
    return this.officeStyle;
  }

  /** As cores escolhidas para o estilo em uso (vazio = as de fábrica dele). Cada estilo guarda as suas. */
  colors(): OfficeColors {
    return { ...(this.colorsBy[this.officeStyle] ?? {}) };
  }

  /** Define o estilo geral do escritório; qualquer coisa fora da lista volta ao clássico. Devolve o que ficou. */
  setOffice(raw: unknown): OfficeStyleId {
    this.officeStyle = parseOfficeStyle(raw);
    this.save();
    return this.officeStyle;
  }

  /**
   * Define as cores do estilo em uso (os outros estilos não mudam). Só mexe no campo que veio: "#rrggbb" grava;
   * qualquer outra coisa (null, vazio) apaga aquela cor, e ela volta à do estilo. Devolve as que ficaram.
   */
  setColors(raw: unknown): OfficeColors {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const atuais: OfficeColors = { ...(this.colorsBy[this.officeStyle] ?? {}) };
    for (const campo of ['primary', 'secondary'] as const) {
      if (!(campo in r)) continue;
      const cor = parseOfficeColors({ [campo]: r[campo] })[campo];
      if (cor) atuais[campo] = cor;
      else delete atuais[campo];
    }
    if (atuais.primary || atuais.secondary) this.colorsBy[this.officeStyle] = atuais;
    else delete this.colorsBy[this.officeStyle];
    this.save();
    return this.colors();
  }

  /** Define a aparência da sala da pasta; nada válido volta ao sorteado. Devolve a que ficou. */
  set(path: string, raw: unknown): RoomStyle | undefined {
    const k = pathKey(path);
    const s = parseRoomStyle(raw);
    if (s) {
      // Sala nova depois do limite: a mais antiga sai (Map guarda a ordem de entrada).
      if (!this.styles.has(k) && this.styles.size >= MAX_ROOMS) this.styles.delete(this.styles.keys().next().value as string);
      this.styles.set(k, s);
    } else this.styles.delete(k);
    this.save();
    return this.get(path);
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, office: this.officeStyle, officeColorsBy: this.colorsBy, styles: Object.fromEntries(this.styles) }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(`Não consegui gravar ${this.file}: ${errMsg(err)}`);
    }
  }
}
