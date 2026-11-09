import { describe, expect, it } from 'vitest';
import { cleanKiroPrompt, cleanKiroTitle, describeKiroTool, parseKiroJsonlLine } from './parser';

const line = (kind: string, data: Record<string, unknown>) => JSON.stringify({ version: 'v1', kind, data });
const toolUse = (toolUseId: string, name: string, input: Record<string, unknown>) => ({ kind: 'toolUse', data: { toolUseId, name, input } });

describe('cleanKiroPrompt', () => {
  it('texto comum volta igual, inclusive começando com colchetes', () => {
    expect(cleanKiroPrompt('  arrume o bug do login ')).toBe('arrume o bug do login');
    expect(cleanKiroPrompt('[WIP] arrume o bug\nsegunda linha')).toBe('[WIP] arrume o bug\nsegunda linha');
  });

  it('tira o contexto do Kiro Crew (prompt do agente, regras e parágrafos de instrução)', () => {
    const crew = [
      '[AGENT SYSTEM PROMPT]',
      'Você é o agente X.',
      '[END AGENT SYSTEM PROMPT]',
      '[CRITICAL RULES -- always follow these]',
      'regras',
      '[END CRITICAL RULES]',
      '[CURRENT DATE] 2026-11-05',
      '[RUNTIME] KiroCrew dashboard',
      '[REPLY FORMAT RULES]',
      '',
      '(If presenting choices, end with OPTIONS.)',
      '',
      '(The ask_question tool shows a card.)',
      'veja os logs do gateway',
    ].join('\n');
    expect(cleanKiroPrompt(crew)).toBe('veja os logs do gateway');
  });

  it('formato novo: o pedido depois de [CURRENT USER REQUEST ...], sem o EnvironmentContext', () => {
    const crew = '[RUNTIME] x\n[REPLY FORMAT RULES]\n(regra)[CURRENT USER REQUEST -- respond to this]\nsuba o deploy\n<EnvironmentContext>\narquivos\n</EnvironmentContext>';
    expect(cleanKiroPrompt(crew)).toBe('suba o deploy');
  });

  it('título do .json com o contexto injetado vira undefined (quem chama usa o prompt)', () => {
    expect(cleanKiroTitle('[AGENT SYSTEM PROMPT]')).toBeUndefined();
    expect(cleanKiroTitle('  Revisando o parser ')).toBe('Revisando o parser');
    expect(cleanKiroTitle(undefined)).toBeUndefined();
  });
});

describe('describeKiroTool', () => {
  it('read: um arquivo, pasta e vários arquivos', () => {
    expect(describeKiroTool('read', { operations: [{ mode: 'Line', path: '/r/src/app.ts' }] })).toMatchObject({ kind: 'read', text: 'Lendo app.ts' });
    expect(describeKiroTool('read', { operations: [{ mode: 'Directory', path: '/r/src' }] }).kind).toBe('read');
    const many = describeKiroTool('read', { operations: [{ mode: 'Line', path: '/a.ts' }, { mode: 'Line', path: '/b.ts' }] });
    expect(many.text).toBe('Lendo 2 arquivos');
    expect(many.detail).toBe('/a.ts, /b.ts');
  });

  it('write: create escreve, strReplace edita', () => {
    expect(describeKiroTool('write', { command: 'create', path: '/r/novo.md', content: 'x' })).toMatchObject({ kind: 'write', text: 'Escrevendo novo.md' });
    expect(describeKiroTool('write', { command: 'strReplace', path: '/r/app.ts', oldStr: 'a', newStr: 'b' })).toMatchObject({ kind: 'edit', text: 'Editando app.ts' });
  });

  it('glob, grep, web_fetch, web_search, todo_list, subagent, summary, introspect', () => {
    expect(describeKiroTool('glob', { pattern: '**/*.ts' }).kind).toBe('search');
    expect(describeKiroTool('grep', { pattern: 'TODO' }).text).toContain('TODO');
    expect(describeKiroTool('web_fetch', { url: 'https://kiro.dev/docs' })).toMatchObject({ kind: 'web', text: 'Lendo kiro.dev' });
    expect(describeKiroTool('web_search', { query: 'kiro hooks' }).kind).toBe('web');
    expect(describeKiroTool('todo_list', { command: 'create' }).kind).toBe('plan');
    expect(describeKiroTool('subagent', { task: 'revisar o PR' }).kind).toBe('delegate');
    expect(describeKiroTool('summary', { taskResult: 'ok' }).kind).toBe('communicate');
    expect(describeKiroTool('introspect', { query: 'hooks' }).text).toBe('Consultando a documentação do Kiro');
  });

  it('use_aws mostra serviço e operação; o perfil e a região vão no detalhe', () => {
    const d = describeKiroTool('use_aws', { service_name: 's3', operation_name: 'list-objects-v2', profile_name: 'dev', region: 'us-east-1' });
    expect(d).toMatchObject({ kind: 'run', text: 'AWS: s3 list objects v2', detail: 'dev · us-east-1' });
  });

  it('MCP: GitHub pelo nome + owner/repo, servidor das permissões da sessão, e o resto genérico', () => {
    expect(describeKiroTool('get_file_contents', { owner: 'o', repo: 'r', path: 'a' })).toMatchObject({ kind: 'mcp', text: 'GitHub: get file contents' });
    expect(describeKiroTool('search_tickets', { q: 'x' }, new Map([['search_tickets', 'jira']]))).toMatchObject({ kind: 'mcp', text: 'jira: search tickets' });
    expect(describeKiroTool('@slack/post_message', {})).toMatchObject({ kind: 'mcp', text: 'slack: post message' });
    expect(describeKiroTool('ferramenta_x', {}).text).toBe('Usando ferramenta_x');
  });

  it('o "para quê" vai para o detalhe, e segredos do comando são mascarados', () => {
    const d = describeKiroTool('shell', { command: 'curl -H "Authorization: Bearer abcdef123456" https://api.x', __tool_use_purpose: 'Chamar a API' });
    expect(d.detail).toContain('Chamar a API');
    expect(d.detail).not.toContain('abcdef123456');
  });
});

describe('parseKiroJsonlLine', () => {
  it('várias toolUse na mesma mensagem viram várias atividades (ids com o prefixo da sessão)', () => {
    const p = parseKiroJsonlLine(
      line('AssistantMessage', {
        message_id: 'm1',
        content: [{ kind: 'thinking', data: { text: '' } }, { kind: 'text', data: '' }, toolUse('t1', 'read', { operations: [{ mode: 'Line', path: '/a.ts' }] }), toolUse('t2', 'shell', { command: 'git status' })],
      }),
      1,
      5000,
      { idPrefix: 'sess' },
    );
    expect(p?.status).toBe('working');
    expect(p?.activities.map((a) => a.id)).toEqual(['sess#t1', 'sess#t2']);
    expect(p?.activities.map((a) => a.tool)).toEqual(['read', 'shell']);
    expect(p?.tools?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(p?.command).toBe('git status');
    expect(p?.activities.every((a) => a.at === 5000)).toBe(true);
  });

  it('resposta final (thinking + texto, sem toolUse) fica idle e fecha o turno', () => {
    const p = parseKiroJsonlLine(line('AssistantMessage', { message_id: 'm2', content: [{ kind: 'thinking', data: { text: 'hm' } }, { kind: 'text', data: 'Pronto.' }] }), 2, 1);
    expect(p).toMatchObject({ status: 'idle', turnEnd: true, messageId: 'm2' });
    expect(p?.activity?.kind).toBe('respond');
  });

  it('Prompt do Kiro Crew: o texto limpo e o horário de meta.timestamp', () => {
    const text = '[AGENT SYSTEM PROMPT]\nx\n[END AGENT SYSTEM PROMPT]\n[REPLY FORMAT RULES]\n(regra)\nmostre o status';
    const p = parseKiroJsonlLine(line('Prompt', { message_id: 'm0', content: [{ kind: 'text', data: text }], meta: { timestamp: 1793887397 } }), 1, 1);
    expect(p?.promptText).toBe('mostre o status');
    expect(p?.promptAt).toBe(1793887397000);
    expect(p?.activity?.detail).toBe('mostre o status');
  });

  it('segredo no prompt não vai para o detalhe', () => {
    const p = parseKiroJsonlLine(line('Prompt', { content: [{ kind: 'text', data: 'use o token ghp_abcdefghijklmnopqrstuvwx' }] }), 1, 1);
    expect(p?.activity?.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
  });

  it('ToolResults: ids respondidos e erro pelo status', () => {
    const p = parseKiroJsonlLine(
      line('ToolResults', {
        content: [
          { kind: 'toolResult', data: { toolUseId: 't1', status: 'Success', content: [] } },
          { kind: 'toolResult', data: { toolUseId: 't2', status: 'Error', content: [] } },
        ],
      }),
      3,
      1,
    );
    expect(p?.results).toEqual([
      { id: 't1', error: false },
      { id: 't2', error: true },
    ]);
    expect(p?.status).toBe('working');
  });

  it('Compaction e Clear', () => {
    expect(parseKiroJsonlLine(line('Compaction', {}), 1, 1)?.activity?.kind).toBe('compact');
    expect(parseKiroJsonlLine(line('Clear', {}), 2, 1)).toMatchObject({ status: 'idle', turnEnd: true });
  });
});
