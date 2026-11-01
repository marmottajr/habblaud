import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Diretório de dados da corrida de testes. `dataDir` sai do HOME de quem corre o processo, não do clone, logo um teste
 * que arranque o servidor (ou que chame `loadConfig()` sem env própria) escreve no `~/.habblaud` de verdade. A pasta
 * descartável é o que mantém a suíte fora de lá; `server/datadir.test.ts` falha se estas linhas saírem.
 */
const DATA_DIR = mkdtempSync(join(tmpdir(), 'habblaud-vitest-'));

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts'],
    environment: 'node',
    env: { HABBLAUD_DATA_DIR: DATA_DIR, HABBLAUD_USAGE_DIR: join(DATA_DIR, 'usage') },
  },
});
