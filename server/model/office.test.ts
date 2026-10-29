import { describe, expect, it } from 'vitest';
import { nameKey } from '../../shared/appearance';
import { NAME_POOL, nameFromType } from '../../shared/names';
import { setQuiet } from '../log';
import { subagentTypeOf } from '../sources/subagents';
import { NameStore } from './names';
import { Office } from './office';

setQuiet(true);

function makeOffice() {
  let clock = 1_000_000;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: clock,
    accounts: (s) => [{ id: 'acc', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '/x', sessions: s.get('acc') ?? 0, usageStatus: 'disabled' }],
    sources: () => [],
    accountName: () => 'Conta C',
    now: () => clock,
  });
  const now = () => clock;
  office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
  const addSub = (id: string, subagentType?: string) =>
    office.addSub({ id, parentId: 'acc:1', sessionId: 's1', role: subagentType ?? 'Subagente', subagentType, background: false, startedAt: now() });
  const nameOf = (id: string) => office.get(id)!.name;
  return { office, addSub, nameOf, advance: (ms: number) => (clock += ms) };
}

const inPool = (name: string) => NAME_POOL.some((p) => nameKey(p.name) === nameKey(name));

describe('nome do subagente a partir do tipo', () => {
  it('o tipo vira o nome do personagem', () => {
    const { addSub, nameOf } = makeOffice();
    addSub('s1:a', 'code-reviewer');
    addSub('s1:b', 'revisor');
    expect(nameOf('s1:a')).toBe('Code Reviewer');
    expect(nameOf('s1:b')).toBe('Revisor');
  });

  it('dois do mesmo tipo ao mesmo tempo: sufixo numérico, como no sorteio', () => {
    const { addSub, nameOf } = makeOffice();
    addSub('s1:a', 'revisor');
    addSub('s1:b', 'revisor');
    addSub('s1:c', 'revisor');
    expect([nameOf('s1:a'), nameOf('s1:b'), nameOf('s1:c')]).toEqual(['Revisor', 'Revisor 2', 'Revisor 3']);
  });

  it('o nome do tipo não rouba um nome já em uso no escritório', () => {
    const { office, addSub, nameOf } = makeOffice();
    const taken = nameOf('acc:1');
    expect(inPool(taken)).toBe(true);
    addSub('s1:a', taken.toLowerCase());
    expect(nameOf('s1:a')).toBe(`${taken} 2`);
    expect(office.get('acc:1')!.name).toBe(taken);
  });

  it('sem tipo, continua o sorteio de sempre', () => {
    const { addSub, nameOf } = makeOffice();
    addSub('s1:a');
    expect(inPool(nameOf('s1:a'))).toBe(true);
  });

  it('tipo que não dá nome válido cai no sorteio', () => {
    const { addSub, nameOf } = makeOffice();
    addSub('s1:a', '---');
    addSub('s1:b', 'um-tipo-com-nome-exageradamente-comprido');
    expect(inPool(nameOf('s1:a'))).toBe(true);
    expect(inPool(nameOf('s1:b'))).toBe(true);
  });
});

describe('nameFromType', () => {
  it('separa por pontuação e capitaliza cada palavra', () => {
    expect(nameFromType('code-reviewer')?.name).toBe('Code Reviewer');
    expect(nameFromType('code_reviewer')?.name).toBe('Code Reviewer');
    expect(nameFromType('  revisor  ')?.name).toBe('Revisor');
  });

  it('a dica visual do pool vale quando o nome é um dos de lá, e é estável', () => {
    const pooled = NAME_POOL[0];
    expect(nameFromType(pooled.name.toLowerCase())).toEqual({ name: pooled.name, look: pooled.look });
    expect(nameFromType('code-reviewer')).toEqual(nameFromType('code-reviewer'));
  });

  it('null quando não serve como nome de personagem', () => {
    expect(nameFromType('')).toBeNull();
    expect(nameFromType('---')).toBeNull();
    // Acima de NAME_MAX (24).
    expect(nameFromType('um-tipo-com-nome-exageradamente-comprido')).toBeNull();
  });
});

describe('subagentTypeOf', () => {
  it('o tipo do meta vence o da chamada; sem tipo e workflow ficam de fora', () => {
    expect(subagentTypeOf({ agentType: 'code-reviewer' }, 'explore')).toBe('code-reviewer');
    expect(subagentTypeOf(undefined, 'explore')).toBe('explore');
    expect(subagentTypeOf(undefined, undefined)).toBeUndefined();
    expect(subagentTypeOf({ agentType: 'workflow-subagent' }, undefined)).toBeUndefined();
  });
});
