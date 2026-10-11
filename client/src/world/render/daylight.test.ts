// Ciclo dia/noite (puro): fases, nível de luz e cores por hora e minuto, virada da meia-noite,
// faixas de sol, hora efetiva e leitura do ?hora= da URL.
import { describe, expect, it } from 'vitest';
import {
  ambientAt,
  ambientDistance,
  approachAmbient,
  daylightModeOf,
  effectiveHour,
  FIXED_DAY_HOUR,
  FIXED_NIGHT_HOUR,
  isNeutral,
  mixRgb,
  parseHourParam,
  phaseOf,
  sunbeamAt,
  wrapHour,
} from './daylight';

const lum = (c: readonly [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('fases do dia', () => {
  it('madrugada, amanhecer, dia, entardecer e noite pelos limites', () => {
    expect(phaseOf(0)).toBe('madrugada');
    expect(phaseOf(4 + 59 / 60)).toBe('madrugada');
    expect(phaseOf(5)).toBe('amanhecer');
    expect(phaseOf(6.5)).toBe('amanhecer');
    expect(phaseOf(7)).toBe('dia');
    expect(phaseOf(16.99)).toBe('dia');
    expect(phaseOf(17)).toBe('entardecer');
    expect(phaseOf(18 + 59 / 60)).toBe('entardecer');
    expect(phaseOf(19)).toBe('noite');
    expect(phaseOf(23.99)).toBe('noite');
  });

  it('normaliza horas fora de 0–24 (inclusive negativas)', () => {
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(25.5)).toBe(1.5);
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(Number.NaN)).toBe(0);
    expect(phaseOf(-0.5)).toBe('noite');
    expect(phaseOf(28)).toBe('madrugada');
  });
});

describe('nível de luz e cores', () => {
  it('meio-dia é neutro (nada a desenhar); a noite é escura e azulada', () => {
    const noon = ambientAt(12);
    expect(noon.night).toBe(0);
    expect(noon.outside).toEqual([255, 255, 255]);
    expect(noon.inside).toEqual([255, 255, 255]);
    expect(isNeutral(noon)).toBe(true);
    const late = ambientAt(22.5);
    expect(late.night).toBe(1);
    expect(isNeutral(late)).toBe(false);
    expect(lum(late.outside)).toBeLessThan(110);
    // azulado: o azul domina o vermelho no exterior noturno
    expect(late.outside[2]).toBeGreaterThan(late.outside[0] + 40);
    // interiores acesos continuam claros (e quentes: o vermelho domina o azul)
    expect(lum(late.inside)).toBeGreaterThan(200);
    expect(late.inside[0]).toBeGreaterThan(late.inside[2]);
    // áreas comuns vazias ficam na penumbra, entre a sala acesa e o exterior
    expect(lum(late.dim)).toBeLessThan(lum(late.inside));
    expect(lum(late.dim)).toBeGreaterThan(lum(late.outside));
  });

  it('tom "branca" (estilos Corporativo, Moderno e Futurista): noite azul-marinho escuro e luz branca; o dia e o entardecer são os mesmos', () => {
    const quente = ambientAt(22.5);
    const branca = ambientAt(22.5, 'branca');
    // mais escuro e ainda azul do lado de fora
    expect(lum(branca.outside)).toBeLessThan(70);
    expect(lum(branca.outside)).toBeLessThan(lum(quente.outside));
    expect(branca.outside[2]).toBeGreaterThan(branca.outside[0] + 40);
    // luz branca nas salas acesas: nada de amarelado (o vermelho não passa do azul)
    expect(lum(branca.inside)).toBeGreaterThan(240);
    expect(branca.inside[0]).toBeLessThanOrEqual(branca.inside[2]);
    expect(quente.inside[0]).toBeGreaterThan(quente.inside[2]);
    // penumbra das áreas vazias entre a sala acesa e o exterior, mais fechada que na luz quente
    expect(lum(branca.dim)).toBeGreaterThan(lum(branca.outside));
    expect(lum(branca.dim)).toBeLessThan(lum(quente.dim));
    // de dia nada muda, e o dourado do sol baixo no céu do entardecer é o mesmo nos dois tons
    for (const h of [9, 12, 15]) expect(ambientAt(h, 'branca'), `${h}h`).toEqual(ambientAt(h));
    for (const h of [17.5, 18]) {
      expect(ambientAt(h, 'branca').outside, `${h}h`).toEqual(ambientAt(h).outside);
      expect(ambientAt(h, 'branca').warm, `${h}h`).toBe(ambientAt(h).warm);
    }
    // o padrão é o tom de sempre
    expect(ambientAt(22.5, 'quente')).toEqual(quente);
  });

  it('amanhecer e entardecer têm tom quente', () => {
    for (const h of [6.5, 18]) {
      const a = ambientAt(h);
      expect(a.warm).toBeGreaterThan(0.9);
      expect(a.outside[0]).toBeGreaterThan(a.outside[2] + 60);
    }
    expect(ambientAt(12).warm).toBe(0);
    expect(ambientAt(23).warm).toBe(0);
  });

  it('interpola por minuto: a noite cresce de forma contínua no entardecer', () => {
    let prev = ambientAt(17).night;
    for (let m = 1; m <= 180; m++) {
      const a = ambientAt(17 + m / 60);
      expect(a.night).toBeGreaterThanOrEqual(prev - 1e-9);
      // sem saltos entre minutos vizinhos
      expect(a.night - prev).toBeLessThan(0.02);
      prev = a.night;
    }
    expect(prev).toBe(1);
    // meio caminho entre duas chaves: valores intermediários
    const mid = ambientAt(18.3);
    expect(mid.night).toBeGreaterThan(ambientAt(18).night);
    expect(mid.night).toBeLessThan(ambientAt(18.6).night);
  });

  it('o amanhecer clareia a cada minuto', () => {
    let prev = ambientAt(5).night;
    for (let m = 1; m <= 180; m++) {
      const a = ambientAt(5 + m / 60);
      expect(a.night).toBeLessThanOrEqual(prev + 1e-9);
      prev = a.night;
    }
    expect(prev).toBe(0);
  });

  it('a virada da meia-noite é contínua', () => {
    const before = ambientAt(23 + 59 / 60);
    const after = ambientAt(0);
    const next = ambientAt(1 / 60);
    expect(ambientDistance(before, after)).toBeLessThan(3);
    expect(ambientDistance(after, next)).toBeLessThan(3);
    expect(ambientAt(24)).toEqual(ambientAt(0));
    // a madrugada é um pouco mais fechada que o começo da noite
    expect(lum(ambientAt(2).outside)).toBeLessThan(lum(ambientAt(20).outside));
  });

  it('mistura de cores e transição suave entre ambientes', () => {
    expect(mixRgb([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(mixRgb([10, 20, 30], [200, 200, 200], -1)).toEqual([10, 20, 30]);
    expect(mixRgb([10, 20, 30], [200, 200, 200], 2)).toEqual([200, 200, 200]);
    const day = ambientAt(12);
    const night = ambientAt(23);
    const half = approachAmbient(day, night, 0.5);
    expect(half.night).toBeCloseTo(0.5);
    expect(ambientDistance(half, night)).toBeLessThan(ambientDistance(day, night));
    expect(approachAmbient(day, night, 1)).toBe(night);
  });
});

describe('sol pelas janelas', () => {
  it('só de dia; curto ao meio-dia, longo com o sol baixo', () => {
    expect(sunbeamAt(3)).toBeNull();
    expect(sunbeamAt(6)).toBeNull();
    expect(sunbeamAt(21)).toBeNull();
    const noon = sunbeamAt(12)!;
    const late = sunbeamAt(17.5)!;
    expect(late.len).toBeGreaterThan(noon.len);
    expect(Math.abs(noon.skew)).toBeLessThan(0.05);
  });

  it('de manhã tomba para oeste, à tarde para leste; mais forte nas horas douradas', () => {
    expect(sunbeamAt(8)!.skew).toBeLessThan(0);
    expect(sunbeamAt(16)!.skew).toBeGreaterThan(0);
    expect(sunbeamAt(17.2)!.alpha).toBeGreaterThan(sunbeamAt(12)!.alpha);
    // aparece e some suave perto do nascer/pôr
    expect(sunbeamAt(6.2)!.alpha).toBeLessThan(sunbeamAt(7.2)!.alpha);
  });
});

describe('hora efetiva e parâmetro ?hora=', () => {
  const date = new Date(2026, 9, 8, 14, 45, 0);

  it('lê os formatos aceitos', () => {
    expect(parseHourParam('?hora=21:30')).toBe(21.5);
    expect(parseHourParam('?hora=6:05')).toBeCloseTo(6 + 5 / 60);
    expect(parseHourParam('?hora=06:00')).toBe(6);
    expect(parseHourParam('?hora=21h30')).toBe(21.5);
    expect(parseHourParam('?hora=21h')).toBe(21);
    expect(parseHourParam('?hora=18')).toBe(18);
    expect(parseHourParam('?mock=1&hora=22%3A30')).toBe(22.5);
    expect(parseHourParam('?hora=24:00')).toBe(0);
  });

  it('ignora ausente ou inválido', () => {
    expect(parseHourParam('')).toBeNull();
    expect(parseHourParam(null)).toBeNull();
    expect(parseHourParam('?mock=1')).toBeNull();
    expect(parseHourParam('?hora=')).toBeNull();
    expect(parseHourParam('?hora=25:00')).toBeNull();
    expect(parseHourParam('?hora=12:60')).toBeNull();
    expect(parseHourParam('?hora=24:30')).toBeNull();
    expect(parseHourParam('?hora=meio-dia')).toBeNull();
    expect(parseHourParam('?hora=-3')).toBeNull();
  });

  it('a hora forçada vale sobre a preferência; senão a preferência; senão o relógio', () => {
    expect(effectiveHour('auto', null, date)).toBeCloseTo(14.75);
    expect(effectiveHour('day', null, date)).toBe(FIXED_DAY_HOUR);
    expect(effectiveHour('night', null, date)).toBe(FIXED_NIGHT_HOUR);
    expect(effectiveHour('day', 21.5, date)).toBe(21.5);
    expect(effectiveHour('auto', 26, date)).toBe(2);
    expect(ambientAt(FIXED_NIGHT_HOUR).night).toBe(1);
    expect(isNeutral(ambientAt(FIXED_DAY_HOUR))).toBe(true);
  });

  it('modo a partir das opções do mundo (o interruptor antigo ainda vale)', () => {
    expect(daylightModeOf({ dayNight: true })).toBe('auto');
    expect(daylightModeOf({ dayNight: false })).toBe('day');
    expect(daylightModeOf({ dayNight: false, daylight: 'night' })).toBe('night');
    expect(daylightModeOf({ dayNight: true, daylight: 'day' })).toBe('day');
  });
});
