// Fonte dos agentes externos: eventos -> conta da ferramenta, personagem, atividades, status e saída.
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { externalActivity, ExternalSource, toolDisplayName, type ExternalEvent } from './source';

setQuiet(true);

const CWD = '/projetos/loja';

let stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

function setup(opts: { ttlMin?: number } = {}) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/home/x', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new ExternalSource({ accounts, office, now, sweep: false, ttlMin: opts.ttlMin });
  stops.push(() => source.stop());
  const ev = (e: Partial<ExternalEvent> & Pick<ExternalEvent, 'event'>) => source.applyEvent({ tool: 'grok', session: 's1', cwd: CWD, ...e });
  return {
    accounts,
    office,
    source,
    ev,
    advance(ms: number) {
      clock += ms;
    },
    agent: (id = 'grok:s1') => office.get(id),
  };
}

describe('ExternalSource', () => {
  it('o primeiro evento cria a conta da ferramenta e o personagem na sala do projeto', () => {
    const w = setup();
    expect(w.ev({ event: 'start', title: 'Refatorar o login', model: 'grok-5' })).toEqual({ ok: true });
    const a = w.agent();
    expect(a).toMatchObject({ provider: 'external', account: 'grok', kind: 'main', status: 'idle', sessionId: 's1', title: 'Refatorar o login', model: 'grok-5' });
    const acc = w.accounts.entriesOf('external');
    expect(acc.map((e) => [e.id, e.detected.name, e.detected.short])).toEqual([['grok', 'Grok', 'G']]);
    expect(w.source.sources()).toEqual([{ label: 'grok', provider: 'external', path: 'external:grok', sessions: 1, ok: true }]);
    expect(w.office.roomPath(a!.roomId)).toBe(CWD);
  });

  it('sem cwd no primeiro evento, recusa (e não cria nada)', () => {
    const w = setup();
    const r = w.source.applyEvent({ tool: 'grok', session: 's1', event: 'prompt', text: 'oi' });
    expect(r.ok).toBe(false);
    expect(w.agent()).toBeUndefined();
    // Depois de conhecida, a sessão dispensa o cwd.
    w.ev({ event: 'start' });
    expect(w.source.applyEvent({ tool: 'grok', session: 's1', event: 'idle' })).toEqual({ ok: true });
  });

  it('prompt e activity deixam trabalhando; waiting levanta a mão; idle volta a ocioso', () => {
    const w = setup();
    w.ev({ event: 'prompt', text: 'Corrija o teste do login' });
    expect(w.agent()?.status).toBe('working');
    expect(w.agent()?.activity).toMatchObject({ kind: 'prompt' });

    w.advance(1_000);
    w.ev({ event: 'activity', kind: 'run', text: 'Rodando os testes', detail: 'npm test' });
    expect(w.agent()?.activity).toMatchObject({ kind: 'run', icon: '💻', text: 'Rodando os testes', detail: 'npm test' });
    expect(w.agent()?.stats.toolCalls).toBe(1);

    w.advance(1_000);
    w.ev({ event: 'waiting', text: 'aprovar um comando' });
    expect(w.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });

    w.advance(1_000);
    w.ev({ event: 'waiting' });
    expect(w.agent()?.waitingFor).toBe('responder no Grok');

    w.advance(1_000);
    w.ev({ event: 'idle' });
    expect(w.agent()?.status).toBe('idle');
  });

  it('activity com toolName é descrita como a ferramenta do Claude Code', () => {
    const w = setup();
    w.ev({ event: 'activity', toolName: 'Read', input: { file_path: '/projetos/loja/src/login.ts' } });
    expect(w.agent()?.activity).toMatchObject({ kind: 'read', tool: 'Read' });
    expect(w.agent()?.activity?.text).toContain('login.ts');
  });

  it('activity sem text nem toolName é recusada', () => {
    const w = setup();
    expect(w.ev({ event: 'activity' }).ok).toBe(false);
  });

  it('end tira o personagem; end de sessão desconhecida é aceito sem efeito', () => {
    const w = setup();
    expect(w.ev({ event: 'end', session: 'nunca-vista' })).toEqual({ ok: true });
    w.ev({ event: 'start' });
    w.ev({ event: 'end' });
    expect(w.agent()?.status).toBe('offline');
    expect(w.source.sources()[0].sessions).toBe(0);
  });

  it('sessão esquecida (sem eventos além do prazo) sai sozinha', () => {
    const w = setup({ ttlMin: 5 });
    w.ev({ event: 'start' });
    w.advance(4 * 60_000);
    w.source.sweep();
    expect(w.agent()?.status).toBe('idle');
    w.advance(2 * 60_000);
    w.source.sweep();
    expect(w.agent()?.status).toBe('offline');
  });

  it('ferramentas diferentes viram contas diferentes; o nome exibido pode vir do evento', () => {
    const w = setup();
    w.ev({ event: 'start' });
    w.ev({ event: 'start', tool: 'aider', toolLabel: 'Aider CLI', session: 'x' });
    expect(w.accounts.entriesOf('external').map((e) => [e.id, e.detected.name])).toEqual([
      ['grok', 'Grok'],
      ['aider', 'Aider CLI'],
    ]);
    expect(w.agent('aider:x')?.account).toBe('aider');
  });

  it('segredos no texto são mascarados', () => {
    const w = setup();
    w.ev({ event: 'activity', kind: 'run', text: 'curl', detail: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"' });
    expect(w.agent()?.activity?.detail).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('helpers', () => {
  it('toolDisplayName', () => {
    expect(toolDisplayName('grok')).toBe('Grok');
    expect(toolDisplayName('grok', ' Grok Bot ')).toBe('Grok Bot');
  });

  it('externalActivity: kind padrão other', () => {
    expect(externalActivity({ tool: 'grok', session: 's', event: 'activity', text: 'Fazendo algo' }, 'id', 1)).toMatchObject({ kind: 'other', icon: '🛠️' });
  });
});
