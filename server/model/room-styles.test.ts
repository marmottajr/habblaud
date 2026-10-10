// Aparência das salas: o que a pessoa escolhe (layout, cor, lado) fica guardado por pasta e chega à tela.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRoomStyle, parseSeats, ROOM_LAYOUT_INFO, ROOM_LAYOUTS, roomStyleKey, seatsKey } from '../../shared/roomstyle';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { JobStore } from './jobs';
import { NameStore } from './names';
import { Office } from './office';
import { RoomStyles } from './room-styles';

setQuiet(true);

describe('aparência das salas', () => {
  it('só o que é válido fica; nada escolhido é "sem aparência"', () => {
    expect(parseRoomStyle({ layout: 'criativo', mirror: true, color: 3 })).toEqual({ layout: 'criativo', mirror: true, color: 3 });
    expect(parseRoomStyle({ layout: 'castelo', mirror: 'sim', color: 99 })).toBeUndefined();
    expect(parseRoomStyle({ layout: 'individual', color: -1, extra: 'x' })).toEqual({ layout: 'individual' });
    expect(parseRoomStyle({ color: 1.5 })).toBeUndefined();
    expect(parseRoomStyle({ mirror: false })).toEqual({ mirror: false });
    // Estilo e cor livre (só "#rrggbb"; maiúsculas viram minúsculas).
    expect(parseRoomStyle({ look: 'moderno', color: '#3F7FD8' })).toEqual({ look: 'moderno', color: '#3f7fd8' });
    expect(parseRoomStyle({ look: 'barroco', color: 'red' })).toBeUndefined();
    expect(parseRoomStyle({ color: '#12345' })).toBeUndefined();
    expect(parseRoomStyle({ color: 'url(javascript:alert(1))' })).toBeUndefined();
    expect(roomStyleKey({ look: 'moderno' })).not.toBe(roomStyleKey({ look: 'vidro' }));
    expect(roomStyleKey({ color: '#3f7fd8' })).not.toBe(roomStyleKey({ color: '#3f7fd9' }));
    for (const lixo of [null, undefined, 'equipe', 3, [], {}]) expect(parseRoomStyle(lixo)).toBeUndefined();
    // A tela refaz a sala quando este texto muda.
    expect(roomStyleKey(undefined)).toBe('');
    expect(roomStyleKey({ layout: 'equipe' })).not.toBe(roomStyleKey({ layout: 'criativo' }));
    expect(roomStyleKey({ mirror: false })).not.toBe(roomStyleKey({ mirror: true }));
    expect(roomStyleKey({ color: 0 })).not.toBe(roomStyleKey(undefined));
  });

  it('todo layout tem nome', () => {
    for (const id of ['auto', ...ROOM_LAYOUTS] as const) expect(ROOM_LAYOUT_INFO[id].nome.length).toBeGreaterThan(2);
  });

  it('guarda por pasta, sobrevive a reiniciar e volta ao sorteado quando a escolha é apagada', () => {
    const tmp = tempDir();
    try {
      const arquivo = join(tmp.dir, 'room-styles.json');
      const a = new RoomStyles(arquivo);
      a.load();
      expect(a.get('/p/vendas')).toBeUndefined();
      expect(a.set('/p/vendas', { layout: 'operacao', color: 4, lixo: 1 })).toEqual({ layout: 'operacao', color: 4 });
      // A mesma pasta, escrita de outro jeito.
      expect(a.get('/P/Vendas/')).toEqual({ layout: 'operacao', color: 4 });
      const b = new RoomStyles(arquivo);
      b.load();
      expect(b.get('/p/vendas')).toEqual({ layout: 'operacao', color: 4 });
      expect(b.set('/p/vendas', {})).toBeUndefined();
      expect(JSON.parse(readFileSync(arquivo, 'utf8')).styles).toEqual({});
      // Arquivo estragado não derruba nada.
      writeFileSync(arquivo, '{isto não é json');
      const c = new RoomStyles(arquivo);
      c.load();
      expect(c.get('/p/vendas')).toBeUndefined();
      expect(existsSync(arquivo)).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it('estilo geral do escritório: clássico até alguém escolher; fica guardado; valor estranho volta ao clássico', () => {
    const tmp = tempDir();
    try {
      const arquivo = join(tmp.dir, 'room-styles.json');
      const a = new RoomStyles(arquivo);
      a.load();
      expect(a.office()).toBe('classico');
      expect(a.setOffice('corporativo')).toBe('corporativo');
      a.set('/p/vendas', { look: 'vidro' });
      const b = new RoomStyles(arquivo);
      b.load();
      expect(b.office()).toBe('corporativo');
      expect(b.get('/p/vendas')).toEqual({ look: 'vidro' });
      expect(b.setOffice('rococó')).toBe('classico');
      expect(JSON.parse(readFileSync(arquivo, 'utf8')).office).toBe('classico');
      // As cores do escritório: só mexe no campo que veio; cor que não é "#rrggbb" apaga aquela.
      expect(b.colors()).toEqual({});
      expect(b.setColors({ primary: '#AA3355' })).toEqual({ primary: '#aa3355' });
      expect(b.setColors({ secondary: '#33aa77' })).toEqual({ primary: '#aa3355', secondary: '#33aa77' });
      expect(b.setColors({ primary: 'url(x)' })).toEqual({ secondary: '#33aa77' });
      const c = new RoomStyles(arquivo);
      c.load();
      expect(c.colors()).toEqual({ secondary: '#33aa77' });
      // Cada estilo guarda as suas cores: trocar de estilo traz as dele, e voltar devolve as de antes.
      c.setOffice('corporativo');
      expect(c.colors()).toEqual({});
      expect(c.setColors({ primary: '#232323', secondary: '#232323' })).toEqual({ primary: '#232323', secondary: '#232323' });
      c.setOffice('classico');
      expect(c.colors()).toEqual({ secondary: '#33aa77' });
      c.setOffice('futurista');
      expect(c.colors()).toEqual({});
      const d = new RoomStyles(arquivo);
      d.load();
      d.setOffice('corporativo');
      expect(d.colors()).toEqual({ primary: '#232323', secondary: '#232323' });
      d.setOffice('classico');
      expect(d.setColors({ secondary: null })).toEqual({});
      d.setOffice('corporativo');
      expect(d.colors()).toEqual({ primary: '#232323', secondary: '#232323' });
      // Arquivo no formato antigo (cores valendo para qualquer modo): ficam com o modo que estava em uso.
      writeFileSync(arquivo, JSON.stringify({ version: 1, office: 'moderno', officeColors: { primary: '#101010' }, styles: {} }));
      const antigo = new RoomStyles(arquivo);
      antigo.load();
      expect(antigo.colors()).toEqual({ primary: '#101010' });
      antigo.setOffice('classico');
      expect(antigo.colors()).toEqual({});
      // O servidor manda o estilo geral para a tela.
      const office = new Office({ names: new NameStore(null), jobs: new JobStore(null), officeStyle: () => a.office(), version: '9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
      expect(office.commit().snapshot.meta.officeStyle).toBe('corporativo');
      // As cores só vão para a tela quando alguém escolheu.
      expect(office.commit().snapshot.meta.officeColors).toBeUndefined();
      const comCores = new Office({ names: new NameStore(null), jobs: new JobStore(null), officeStyle: () => 'moderno', officeColors: () => ({ primary: '#aa3355' }), version: '9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
      expect(comCores.commit().snapshot.meta).toMatchObject({ officeStyle: 'moderno', officeColors: { primary: '#aa3355' } });
    } finally {
      tmp.cleanup();
    }
  });

  it('a sala leva a aparência para a tela; a sala do dono, sem escolha, é a de uma pessoa só', () => {
    const estilos = new RoomStyles(null);
    const equipes = new Map([
      ['/p/mkt', { nome: 'Marketing', nomeProprio: true, sala: true, agentes: [] }],
      ['/p/dono', { nome: 'Sala do dono', nomeProprio: true, sala: true, escritorio: true, agentes: [{ slug: 'dono', funcao: 'Dono' }] }],
    ]);
    const office = new Office({ names: new NameStore(null), jobs: new JobStore(null), equipe: () => equipes, roomStyle: (path) => estilos.get(path), version: '9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
    office.syncEquipe();
    const sala = (id: string) => office.commit().snapshot.rooms.find((r) => r.id === id);
    expect(sala('/p/mkt')?.style).toBeUndefined();
    expect(sala('/p/dono')?.style).toEqual({ layout: 'individual' });
    estilos.set(office.roomPath('/p/mkt')!, { layout: 'reunioes', mirror: true });
    estilos.set(office.roomPath('/p/dono')!, { layout: 'criativo', color: 2 });
    office.markDirty();
    expect(sala('/p/mkt')?.style).toEqual({ layout: 'reunioes', mirror: true });
    // A escolha da pessoa vale por cima do padrão da sala do dono.
    expect(sala('/p/dono')?.style).toEqual({ layout: 'criativo', color: 2 });
  });
  it('mesas marcadas: agente válido, mesa de 1 a 12, uma mesa por agente; não mexem no desenho da sala', () => {
    expect(parseSeats({ cmo: 2, cto: 1 })).toEqual({ cmo: 2, cto: 1 });
    // Mesa repetida fica com o primeiro; nome estranho, mesa fora de 1 a 12 e número quebrado caem.
    expect(parseSeats({ cmo: 2, cto: 2, 'A B': 3, cfo: 0, coo: 13, ceo: 1.5, dev: '4' })).toEqual({ cmo: 2 });
    for (const lixo of [null, undefined, 'cmo', 3, [], {}]) expect(parseSeats(lixo)).toBeUndefined();
    expect(parseRoomStyle({ seats: { cmo: 2 } })).toEqual({ seats: { cmo: 2 } });
    expect(parseRoomStyle({ layout: 'diretoria', seats: { cmo: 9, x: 1 } })).toEqual({ layout: 'diretoria', seats: { cmo: 9 } });
    // A sala só é refeita quando o desenho muda; trocar de mesa não refaz a sala.
    expect(roomStyleKey({ layout: 'equipe', seats: { cmo: 1 } })).toBe(roomStyleKey({ layout: 'equipe', seats: { cmo: 2 } }));
    expect(seatsKey({ seats: { cmo: 1, cto: 2 } })).toBe(seatsKey({ seats: { cto: 2, cmo: 1 } }));
    expect(seatsKey({ seats: { cmo: 1 } })).not.toBe(seatsKey({ seats: { cmo: 2 } }));
    expect(seatsKey(undefined)).toBe('');
  });

  it('a tela só recebe mesa marcada de agente que existe na equipe da sala', () => {
    const estilos = new RoomStyles(null);
    const equipes = new Map([['/p/dir', { nome: 'Diretoria', nomeProprio: true, agentes: [{ slug: 'cmo', funcao: 'CMO' }, { slug: 'cto', funcao: 'CTO' }] }]]);
    const office = new Office({ names: new NameStore(null), jobs: new JobStore(null), equipe: () => equipes, roomStyle: (path) => estilos.get(path), version: '9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
    office.syncEquipe();
    const sala = () => office.commit().snapshot.rooms.find((r) => r.id === '/p/dir');
    estilos.set(office.roomPath('/p/dir')!, { layout: 'diretoria', seats: { cmo: 3, apagado: 1, cto: 4 } });
    office.markDirty();
    expect(sala()?.style).toEqual({ layout: 'diretoria', seats: { cmo: 3, cto: 4 } });
    // O que ficou guardado não muda: se o agente voltar com o mesmo nome, a mesa dele continua marcada.
    expect(estilos.get(office.roomPath('/p/dir')!)?.seats).toEqual({ cmo: 3, apagado: 1, cto: 4 });
    estilos.set(office.roomPath('/p/dir')!, { seats: { apagado: 1 } });
    office.markDirty();
    expect(sala()?.style).toBeUndefined();
  });
});
