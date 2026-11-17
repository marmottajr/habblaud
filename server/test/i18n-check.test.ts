// npm run i18n:check: as chaves saem do código como o JavaScript as lê, com qualquer fim de linha no arquivo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectKeys } from '../../scripts/i18n-check';
import { tempDir } from './fixtures';

describe('i18n:check', () => {
  it('template literal de várias linhas: a chave tem "\\n", com o arquivo em LF ou em CRLF (checkout no Windows)', () => {
    const tmp = tempDir();
    try {
      for (const d of ['client/src', 'shared', 'server', 'scripts']) mkdirSync(join(tmp.dir, d), { recursive: true });
      const src = ["const ajuda = tr(`Uso: x", '', '  --opção  faz algo`);', "const outro = tr('uma linha');", ''];
      writeFileSync(join(tmp.dir, 'scripts', 'lf.ts'), src.join('\n'));
      writeFileSync(join(tmp.dir, 'server', 'crlf.ts'), src.join('\r\n'));
      const keys = collectKeys(tmp.dir);
      expect([...keys.keys()].sort()).toEqual(['Uso: x\n\n  --opção  faz algo', 'uma linha']);
      // A mesma chave nos dois arquivos, com a linha certa em cada um.
      expect(keys.get('Uso: x\n\n  --opção  faz algo')!.map((ref) => ref.replace(/\\/g, '/')).sort()).toEqual(['scripts/lf.ts:1', 'server/crlf.ts:1']);
      expect(keys.get('uma linha')!.map((ref) => ref.replace(/\\/g, '/')).sort()).toEqual(['scripts/lf.ts:4', 'server/crlf.ts:4']);
    } finally {
      tmp.cleanup();
    }
  });
});
