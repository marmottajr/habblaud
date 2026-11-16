import { describe, expect, it } from 'vitest';
import {
  autoAdvanceMs,
  folderSlug,
  imageSources,
  joinHostPath,
  parseBlocks,
  parseInline,
  parseSlides,
  presentationRequestText,
  presentationStamp,
  presentationTitle,
  roomFolder,
  safeHref,
  splitSlides,
} from './presentation';

describe('pastas das apresentações', () => {
  it('folderSlug: sem acentos, minúsculo, só letras, números e hífens', () => {
    expect(folderSlug('Habblaud — Projeto Ação!')).toBe('habblaud-projeto-acao');
    expect(folderSlug('***')).toBe('');
  });

  it('roomFolder: nome do projeto + hash do id (estável; mesmo nome em outro lugar é outra pasta)', () => {
    const a = roomFolder('c:/users/reis/habblaud');
    expect(a).toMatch(/^habblaud-[0-9a-z]{6}$/);
    expect(roomFolder('c:/users/reis/habblaud')).toBe(a);
    expect(roomFolder('c:/outro/habblaud')).not.toBe(a);
    expect(roomFolder('/')).toMatch(/^sala-/);
  });

  it('joinHostPath usa o separador do computador do usuário', () => {
    expect(joinHostPath('C:\\Users\\Reis\\.habblaud\\apresentacoes', 'sala', 'slides.md')).toBe('C:\\Users\\Reis\\.habblaud\\apresentacoes\\sala\\slides.md');
    expect(joinHostPath('/home/ana/.habblaud/apresentacoes/', 'sala')).toBe('/home/ana/.habblaud/apresentacoes/sala');
  });

  it('presentationStamp: data e hora locais', () => {
    expect(presentationStamp(new Date(2026, 10, 16, 9, 5).getTime())).toBe('2026-11-16-0905');
  });

  it('o pedido leva o roteiro, as regras e o caminho exato do arquivo', () => {
    const text = presentationRequestText('/home/ana/.habblaud/apresentacoes/loja-abc123', new Date(2026, 10, 16, 14, 32).getTime());
    expect(text).toContain('/home/ana/.habblaud/apresentacoes/loja-abc123/2026-11-16-1432-<titulo-curto>/slides.md');
    expect(text).toContain('Próximos passos');
    expect(text).toContain('---');
  });
});

describe('slides', () => {
  it('separa por "---", mas não dentro de blocos de código, e pula slides vazios', () => {
    const md = '---\n# Título\n\ntexto\n---\n## Dois\n```yaml\na: 1\n---\nb: 2\n```\n---\n\n---\n## Três';
    const slides = splitSlides(md);
    expect(slides).toHaveLength(3);
    expect(slides[1]).toContain('b: 2');
  });

  it('título: o primeiro "#", senão o primeiro título qualquer', () => {
    expect(presentationTitle('## Antes\n# **Login** novo\n')).toBe('Login novo');
    expect(presentationTitle('texto\n## Só este')).toBe('Só este');
    expect(presentationTitle('```\n# não\n```\nnada')).toBeUndefined();
  });
});

describe('Markdown seguro', () => {
  it('trechos: negrito, itálico, código, links (só http/mailto) e imagens', () => {
    expect(parseInline('a **b** _c_ `d` [e](https://x.com) [f](javascript:alert(1)) ![g](/img.png)')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'b', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'd' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://x.com', c: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' f) ' },
      { t: 'img', alt: 'g', src: '/img.png' },
    ]);
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(parseInline('snake_case_name')).toEqual([{ t: 'text', v: 'snake_case_name' }]);
  });

  it('blocos: títulos, listas (com subitem), código, citação, tabela e imagem sozinha', () => {
    const blocks = parseBlocks(
      '# T\n\n- um\n- dois\n  - sub\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n> citação\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n![tela](<C:\\Fotos do app\\a.png>)\n\nfim',
    );
    expect(blocks.map((b) => b.t)).toEqual(['h', 'list', 'list', 'code', 'quote', 'table', 'img', 'p']);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [{ level: 0 }, { level: 0 }, { level: 1 }] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 1 });
    expect(blocks[3]).toEqual({ t: 'code', lang: 'ts', v: 'const x = 1;' });
    expect(blocks[5]).toMatchObject({ align: ['left', 'right'], rows: [[[{ v: '1' }], [{ v: '2' }]]] });
    expect(blocks[6]).toEqual({ t: 'img', alt: 'tela', src: 'C:\\Fotos do app\\a.png' });
  });

  it('imageSources: todas as imagens citadas, sem repetir', () => {
    expect(imageSources('![a](x.png)\n---\n- item ![b](/y.png)\n\n![a](x.png)')).toEqual(['x.png', '/y.png']);
  });

  it('modo automático: de 5 a 20 s por slide, conforme o texto', () => {
    const [short, long] = parseSlides(`## Oi\n---\n${'palavra '.repeat(200)}`);
    expect(autoAdvanceMs(short!)).toBe(5_000);
    expect(autoAdvanceMs(long!)).toBe(20_000);
  });
});
