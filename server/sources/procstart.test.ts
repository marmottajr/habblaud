import { describe, expect, it } from 'vitest';
import { BORN_AFTER_MS, parseProcStarts, pidOwner, procStartCommand, readProcStarts, readProcStartsSync } from './procstart';

/** 2026-11-02T19:34:22.490Z como FILETIME e em ms. */
const FT = '134381216624905399';
const MS = 1_793_648_062_490;

describe('início dos processos', () => {
  it('pidOwner: `procStart` igual ao início lido é o mesmo processo, mesmo com o relógio fora do lugar', () => {
    // Igual (ou a menos de 1 ms: o WMI arredonda para microssegundos).
    expect(pidOwner({ procStart: FT, lastWriteMs: MS + 5_000 }, { startMs: MS, fileTime: FT })).toBe('same');
    expect(pidOwner({ procStart: FT, lastWriteMs: MS + 5_000 }, { startMs: MS, fileTime: '134381216624905390' })).toBe('same');
    // Relógio acertado para trás depois que o processo subiu: o registro "é de antes", mas o início bate.
    expect(pidOwner({ procStart: FT, lastWriteMs: MS - 3_600_000 }, { startMs: MS, fileTime: FT })).toBe('same');
  });

  it('pidOwner: outro processo só se nasceu bem depois da última gravação do registro; na dúvida, é o mesmo', () => {
    const later = { startMs: MS + 13 * 86_400_000, fileTime: '134392448624905399' };
    // O registro de 02/11 com o PID nas mãos de um processo de 15/11.
    expect(pidOwner({ procStart: FT, lastWriteMs: MS + 1_500 }, later)).toBe('other');
    // Sem `procStart` (ou num formato que não é FILETIME): vale só a data.
    expect(pidOwner({ lastWriteMs: MS + 1_500 }, later)).toBe('other');
    expect(pidOwner({ procStart: '4242', lastWriteMs: MS + 1_500 }, { startMs: later.startMs })).toBe('other');
    expect(pidOwner({ lastWriteMs: MS + 1_500 }, { startMs: MS })).toBe('same');
    // Dentro da folga (resolução do ps, acerto pequeno do relógio): o mesmo.
    expect(pidOwner({ lastWriteMs: MS }, { startMs: MS + BORN_AFTER_MS })).toBe('same');
    expect(pidOwner({ lastWriteMs: MS }, { startMs: MS + BORN_AFTER_MS + 1 })).toBe('other');
    // `procStart` diferente, mas o processo já existia quando o registro foi gravado: não dá para dizer que é outro.
    expect(pidOwner({ procStart: FT, lastWriteMs: MS + 86_400_000 }, { startMs: MS + 1_000, fileTime: '134381216634905399' })).toBe('same');
  });

  it('Windows: um PowerShell só, com os PIDs no script codificado; lê "<pid> <FILETIME>" e "<pid> ?"', () => {
    const cmd = procStartCommand([2932, 29084], 'win32');
    expect(cmd.file).toBe('powershell.exe');
    expect(cmd.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(cmd.args[4], 'base64').toString('utf16le');
    expect(script).toContain('Get-Process -Id 2932,29084');
    expect(script).toContain('Get-CimInstance Win32_Process');
    const found = parseProcStarts(`2932 ${FT}\r\n29084 ?\r\nlixo\r\n\r\n`, 'win32');
    expect([...found]).toEqual([
      [2932, { startMs: MS, fileTime: FT }],
      [29084, null],
    ]);
  });

  it('macOS e Linux: `ps` com lstart em inglês; lê uma linha por processo', () => {
    const cmd = procStartCommand([10, 11], 'linux');
    expect(cmd.file).toBe('ps');
    expect(cmd.args).toEqual(['-o', 'pid=', '-o', 'lstart=', '-p', '10,11']);
    expect(cmd.env).toMatchObject({ LC_ALL: 'C', LANG: 'C' });
    const found = parseProcStarts('   10 Mon Oct 12 22:46:14 2026\n   11 Sun Nov  1 03:04:05 2026\nPID STARTED\n', 'darwin');
    expect([...found.keys()]).toEqual([10, 11]);
    expect(found.get(10)).toEqual({ startMs: new Date(2026, 9, 12, 22, 46, 14).getTime() });
    expect(found.get(11)).toEqual({ startMs: new Date(2026, 10, 1, 3, 4, 5).getTime() });
  });

  it('de verdade: acha este processo (com o início certo) e não acha um PID que não existe', async () => {
    const started = Date.now() - process.uptime() * 1000;
    const pids = [process.pid, 0x7ffffff0, -1, 1.5];
    for (const found of [readProcStartsSync(pids), await readProcStarts(pids)]) {
      expect(found).toBeDefined();
      expect([...found!.keys()]).toEqual([process.pid]);
      const me = found!.get(process.pid)!;
      expect(Math.abs(me.startMs - started)).toBeLessThan(5_000);
      // Um registro gravado agora por este processo é dele; o de um mês atrás, com este PID, é de outro.
      expect(pidOwner({ lastWriteMs: Date.now() }, me)).toBe('same');
      expect(pidOwner({ lastWriteMs: started - 30 * 86_400_000 }, me)).toBe('other');
    }
    expect(readProcStartsSync([])).toEqual(new Map());
    expect(await readProcStarts([NaN])).toEqual(new Map());
  });
});
