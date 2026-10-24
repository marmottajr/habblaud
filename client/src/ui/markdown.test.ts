import { describe, expect, it } from 'vitest';
import { splitTableRow, tokenizeBlocks, tokenizeInline, type MdBlock } from './markdown';

describe('tokenizeBlocks', () => {
  it('separa parágrafos por linha em branco e preserva as quebras de linha dentro deles', () => {
    expect(tokenizeBlocks('Primeira linha\nsegunda linha\n\nOutro parágrafo')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Primeira linha\nsegunda linha' },
      { type: 'paragraph', text: 'Outro parágrafo' },
    ]);
  });

  it('reconhece blocos de código com linguagem, sem interpretar markdown dentro', () => {
    const src = 'Veja:\n\n```ts\nconst a = **b**;\n# não é título\n```\nfim';
    expect(tokenizeBlocks(src)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Veja:' },
      { type: 'code', lang: 'ts', text: 'const a = **b**;\n# não é título' },
      { type: 'paragraph', text: 'fim' },
    ]);
  });

  it('bloco de código sem fechamento vai até o fim (resposta cortada)', () => {
    expect(tokenizeBlocks('```\nlinha 1\nlinha 2')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'linha 1\nlinha 2' }]);
  });

  it('fecha só com a mesma cerca (``` não fecha ~~~)', () => {
    expect(tokenizeBlocks('~~~\na\n```\nb\n~~~')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'a\n```\nb' }]);
  });

  it('títulos de 1 a 6 níveis (e # sem espaço não é título)', () => {
    expect(tokenizeBlocks('# Um\n### Três ###\n#hashtag')).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, text: 'Um' },
      { type: 'heading', level: 3, text: 'Três' },
      { type: 'paragraph', text: '#hashtag' },
    ]);
  });

  it('listas com marcador, numeradas e aninhadas', () => {
    const blocks = tokenizeBlocks('Arquivos:\n- a.ts\n  - b.ts\n- c.ts\n\n1. um\n2. dois');
    expect(blocks).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Arquivos:' },
      {
        type: 'list',
        ordered: false,
        items: [
          { depth: 0, marker: '-', ordered: false, text: 'a.ts' },
          { depth: 1, marker: '-', ordered: false, text: 'b.ts' },
          { depth: 0, marker: '-', ordered: false, text: 'c.ts' },
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          { depth: 0, marker: '1.', ordered: true, text: 'um' },
          { depth: 0, marker: '2.', ordered: true, text: 'dois' },
        ],
      },
    ]);
  });

  it('lista solta (linhas em branco entre itens) continua a mesma lista; linha recuada continua o item', () => {
    const blocks = tokenizeBlocks('- um\n\n- dois\n  continuação\n\nfim');
    expect(blocks[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { depth: 0, marker: '-', ordered: false, text: 'um' },
        { depth: 0, marker: '-', ordered: false, text: 'dois\ncontinuação' },
      ],
    });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'fim' });
  });

  it('número no meio de um parágrafo não vira lista (só "1." interrompe)', () => {
    expect(tokenizeBlocks('Em\n2024. foi assim')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'Em\n2024. foi assim' }]);
  });

  it('citação e linha horizontal', () => {
    expect(tokenizeBlocks('> dica\n> continua\n\n---\n\ntexto')).toEqual<MdBlock[]>([
      { type: 'quote', text: 'dica\ncontinua' },
      { type: 'rule' },
      { type: 'paragraph', text: 'texto' },
    ]);
  });

  it('tabela vira cabeçalho, alinhamentos e linhas com o número de colunas do cabeçalho', () => {
    const table = '| Arquivo | Linhas | Nota |\n|:---|---:|:-:|\n| a.ts | 10 |\n| b.ts | 2 | ok | extra |';
    expect(tokenizeBlocks(`Resumo:\n${table}\n\nfim`)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Resumo:' },
      {
        type: 'table',
        align: ['left', 'right', 'center'],
        head: ['Arquivo', 'Linhas', 'Nota'],
        rows: [
          ['a.ts', '10', ''],
          ['b.ts', '2', 'ok'],
        ],
      },
      { type: 'paragraph', text: 'fim' },
    ]);
  });

  it('tabela sem separador (linhas começando com |) fica sem cabeçalho', () => {
    expect(tokenizeBlocks('| a | b |\n| c |')).toEqual<MdBlock[]>([
      { type: 'table', align: [null, null], head: null, rows: [['a', 'b'], ['c', '']] },
    ]);
  });

  it('célula: barra escapada e barra dentro de `código` não dividem; crase sem par é literal', () => {
    expect(splitTableRow('| `a | b` | x \\| y | `solta | z |')).toEqual(['`a | b`', 'x | y', '`solta', 'z']);
    expect(splitTableRow('sem | pontas')).toEqual(['sem', 'pontas']);
  });

  it('barra solta num parágrafo não vira tabela', () => {
    expect(tokenizeBlocks('use a | b para filtrar')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'use a | b para filtrar' }]);
  });

  it('normaliza \\r\\n', () => {
    expect(tokenizeBlocks('a\r\nb\r\n\r\nc')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'a\nb' },
      { type: 'paragraph', text: 'c' },
    ]);
  });
});

describe('tokenizeInline', () => {
  it('texto simples vira um único trecho', () => {
    expect(tokenizeInline('olá mundo')).toEqual([{ type: 'text', text: 'olá mundo' }]);
  });

  it('código inline (sem interpretar o que tem dentro)', () => {
    expect(tokenizeInline('rode `npm **test**` agora')).toEqual([
      { type: 'text', text: 'rode ' },
      { type: 'code', text: 'npm **test**' },
      { type: 'text', text: ' agora' },
    ]);
  });

  it('código com crases duplas pode conter crase', () => {
    expect(tokenizeInline('``a ` b``')).toEqual([{ type: 'code', text: 'a ` b' }]);
  });

  it('crase sem par fica como texto', () => {
    expect(tokenizeInline('um ` solto')).toEqual([{ type: 'text', text: 'um ` solto' }]);
  });

  it('negrito e itálico, inclusive aninhados', () => {
    expect(tokenizeInline('**forte** e *leve*')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'forte' }] },
      { type: 'text', text: ' e ' },
      { type: 'em', children: [{ type: 'text', text: 'leve' }] },
    ]);
    expect(tokenizeInline('**a *b* c**')).toEqual([
      {
        type: 'strong',
        children: [{ type: 'text', text: 'a ' }, { type: 'em', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' c' }],
      },
    ]);
  });

  it('asterisco com espaço (conta) e sublinhado dentro de palavra não formatam', () => {
    expect(tokenizeInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    expect(tokenizeInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(tokenizeInline('_ênfase_')).toEqual([{ type: 'em', children: [{ type: 'text', text: 'ênfase' }] }]);
  });

  it('links [texto](url) guardam o endereço à parte', () => {
    expect(tokenizeInline('veja [a doc](https://exemplo.com/x "título") aqui')).toEqual([
      { type: 'text', text: 'veja ' },
      { type: 'link', text: 'a doc', href: 'https://exemplo.com/x' },
      { type: 'text', text: ' aqui' },
    ]);
    expect(tokenizeInline('[sem link] e [x](com espaço)')).toEqual([{ type: 'text', text: '[sem link] e [x](com espaço)' }]);
  });

  it('endereço http(s) solto e <url> viram link, sem a pontuação da frase nem o ) sem par', () => {
    expect(tokenizeInline('PR: https://github.com/a/b/pull/184. Veja (https://x.dev/a_(b)) e <https://y.dev/q?a=1>!')).toEqual([
      { type: 'text', text: 'PR: ' },
      { type: 'link', text: 'https://github.com/a/b/pull/184', href: 'https://github.com/a/b/pull/184' },
      { type: 'text', text: '. Veja (' },
      { type: 'link', text: 'https://x.dev/a_(b)', href: 'https://x.dev/a_(b)' },
      { type: 'text', text: ') e ' },
      { type: 'link', text: 'https://y.dev/q?a=1', href: 'https://y.dev/q?a=1' },
      { type: 'text', text: '!' },
    ]);
  });

  it('não vira link: dentro de `código`, colado numa palavra, ou sem nada depois de https://', () => {
    expect(tokenizeInline('`https://a.dev` xhttps://b.dev https://')).toEqual([
      { type: 'code', text: 'https://a.dev' },
      { type: 'text', text: ' xhttps://b.dev https://' },
    ]);
  });

  it('escapes com barra invertida', () => {
    expect(tokenizeInline('\\*não\\* itálico')).toEqual([{ type: 'text', text: '*não* itálico' }]);
  });

  it('HTML do transcript é só texto (quem monta usa textContent)', () => {
    expect(tokenizeInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
