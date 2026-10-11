import { describe, expect, it } from 'vitest';
import { proximaTexto, quandoTexto } from './rotinas';

describe('painel de rotinas: textos', () => {
  it('descreve quando a rotina roda', () => {
    expect(quandoTexto({ dias: [1, 3, 5], hora: '09:00' })).toBe('seg, qua, sex às 09:00');
    expect(quandoTexto({ dias: [0, 1, 2, 3, 4, 5, 6], hora: '18:30' })).toBe('todo dia às 18:30');
    expect(quandoTexto({ dias: [1, 2, 3, 4, 5], hora: '08:00' })).toBe('dias úteis às 08:00');
    expect(quandoTexto({ dias: [], hora: '', intervaloMin: 45 })).toBe('a cada 45 minutos');
    expect(quandoTexto({ dias: [], hora: '', intervaloMin: 60 })).toBe('a cada hora');
    expect(quandoTexto({ dias: [], hora: '', intervaloMin: 240 })).toBe('a cada 4 horas');
    expect(quandoTexto({ dias: [], hora: '', intervaloMin: 2880 })).toBe('a cada 2 dias');
  });

  it('diz a próxima vez em relação a agora', () => {
    const agora = new Date(2026, 9, 5, 8, 0, 0).getTime();
    expect(proximaTexto(new Date(2026, 9, 5, 18, 0, 0).getTime(), agora)).toBe('hoje 18:00');
    expect(proximaTexto(new Date(2026, 9, 6, 9, 5, 0).getTime(), agora)).toBe('amanhã 09:05');
    expect(proximaTexto(new Date(2026, 9, 12, 9, 0, 0).getTime(), agora)).toBe('seg 12/10 09:00');
    expect(proximaTexto(Number.POSITIVE_INFINITY, agora)).toBe('');
  });
});
