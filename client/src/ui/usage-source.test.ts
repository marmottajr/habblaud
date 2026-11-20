import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { cardState, codexUsageNote, limitGroup, ompProviderViews, ompUsageNote, showsUsageAge, sourceLabel, usageMessage, usageSubtitle, windowShort } from './usage';

const MIN = 60_000;
type Acc = Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider' | 'email' | 'plan' | 'configDir'>;
const codex = (over: Partial<Acc> = {}): Acc => ({ provider: 'codex', usageStatus: 'ok', configDir: '~/.codex', plan: 'Team', ...over });
const win = { utilization: 42, resetsAt: 10 * 60 * MIN };
const omp = (over: Partial<Acc> = {}): Acc => ({ provider: 'omp', usageStatus: 'ok', configDir: 'C:\\Users\\x\\.omp\\agent', ...over });

describe('sourceLabel', () => {
  it('diz quem gravou o uso ao vivo', () => {
    expect(sourceLabel({ source: 'statusline', via: 'mod', fetchedAt: 0 })).toBe('ao vivo (mod do Habblaud)');
    expect(sourceLabel({ source: 'statusline', via: 'tap', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'statusline', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'cache', fetchedAt: 0 })).toBe('cache do /usage do Claude Code');
    expect(sourceLabel({ source: 'codex', fetchedAt: 0 })).toBe('arquivos do Codex');
  });
});

describe('cartão de uso de uma conta do Codex', () => {
  it('"sem cota" é um estado próprio (nunca 0% nem "sem dados")', () => {
    const noQuota = codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } });
    expect(cardState(noQuota)).toBe('noquota');
    expect(usageMessage(noQuota)).toEqual(['sem cota', 'sem cota']);
    expect(codexUsageNote(noQuota, 3 * MIN)).toMatch(/^Na última leitura \(há 3 min\), a conta estava sem cota nem créditos .*Não é 0%/);
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 } }))).toBe('ok');
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 }, usageStatus: 'stale' }))).toBe('stale');
    expect(cardState(codex())).toBe('empty');
  });

  it('a idade fica sempre à mostra no Codex (só se renova com sessão rodando); no Claude Code, só quando é antiga', () => {
    const fresh = { source: 'codex' as const, fiveHour: win, fetchedAt: 0 };
    expect(showsUsageAge(codex({ usage: fresh }))).toBe(true);
    expect(showsUsageAge(codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } }))).toBe(true);
    expect(showsUsageAge(codex())).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'statusline' }, usageStatus: 'ok' })).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'cache' }, usageStatus: 'stale' })).toBe(true);
    expect(codexUsageNote(codex({ usage: fresh }), 12 * MIN)).toBe('O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura (há 12 min).');
  });

  it('sem números: não há o que instalar; embaixo do nome, o plano (sem e-mail)', () => {
    expect(usageMessage(codex())).toEqual(['sem dados ainda', 'sem dados']);
    expect(codexUsageNote(codex(), 0)).toBe('Não precisa instalar nada: os números chegam com a próxima sessão do Codex.');
    expect(usageSubtitle(codex())).toBe('plano Team');
    expect(usageSubtitle(codex({ plan: undefined }))).toBe('Codex');
    // Claude Code: como antes.
    expect(usageMessage({ usageStatus: 'disabled' })).toEqual(['sem dados de uso', 'sem dados']);
    expect(usageSubtitle({ email: 'a@b.c', configDir: '~/.claude' })).toBe('a@b.c');
    expect(usageSubtitle({ configDir: '~/.claude' })).toBe('~/.claude');
    expect(codexUsageNote({ usageStatus: 'ok' }, 0)).toBe('');
  });
});

describe('cartão de uso de uma conta do omp', () => {
  it('com janelas: estado ok, idade à mostra, origem com o provedor', () => {
    const usage = { source: 'omp' as const, ompProvider: 'anthropic', fetchedAt: 0, fiveHour: win, sevenDay: win };
    const a = omp({ usage });
    expect(cardState(a)).toBe('ok');
    expect(showsUsageAge(a)).toBe(true);
    expect(sourceLabel(usage)).toBe('omp usage (anthropic)');
    expect(sourceLabel({ source: 'omp', fetchedAt: 0 })).toBe('omp usage');
    expect(ompUsageNote(a, 3 * MIN)).toBe(
      'Uso do provedor anthropic (o do modelo em uso), lido do "omp usage" a cada 5 min com uma sessão aberta; esta leitura é de há 3 min.',
    );
  });

  it('provedor sem janelas de 5 h/7 d: "sem uso de 5 h e semana" com a nota do omp', () => {
    const note = 'Ollama does not expose a standalone quota usage API.';
    const a = omp({ usage: { source: 'omp', ompProvider: 'ollama-cloud', fetchedAt: 0, note } });
    expect(cardState(a)).toBe('empty');
    expect(usageMessage(a)).toEqual(['sem uso de 5 h e semana', 'sem uso']);
    expect(ompUsageNote(a, 0)).toBe(`ollama-cloud não informa uso de 5 h nem da semana ao omp: ${note}`);
    expect(ompUsageNote(omp({ usage: { source: 'omp', ompProvider: 'openai-codex', fetchedAt: 0 } }), 0)).toBe(
      'openai-codex não informa uso de 5 h nem da semana ao omp.',
    );
  });

  it('sem leitura ainda: "sem uso informado"; embaixo do nome, a pasta', () => {
    const a = omp({ usageStatus: 'disabled' });
    expect(cardState(a)).toBe('empty');
    expect(usageMessage(a)).toEqual(['sem uso informado', 'sem uso']);
    expect(ompUsageNote(a, 0)).toMatch(/^Ainda sem uso: /);
    expect(usageSubtitle(a)).toBe('C:\\Users\\x\\.omp\\agent');
  });

  it('sem cota nunca vira 0%; as notas de uma ferramenta não aparecem na outra', () => {
    const a = omp({ usage: { source: 'omp', ompProvider: 'anthropic', noQuota: true, fetchedAt: 0 } });
    expect(cardState(a)).toBe('noquota');
    expect(ompUsageNote(a, 0)).toMatch(/^Na última leitura \(/);
    expect(ompUsageNote(codex(), 0)).toBe('');
    expect(codexUsageNote(omp(), 0)).toBe('');
  });
});

describe('provedores do omp (painel do cartão)', () => {
  const H = 3_600_000;
  it('rótulo sem a janela agrupa os limites; janela curta', () => {
    expect(limitGroup('Claude 7 Day (Fable)')).toBe('Claude (Fable)');
    expect(limitGroup('Claude 5 Hour')).toBe('Claude');
    expect(limitGroup('7 days')).toBe('');
    expect(limitGroup('Claude & GPT (shared)')).toBe('Claude & GPT (shared)');
    expect([windowShort(5 * H), windowShort(168 * H), windowShort(720 * H), windowShort(undefined)]).toEqual(['5h', 'Sem.', '30d', '']);
  });

  it('o provedor em uso vem primeiro; credencial repetida ganha número; limites agrupados na ordem do omp', () => {
    const views = ompProviderViews({
      source: 'omp',
      ompProvider: 'anthropic',
      fetchedAt: 0,
      ompProviders: [
        { provider: 'openai-codex', plan: 'plus', limits: [{ label: '7 days', windowMs: 168 * H, utilization: 1 }], fetchedAt: 0 },
        { provider: 'anthropic', limits: [{ label: 'Claude 5 Hour', windowMs: 5 * H, utilization: 4 }, { label: 'Claude 7 Day', windowMs: 168 * H, utilization: 7 }, { label: 'Claude 7 Day (Fable)', windowMs: 168 * H, utilization: 0 }], fetchedAt: 0 },
        { provider: 'anthropic', limits: [], note: 'sem limites', fetchedAt: 0 },
      ],
    });
    expect(views.map((v) => [v.title, v.current])).toEqual([
      ['Anthropic (1)', true],
      ['OpenAI Codex', false],
      ['Anthropic (2)', false],
    ]);
    expect(views[0].groups.map((g) => [g.label, g.limits.length])).toEqual([
      ['Claude', 2],
      ['Claude (Fable)', 1],
    ]);
    expect(views[1]).toMatchObject({ plan: 'plus', groups: [{ label: '', limits: [{ utilization: 1 }] }] });
    expect(views[2]).toMatchObject({ note: 'sem limites', groups: [] });
    expect(ompProviderViews(undefined)).toEqual([]);
  });
});
