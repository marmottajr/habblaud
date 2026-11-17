import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { checkFile, DELIVERY_FILE_MAX_BYTES, fileType, insideKnownFolder, pathProblem } from './files';

describe('arquivos das entregas', () => {
  it('só tipos de ver e nada com cara de segredo', () => {
    expect(fileType('/a/b.PNG')).toEqual({ kind: 'image', type: 'image/png' });
    expect(fileType('/a/b.pdf')?.kind).toBe('pdf');
    expect(fileType('/a/b.json')).toBeUndefined();
    expect(pathProblem('/Users/a/p/relatorio.pdf')).toBeUndefined();
    for (const bad of ['/Users/a/.ssh/x.png', '/Users/a/p/.env.png', '/Users/a/p/secret-plan.pdf', '/Users/a/p/server.key', '/Users/a/.aws/c.txt', '/Users/a/.habblaud/remote-tls/ca.pdf', 'rel.png', '/a/../b.png', '/a/b.sh', '/a/id_ed25519']) {
      expect(pathProblem(bad), bad).toBeDefined();
    }
  });

  it('checkFile: confere o caminho real (link para segredo cai), tamanho e tipo', () => {
    const fs = (real: string, size = 10, file = true) => ({ realpath: () => real, stat: () => ({ isFile: () => file, size }) });
    expect(checkFile('/Users/a/p/x.png', fs('/Users/a/p/x.png'))).toEqual({ path: '/Users/a/p/x.png', size: 10 });
    expect(checkFile('/Users/a/p/x.png', fs('/Users/a/.ssh/x.png'))).toEqual({ error: 'arquivo protegido' });
    expect(checkFile('/Users/a/p/x.png', fs('/Users/a/p/x.png', DELIVERY_FILE_MAX_BYTES + 1))).toHaveProperty('error');
    expect(checkFile('/Users/a/p/x.png', fs('/Users/a/p/x.png', 1, false))).toEqual({ error: 'não é um arquivo' });
    expect(checkFile('/nao/existe.png')).toEqual({ error: 'arquivo não encontrado' });
  });

  it('no Windows: letra de unidade com "\\" ou "/"; nada de rede, dispositivo, fluxo alternativo ou nome terminado em ponto', () => {
    for (const ok of ['C:\\Users\\a\\p\\relatorio.pdf', 'c:/Users/a/p/print.PNG', 'D:\\proj\\docs\\tela 1.png', '\\Users\\a\\p\\x.png']) {
      expect(pathProblem(ok, 'win32'), ok).toBeUndefined();
    }
    const bad = [
      '\\\\servidor\\pasta\\x.png',
      '//servidor/pasta/x.png',
      '\\\\?\\C:\\a\\x.png',
      '\\\\.\\C:\\a\\x.png',
      'C:x.png',
      'rel\\x.png',
      'C:\\a\\x.png:oculto.png',
      'C:\\a\\..\\b.png',
      'C:\\Users\\a\\.ssh.\\x.png',
      'C:\\Users\\a\\p\\x.png ',
      'C:\\Users\\a\\.ssh\\x.png',
      'C:\\Users\\a\\.SSH\\x.png',
      'C:\\Users\\a\\p\\.env.png',
      'C:\\Users\\a\\p\\Senha do banco.pdf',
      'C:\\Users\\a\\.habblaud\\remote-tls\\ca.pdf',
      'C:\\a\\b.ps1',
    ];
    for (const b of bad) expect(pathProblem(b, 'win32'), b).toBeDefined();
    // Fora do Windows, "C:\..." não é um caminho absoluto.
    expect(pathProblem('C:\\Users\\a\\p\\relatorio.pdf', 'linux')).toBe('caminho inválido');
  });

  it('checkFile no Windows: o caminho real decide (nome curto de pasta protegida e unidade de rede caem)', () => {
    const fs = (real: string) => ({ realpath: () => real, stat: () => ({ isFile: () => true, size: 10 }) });
    expect(checkFile('C:\\Users\\a\\p\\x.png', fs('C:\\Users\\a\\p\\x.png'), 'win32')).toEqual({ path: 'C:\\Users\\a\\p\\x.png', size: 10 });
    expect(checkFile('C:\\Users\\a\\SSH~1\\x.png', fs('C:\\Users\\a\\.ssh\\x.png'), 'win32')).toEqual({ error: 'arquivo protegido' });
    expect(checkFile('Z:\\x.png', fs('\\\\servidor\\pasta\\x.png'), 'win32')).toEqual({ error: 'caminho inválido' });
  });

  it.runIf(process.platform === 'win32')('checkFile no Windows, no disco: devolve o caminho com as letras que estão no disco', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, 'Tela.png');
      writeFileSync(file, 'x');
      expect(checkFile(file.toUpperCase())).toEqual({ path: realpathSync.native(file), size: 1 });
      expect(checkFile(join(dir, 'nao-existe.png'))).toEqual({ error: 'arquivo não encontrado' });
    } finally {
      cleanup();
    }
  });

  it('insideKnownFolder: só pastas de projeto que alguma conta conhece, as temporárias e os anexos', () => {
    const known = new Set(['/h/.claude/projects/-Users-ana-loja', '/h/.claude-2/projects/-Users-ana-x-y']);
    const opts = { accountDirs: ['/h/.claude', '/h/.claude-2'], roots: ['/tmp', '/h/.habblaud/attachments'], exists: (p: string) => known.has(p) };
    expect(insideKnownFolder('/Users/ana/loja/docs/print.png', opts)).toBe(true);
    expect(insideKnownFolder('/Users/ana/x-y/a.pdf', opts)).toBe(true);
    expect(insideKnownFolder('/tmp/claude/scratch/tela.png', opts)).toBe(true);
    expect(insideKnownFolder('/h/.habblaud/attachments/20261013-ab/foto.jpg', opts)).toBe(true);
    // Fora dos projetos: o resto da pasta pessoal, outra pasta de projeto que ninguém usou e o próprio "/Users".
    expect(insideKnownFolder('/Users/ana/Documents/extrato.pdf', opts)).toBe(false);
    expect(insideKnownFolder('/Users/ana/lojas/a.png', opts)).toBe(false);
    expect(insideKnownFolder('/tmpx/a.png', opts)).toBe(false);
  });
});
