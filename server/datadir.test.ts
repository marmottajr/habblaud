// Guarda: a suíte não escreve no diretório de dados de verdade.
//
// `dataDir` sai do HOME de quem corre o processo (`server/config.ts`), não do clone. Logo um teste que arranque o
// servidor, ou que chame `loadConfig()` sem env própria, escreve em `~/.habblaud` da pessoa que está a correr os
// testes, por cima do que um arranque de verdade tem lá. Foi assim que uma identidade de push nasceu numa pasta de
// produção sem ninguém a pedir: o `createPushService` gera o par e grava-o no primeiro arranque que não encontra
// chave, e nada no caminho pergunta se aquela pasta é desta corrida.
//
// `vitest.config.ts` aponta `HABBLAUD_DATA_DIR` e `HABBLAUD_USAGE_DIR` para uma pasta descartável. Estes dois casos
// falham se essas linhas desaparecerem.
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('diretório de dados nos testes', () => {
  it('as duas variáveis apontam para uma pasta descartável', () => {
    for (const nome of ['HABBLAUD_DATA_DIR', 'HABBLAUD_USAGE_DIR']) {
      const dir = process.env[nome];
      expect(dir, `${nome} não está definida`).toBeTruthy();
      expect(dir?.startsWith(tmpdir()), `${nome}=${dir} fora de ${tmpdir()}`).toBe(true);
    }
  });

  it('o config resolvido não cai no diretório de dados de produção', () => {
    const { dataDir, usageDir } = loadConfig();
    const producao = join(homedir(), '.habblaud');
    expect(dataDir).toBe(resolve(process.env.HABBLAUD_DATA_DIR ?? ''));
    expect(dataDir.startsWith(producao)).toBe(false);
    expect(usageDir.startsWith(producao)).toBe(false);
  });
});
