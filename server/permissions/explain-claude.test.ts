// Refino opcional da explicação com o Claude Code local: prompt, aceite da resposta, cache e falhas (sem rodar o claude).
import { describe, expect, it } from 'vitest';
import type { PermissionRequestInfo, PlainExplanation } from '../../shared/types';
import { acceptRefined, createClaudeRefiner, refinePrompt, type Runner } from './explain-claude';

const info: PermissionRequestInfo = { id: 'p1', tool: 'Bash', title: 'Bash(rm -rf dist)', text: 'Organizando arquivos', icon: '🗂️', input: 'rm -rf dist', inputKind: 'command', createdAt: 0, expiresAt: 1 };
const plain: PlainExplanation = { risk: 'alto', what: 'O agente quer apagar a pasta dist e tudo que há dentro, na pasta do projeto loja.', why: 'Risco alto.' };

describe('refino com o Claude Code local (HABBLAUD_EXPLICAR=claude)', () => {
  it('o prompt leva o que o cartão já mostra e pede uma frase só', () => {
    const p = refinePrompt(info, plain);
    expect(p).toContain('Ferramenta: Bash');
    expect(p).toContain('Título técnico: Bash(rm -rf dist)');
    expect(p).toContain(plain.what);
    expect(p).toContain('rm -rf dist');
    expect(p).toMatch(/UMA frase/);
  });

  it('acceptRefined: uma linha limpa; recusa vazio, markdown, várias linhas e textos longos', () => {
    expect(acceptRefined('  "O agente quer apagar a pasta dist do projeto loja."  ')).toBe('O agente quer apagar a pasta dist do projeto loja.');
    expect(acceptRefined('')).toBeUndefined();
    expect(acceptRefined('curto')).toBeUndefined();
    expect(acceptRefined('O agente quer\napagar')).toBeUndefined();
    expect(acceptRefined('# O agente quer apagar a pasta dist')).toBeUndefined();
    expect(acceptRefined('x'.repeat(300))).toBeUndefined();
  });

  it('chama o claude em modo -p sem hooks nem sessão; cache por pedido; resposta ruim vira undefined', async () => {
    const calls: Array<{ bin: string; args: string[]; stdin: string; timeoutMs: number }> = [];
    const run: Runner = async (bin, args, stdin, timeoutMs) => {
      calls.push({ bin, args, stdin, timeoutMs });
      return 'O agente quer apagar a pasta dist, que guarda a versão compilada do projeto loja.\n';
    };
    const refine = createClaudeRefiner({ claudeBin: '/usr/local/bin/claude', run, timeoutMs: 1_000 });
    expect(await refine(info, plain)).toBe('O agente quer apagar a pasta dist, que guarda a versão compilada do projeto loja.');
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('/usr/local/bin/claude');
    expect(calls[0].args).toEqual(['-p', '--bare', '--no-session-persistence', '--model', 'haiku', '--output-format', 'text', '--tools', '']);
    expect(calls[0].timeoutMs).toBe(1_000);
    // O mesmo pedido (outro id) não chama de novo.
    expect(await refine({ ...info, id: 'p2' }, plain)).toBe('O agente quer apagar a pasta dist, que guarda a versão compilada do projeto loja.');
    expect(calls).toHaveLength(1);
    // Resposta que não serve: fica o automático.
    const bad = createClaudeRefiner({ claudeBin: 'claude', run: async () => '```\nnada\n```' });
    expect(await bad(info, plain)).toBeUndefined();
  });

  it('erro de execução rejeita (o registro loga) e sai do cache', async () => {
    let n = 0;
    const run: Runner = async () => {
      n++;
      throw new Error('tempo esgotado (8 s)');
    };
    const refine = createClaudeRefiner({ claudeBin: 'claude', run });
    await expect(refine(info, plain)).rejects.toThrow(/tempo esgotado/);
    await expect(refine(info, plain)).rejects.toThrow();
    expect(n).toBe(2);
  });
});
