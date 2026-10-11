import { describe, expect, it } from 'vitest';
import { effectiveLook, OFFICE_DEFAULT_COLORS, OFFICE_STYLE_INFO, OFFICE_STYLES, officePalette, parseOfficeColors, parseOfficeStyle, ROOM_COLORS, ROOM_LAYOUTS, ROOM_LOOK_INFO, ROOM_LOOKS } from '../../../shared/roomstyle';
import { applyLook, chairFor, colorTheme, isDarkColor, LOOKS, styledTheme, themeFromColor, wallOf } from '../art/roomlook';
import { roomTheme, THEME_COUNT } from '../art/theme';
import { roomVariant } from '../world/layout/room';
import { accentOf, comEscolha, LAYOUT_CHOICES, LAYOUT_ICONS, layoutOf, LOOK_CHOICES, lookOf, mirrorOf, previewOf } from './roomstyle';

describe('personalizar a sala', () => {
  it('cada layout tem o seu ícone, e nenhum repete', () => {
    expect(LAYOUT_CHOICES).toEqual(['auto', ...ROOM_LAYOUTS]);
    const icones = LAYOUT_CHOICES.map((id) => LAYOUT_ICONS[id]);
    for (const svg of icones) expect(svg).toMatch(/^<svg /);
    expect(new Set(icones).size).toBe(LAYOUT_CHOICES.length);
  });

  it('toda cor que a tela oferece existe na paleta das salas', () => {
    expect(ROOM_COLORS).toBe(THEME_COUNT);
  });

  it('o ícone ao lado do nome é o do layout escolhido; sem escolha, o do automático', () => {
    expect(layoutOf({ style: { layout: 'individual' } })).toBe('individual');
    expect(layoutOf({ style: { color: 2 } })).toBe('auto');
    expect(layoutOf({})).toBe('auto');
    expect(layoutOf(null)).toBe('auto');
  });

  it('a cor e o lado: o escolhido, ou o que a semente da sala sorteia', () => {
    expect(accentOf({ seed: 1234 })).toBe(roomTheme(1234).accent);
    expect(accentOf({ seed: 1234, style: { color: 0 } })).toBe(roomTheme(0).accent);
    // Cor livre: ela mesma é o destaque da sala, com qualquer estilo.
    expect(accentOf({ seed: 1234, style: { color: '#12ab9c' } })).toBe('#12ab9c');
    expect(accentOf({ seed: 1234, style: { color: '#12ab9c', look: 'noturno' } })).toBe('#12ab9c');
    expect(mirrorOf({ seed: 77 })).toBe(roomVariant(77).mirror);
    expect(mirrorOf({ seed: 77, style: { mirror: !roomVariant(77).mirror } })).toBe(!roomVariant(77).mirror);
  });

  it('cada escolha mexe só no que foi escolhido; "auto" tira aquele campo', () => {
    expect(comEscolha(undefined, { layout: 'criativo' })).toEqual({ layout: 'criativo' });
    expect(comEscolha({ layout: 'criativo', color: 3 }, { layout: 'auto' })).toEqual({ color: 3 });
    expect(comEscolha({ layout: 'criativo' }, { color: 5 })).toEqual({ layout: 'criativo', color: 5 });
    expect(comEscolha({ layout: 'criativo', color: 5 }, { color: 'auto' })).toEqual({ layout: 'criativo' });
    expect(comEscolha({ color: 5 }, { mirror: true })).toEqual({ color: 5, mirror: true });
    expect(comEscolha({ color: 0 }, { color: 'auto' })).toEqual({});
    // Estilo e cor livre.
    expect(comEscolha({ layout: 'equipe' }, { look: 'moderno' })).toEqual({ layout: 'equipe', look: 'moderno' });
    expect(comEscolha({ look: 'moderno', color: 2 }, { look: 'auto' })).toEqual({ color: 2 });
    expect(comEscolha({ look: 'moderno' }, { color: '#AABBCC' })).toEqual({ look: 'moderno', color: '#aabbcc' });
  });

  it('estilos: cada um tem nome, e a miniatura mostra a parede, o rodapé, o piso e a mesa dele', () => {
    expect(LOOK_CHOICES).toEqual(['auto', ...ROOM_LOOKS]);
    for (const id of LOOK_CHOICES) expect(ROOM_LOOK_INFO[id].nome.length).toBeGreaterThan(3);
    expect(lookOf({ style: { look: 'vidro' } })).toBe('vidro');
    expect(lookOf({})).toBe('auto');
    const base = roomTheme(0);
    const minis = ROOM_LOOKS.map((id) => JSON.stringify(previewOf(applyLook(base, id))));
    expect(new Set(minis).size).toBe(ROOM_LOOKS.length);
    for (const cor of Object.values(previewOf(applyLook(base, 'noturno')))) expect(cor).toMatch(/^#[0-9a-f]{6}$/);
    // Sem estilo: o piso é o porcelanato de sempre.
    expect(previewOf(base).piso).toBe('#e7e8ea');
  });

  it('o estilo troca piso, parede e móveis, e mantém a cor da sala como destaque', () => {
    const base = roomTheme(4);
    const moderno = applyLook(base, 'moderno');
    expect(moderno).toMatchObject({ floor: 'concrete', deskVariant: 'white', chairVariant: 'black', accent: base.accent, wall: { pattern: 'plain' } });
    expect(applyLook(base, 'industrial')).toMatchObject({ floor: 'concrete', wall: { pattern: 'brick' }, deskVariant: 'dark' });
    expect(applyLook(base, 'executivo')).toMatchObject({ floor: 'wood', wall: { pattern: 'wood_panel' } });
    expect(applyLook(base, 'vidro')).toMatchObject({ floor: 'marble', wall: { pattern: 'glass' } });
    expect(applyLook(base, 'noturno')).toMatchObject({ floor: 'carpet', deskVariant: 'black' });
    expect(applyLook(base, 'noturno').floorColor).toMatch(/^#[0-9a-f]{6}$/);
    // O aconchegante não fixa a cadeira: fica a que combina com a cor.
    expect(LOOKS.aconchegante.chair).toBeUndefined();
    expect(applyLook(base, 'aconchegante').chairVariant).toBe(base.chairVariant);
    // Sem estilo, o tema não muda.
    expect(applyLook(base, undefined)).toBe(base);
    expect(styledTheme(4, undefined)).toEqual(base);
    // Sala com cor própria num estilo geral: a cor dela manda nos tapetes e no friso da sala.
    expect(styledTheme(999, { color: 4, look: 'moderno' })).toMatchObject({ floor: 'concrete', accent: base.accent, carpet: base.accent, wall: { trim: base.accent } });
  });

  it('cor livre: os tons da sala saem dela, e a cadeira é a de cor mais próxima', () => {
    const t = themeFromColor('#E2604F');
    expect(t.accent).toBe('#e2604f');
    for (const cor of [t.carpet, t.carpet2, t.wall.base, t.wall.trim]) expect(cor).toMatch(/^#[0-9a-f]{6}$/);
    expect(chairFor('#e2604f')).toBe('red');
    expect(chairFor('#2f8f4e')).toBe('green');
    expect(chairFor('#3f7fd8')).toBe('blue');
    expect(chairFor('#8a8f98')).toBe('gray');
    expect(chairFor('#1c1f26')).toBe('black');
    expect(colorTheme(7, '#3f7fd8').accent).toBe('#3f7fd8');
    expect(colorTheme(7, 3)).toEqual(roomTheme(3));
    expect(colorTheme(7, undefined)).toEqual(roomTheme(7));
    // Texto que não é cor não vira tema: vale o da sala.
    expect(colorTheme(7, 'vermelho')).toEqual(roomTheme(7));
  });

  it('estilo geral do escritório: vale na sala que não escolheu o seu; o clássico não muda nada', () => {
    expect(OFFICE_STYLES).toEqual(['classico', 'corporativo', 'moderno', 'futurista']);
    for (const id of OFFICE_STYLES) expect(OFFICE_STYLE_INFO[id].nome.length).toBeGreaterThan(5);
    expect(parseOfficeStyle('futurista')).toBe('futurista');
    for (const lixo of [undefined, null, 'barroco', 3, {}]) expect(parseOfficeStyle(lixo)).toBe('classico');
    // As duas cores do escritório: as escolhidas, ou as do estilo; no clássico, só as escolhidas.
    expect(parseOfficeColors({ primary: '#AA3355', secondary: 'azul', extra: 1 })).toEqual({ primary: '#aa3355' });
    expect(parseOfficeColors(null)).toEqual({});
    expect(officePalette('moderno', undefined)).toEqual(OFFICE_DEFAULT_COLORS.moderno);
    expect(officePalette('moderno', { secondary: '#33aa77' })).toEqual({ primary: OFFICE_DEFAULT_COLORS.moderno.primary, secondary: '#33aa77' });
    expect(officePalette('classico', undefined)).toEqual({ primary: undefined, secondary: undefined });
    expect(effectiveLook(undefined, 'corporativo')).toBe('corporativo');
    expect(effectiveLook({}, 'classico')).toBeUndefined();
    expect(effectiveLook({}, undefined)).toBeUndefined();
    // A escolha da sala vale por cima do geral, inclusive "Clássico" num escritório corporativo.
    expect(effectiveLook({ look: 'vidro' }, 'corporativo')).toBe('vidro');
    expect(effectiveLook({ look: 'classico' }, 'corporativo')).toBe('classico');
    const base = roomTheme(3);
    expect(styledTheme(3, undefined, 'classico')).toEqual(base);
    expect(styledTheme(3, undefined, 'corporativo')).toEqual(applyLook(base, 'corporativo'));
    expect(styledTheme(3, { look: 'classico' }, 'corporativo')).toEqual(base);
    expect(styledTheme(3, { look: 'moderno' }, 'futurista')).toEqual(applyLook(base, 'moderno'));
  });

  it('Corporativo e Futurista: o primeiro é formal, de carpete e móveis escuros; o segundo é escuro com friso na cor da sala', () => {
    const base = roomTheme(0);
    const corp = applyLook(base, 'corporativo');
    expect(corp).toMatchObject({ floor: 'carpet', formal: true, deskVariant: 'dark', chairVariant: 'black', wall: { pattern: 'plain' }, accent: base.accent });
    expect(styledTheme(0, { look: 'corporativo', color: '#000000' }).deskVariant).toBe('black');
    expect(applyLook(base, 'executivo').formal).toBe(true);
    expect(applyLook(base, 'moderno').formal).toBeUndefined();
    const fut = applyLook(base, 'futurista');
    expect(fut).toMatchObject({ floor: 'carpet', deskVariant: 'white', chairVariant: 'blue', wall: { pattern: 'tiles' } });
    expect(fut.formal).toBeUndefined();
    // Harmonia: num estilo geral, de fábrica, toda sala usa os mesmos tons (tapetes, friso, parede, piso), seja
    // qual for a cor sorteada dela.
    for (const estilo of ['corporativo', 'moderno', 'futurista'] as const) {
      const [x, y] = [applyLook(roomTheme(1), estilo), applyLook(roomTheme(7), estilo)];
      expect([x.carpet, x.carpet2, x.wall.trim, x.wall.base, x.floor, x.floorColor], estilo).toEqual([y.carpet, y.carpet2, y.wall.trim, y.wall.base, y.floor, y.floorColor]);
      expect(x.carpet).not.toBe(x.carpet2);
    }
    // "Clássico" escolhido na sala é o tema de sempre.
    expect(applyLook(base, 'classico')).toBe(base);
  });

  it('as cores do escritório são respeitadas como escolhidas: a principal no piso e nas paredes, a de apoio nos tapetes e frisos', () => {
    for (const estilo of ['classico', 'corporativo', 'moderno', 'futurista'] as const) {
      // Preto nas duas: piso preto, tapetes pretos, friso preto, parede quase preta, sem clarear nada.
      const t = styledTheme(1, undefined, estilo, { primary: '#000000', secondary: '#000000' });
      expect(t, estilo).toMatchObject({ floor: 'carpet', floorColor: '#000000', carpet: '#000000', carpet2: '#000000' });
      expect(t.wall.trim, estilo).toBe('#000000');
      expect(t.wall.base, estilo).toBe(wallOf('#000000'));
      expect(isDarkColor(t.wall.base), estilo).toBe(true);
      // Duas cores quaisquer: as mesmas em toda sala, exatamente as escolhidas.
      const u = styledTheme(1, undefined, estilo, { primary: '#aa3355', secondary: '#33aa77' });
      expect(u, estilo).toMatchObject({ floor: 'carpet', floorColor: '#aa3355', carpet: '#33aa77', wall: { base: wallOf('#aa3355'), trim: '#33aa77' } });
      expect(styledTheme(7, undefined, estilo, { primary: '#aa3355', secondary: '#33aa77' })).toMatchObject({ floorColor: u.floorColor, carpet: u.carpet, wall: u.wall });
    }
    // Só a de apoio: o piso e as paredes continuam os do estilo. Só a principal: os tapetes continuam os do estilo.
    const corp = applyLook(roomTheme(1), 'corporativo');
    expect(styledTheme(1, undefined, 'corporativo', { secondary: '#33aa77' })).toMatchObject({ carpet: '#33aa77', floorColor: corp.floorColor, wall: { base: corp.wall.base, trim: '#33aa77' } });
    expect(styledTheme(1, undefined, 'corporativo', { primary: '#aa3355' })).toMatchObject({ carpet: corp.carpet, carpet2: corp.carpet2, floorColor: '#aa3355' });
    // Sem cores escolhidas, o clássico é o de sempre.
    expect(styledTheme(1, undefined, 'classico', {})).toEqual(roomTheme(1));
    // A cor escolhida para uma sala manda nos tapetes dela; o piso e as paredes seguem o escritório.
    expect(styledTheme(1, { color: '#ff8800' }, 'corporativo', { primary: '#000000', secondary: '#33aa77' })).toMatchObject({ carpet: '#ff8800', floorColor: '#000000', wall: { trim: '#ff8800' } });
    expect(styledTheme(1, { color: '#000000' }, 'corporativo').carpet).toBe('#000000');
    // Piso escuro pede móveis escuros, nos estilos que têm a mesa preta e no clássico; o Futurista mantém a branca.
    expect(styledTheme(1, undefined, 'corporativo', { primary: '#000000' })).toMatchObject({ deskVariant: 'black', chairVariant: 'black' });
    expect(styledTheme(1, undefined, 'classico', { primary: '#000000' })).toMatchObject({ deskVariant: 'black', chairVariant: 'black' });
    expect(styledTheme(1, undefined, 'futurista', { primary: '#000000' }).deskVariant).toBe('white');
    expect(styledTheme(1, undefined, 'corporativo', { primary: '#e8e8e8' }).deskVariant).toBe('dark');
  });

  it('cor escura pede móveis escuros: mesa preta e cadeiras pretas, também no estilo Moderno', () => {
    for (const cor of ['#000000', '#1c1f26', '#14213d']) expect(isDarkColor(cor), cor).toBe(true);
    for (const cor of ['#3f7fd8', '#e2604f', '#f2c14e', '#ffffff', '#8a8f98']) expect(isDarkColor(cor), cor).toBe(false);
    expect(themeFromColor('#000000')).toMatchObject({ deskVariant: 'black', chairVariant: 'black' });
    expect(themeFromColor('#14213d')).toMatchObject({ deskVariant: 'black', chairVariant: 'black' });
    expect(themeFromColor('#3f7fd8')).toMatchObject({ deskVariant: 'white', chairVariant: 'blue' });
    // Moderno: mesas brancas, menos quando a cor da sala é escura.
    expect(styledTheme(1, { look: 'moderno', color: '#000000' })).toMatchObject({ deskVariant: 'black', chairVariant: 'black', floor: 'concrete' });
    expect(styledTheme(1, { look: 'moderno', color: '#3f7fd8' })).toMatchObject({ deskVariant: 'white', chairVariant: 'black' });
    // Os outros estilos mantêm a mesa deles.
    expect(styledTheme(1, { look: 'minimalista', color: '#000000' }).deskVariant).toBe('white');
    expect(styledTheme(1, { look: 'executivo', color: '#000000' }).deskVariant).toBe('dark');
  });
});
