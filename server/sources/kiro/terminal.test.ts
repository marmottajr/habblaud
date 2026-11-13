import { describe, expect, it } from 'vitest';
import { KiroTerminalParser } from './terminal';

describe('KiroTerminalParser', () => {
  it('ignora linhas vazias ou inválidas', () => {
    const parser = new KiroTerminalParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push('   ')).toEqual([]);
    expect(parser.push('{')).toEqual([]);
    expect(parser.push('{"kind": "Unknown"}')).toEqual([]);
  });

  it('converte evento Prompt em TerminalEntry de user', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'Prompt',
      data: {
        content: [{ kind: 'text', data: 'Explique a arquitetura do projeto' }],
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('user');
    if (entries[0].kind === 'user') {
      expect(entries[0].text).toBe('Explique a arquitetura do projeto');
    }
  });

  it('converte evento AssistantMessage com thinking, toolUse e text', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'AssistantMessage',
      data: {
        content: [
          { kind: 'thinking', data: { text: 'Analisando o código fonte...' } },
          {
            kind: 'toolUse',
            data: {
              toolUseId: 'call_abc',
              name: 'shell',
              input: { command: 'git status' },
            },
          },
          { kind: 'text', data: 'O repositório está limpo.' },
        ],
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(3);

    expect(entries[0].kind).toBe('thinking');
    if (entries[0].kind === 'thinking') {
      expect(entries[0].text).toBe('Analisando o código fonte...');
    }

    expect(entries[1].kind).toBe('tool');
    if (entries[1].kind === 'tool') {
      expect(entries[1].tool).toBe('shell');
      expect(entries[1].title).toBe('shell(git status)');
    }

    expect(entries[2].kind).toBe('assistant');
    if (entries[2].kind === 'assistant') {
      expect(entries[2].text).toBe('O repositório está limpo.');
    }
  });

  it('converte evento ToolResults em TerminalEntry de result com máscara de segredos', () => {
    const parser = new KiroTerminalParser();
    const line = JSON.stringify({
      version: 'v1',
      kind: 'ToolResults',
      data: {
        toolUseId: 'call_abc',
        content: [{ kind: 'text', data: 'Authorization: Bearer secret_token_123456\nArquivos prontos.' }],
        isError: false,
      },
    });

    const entries = parser.push(line);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe('result');
    if (entries[0].kind === 'result') {
      expect(entries[0].toolUseId).toBe('call_abc');
      expect(entries[0].text).toContain('Authorization: ***');
      expect(entries[0].text).not.toContain('secret_token_123456');
    }
  });

  describe('formato 3.x ({id, timestamp, payload})', () => {
    const T = '2026-01-02T03:04:05.000Z';
    const AT = Date.parse(T);
    let n = 0;
    const v3 = (payload: Record<string, unknown>) => JSON.stringify({ id: `msg-${++n}`, timestamp: T, payload });

    it('user vira prompt com o horário da linha; vazio é ignorado', () => {
      const p = new KiroTerminalParser();
      const [e] = p.push(v3({ type: 'user', content: 'Rode os testes', documents: [], images: [] }));
      expect(e).toMatchObject({ kind: 'user', text: 'Rode os testes', at: AT });
      expect(p.push(v3({ type: 'user', content: '   ' }))).toEqual([]);
    });

    it('assistant Say vira resposta, Reasoning vira pensamento, vazio é ignorado', () => {
      const p = new KiroTerminalParser();
      expect(p.push(v3({ type: 'assistant', content: 'Pronto.', operationType: 'Say' }))[0]).toMatchObject({ kind: 'assistant', text: 'Pronto.', at: AT });
      expect(p.push(v3({ type: 'assistant', content: 'Pensando no plano', operationType: 'Reasoning' }))[0]).toMatchObject({ kind: 'thinking', text: 'Pensando no plano', at: AT });
      expect(p.push(v3({ type: 'assistant', content: '', operationType: 'Reasoning', reasoningSignature: 'x' }))).toEqual([]);
      expect(p.push(v3({ type: 'assistant', content: '', operationType: 'Say' }))).toEqual([]);
    });

    it('tool_call usa o toolCallId e a visão do Claude (Bash, Write, Edit, Read, genérica)', () => {
      const p = new KiroTerminalParser();
      const bash = p.push(v3({ type: 'tool_call', toolCallId: 'tc-1', toolName: 'execute_bash', args: { command: 'npm test', run_in_background: false }, title: 'Rodar' }))[0];
      expect(bash).toMatchObject({ kind: 'tool', id: 'tc-1', tool: 'execute_bash', title: 'Bash(npm test)', at: AT });
      if (bash.kind === 'tool') expect(bash.inputKind).toBe('command');

      const shell = p.push(v3({ type: 'tool_call', toolCallId: 'tc-1b', toolName: 'shell', args: { command: 'ls' } }))[0];
      expect(shell).toMatchObject({ title: 'Bash(ls)' });

      const write = p.push(v3({ type: 'tool_call', toolCallId: 'tc-2', toolName: 'fs_write', args: { path: '/tmp/x/a.txt', text: 'linha nova' } }))[0];
      expect(write.kind).toBe('tool');
      if (write.kind === 'tool') {
        expect(write.title).toMatch(/^Write\(.*a\.txt\)$/);
        expect(write.inputKind).toBe('diff');
        expect(write.input).toContain('linha nova');
      }

      const edit = p.push(v3({ type: 'tool_call', toolCallId: 'tc-3', toolName: 'str_replace', args: { path: '/tmp/x/b.ts', oldStr: 'antigo', newStr: 'novo', replace_all: false } }))[0];
      if (edit.kind === 'tool') {
        expect(edit.title).toMatch(/^Edit\(.*b\.ts\)$/);
        expect(edit.input).toContain('antigo');
        expect(edit.input).toContain('novo');
      } else throw new Error('esperava tool');

      // hook manda old_str/new_str: também vale
      const edit2 = p.push(v3({ type: 'tool_call', toolCallId: 'tc-3b', toolName: 'str_replace', args: { path: '/tmp/x/b.ts', old_str: 'aaa', new_str: 'bbb' } }))[0];
      if (edit2.kind === 'tool') expect(edit2.input).toContain('bbb');

      for (const name of ['read_file', 'readFile', 'read']) {
        const r = p.push(v3({ type: 'tool_call', toolCallId: `r-${name}`, toolName: name, args: { path: '/tmp/x/c.md' } }))[0];
        expect(r.kind === 'tool' && r.title).toMatch(/^Read\(.*c\.md\)$/);
      }

      const many = p.push(v3({ type: 'tool_call', toolCallId: 'tc-4', toolName: 'read_files', args: { paths: ['/tmp/a', '/tmp/b'] } }))[0];
      expect(many).toMatchObject({ kind: 'tool', id: 'tc-4', tool: 'read_files' });
      if (many.kind === 'tool') expect(many.title.startsWith('read_files')).toBe(true);
    });

    it('tool_result vira result ligado ao toolCallId, com erro e segredo mascarado', () => {
      const p = new KiroTerminalParser();
      const ok = p.push(v3({ type: 'tool_result', toolCallId: 'tc-1', content: 'Authorization: Bearer fake_token_abcdef123456\nok', success: true }))[0];
      expect(ok).toMatchObject({ kind: 'result', toolUseId: 'tc-1', at: AT });
      if (ok.kind === 'result') {
        expect(ok.error).toBeUndefined();
        expect(ok.text).toContain('Authorization: ***');
        expect(ok.text).not.toContain('fake_token_abcdef123456');
      }
      const bad = p.push(v3({ type: 'tool_result', toolCallId: 'tc-2', content: 'falhou', success: false }))[0];
      expect(bad).toMatchObject({ kind: 'result', toolUseId: 'tc-2', error: true });
    });

    it('pending_interaction de aprovação vira aviso do sistema', () => {
      const p = new KiroTerminalParser();
      const [e] = p.push(v3({ type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc-1', question: 'Permitir execute_bash?', options: [] }));
      expect(e).toMatchObject({ kind: 'system', level: 'warn', text: 'Esperando aprovação', detail: 'Permitir execute_bash?', at: AT });
      expect(p.push(v3({ type: 'pending_interaction', interactionType: 'outra' }))).toEqual([]);
    });

    it('subagente vira Agent(...) + resultado ligados pelo subSessionId', () => {
      const p = new KiroTerminalParser();
      const [t] = p.push(v3({ type: 'sub_agent_start', parentExecutionId: 'e', subSessionId: 'sub-1', subAgentName: 'revisor', prompt: 'Revise', explanation: 'revisar PR' }));
      expect(t).toMatchObject({ kind: 'tool', id: 'kiro-sub-sub-1', tool: 'Agent', title: 'Agent(revisor: revisar PR)' });
      const [r] = p.push(v3({ type: 'sub_agent_complete', parentExecutionId: 'e', subSessionId: 'sub-1', response: '', status: 'error', errorMessage: 'caiu' }));
      expect(r).toMatchObject({ kind: 'result', toolUseId: 'kiro-sub-sub-1', text: 'caiu', error: true });
    });

    it('ignora eventos sem conteúdo de conversa e lixo', () => {
      const p = new KiroTerminalParser();
      for (const type of ['session_metadata', 'ContextualHookInvoked', 'turn_start', 'turn_end', 'usage_summary', 'session_event', 'steering_inclusion', 'agent_note', 'interaction_resolved']) {
        expect(p.push(v3({ type }))).toEqual([]);
      }
      expect(p.push('lixo {"payload"')).toEqual([]);
      expect(p.push('null')).toEqual([]);
      expect(p.push('[1,2]')).toEqual([]);
      expect(p.push(JSON.stringify({ payload: 'texto' }))).toEqual([]);
    });

    it('timestamp inválido cai no relógio; 2.x e 3.x misturados no mesmo parser', () => {
      const p = new KiroTerminalParser();
      const before = Date.now();
      const [e] = p.push(JSON.stringify({ id: 'x', timestamp: 'nada', payload: { type: 'user', content: 'oi' } }));
      expect(e.at).toBeGreaterThanOrEqual(before);
      const [old] = p.push(JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: 'formato antigo' }], meta: { timestamp: 1700000000 } } }));
      expect(old).toMatchObject({ kind: 'user', text: 'formato antigo', at: 1700000000000 });
      const [neo] = p.push(v3({ type: 'user', content: 'formato novo' }));
      expect(neo).toMatchObject({ kind: 'user', text: 'formato novo', at: AT });
      expect(neo.id).not.toBe(old.id);
    });
  });
});
