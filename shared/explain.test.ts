// Explicação em linguagem de leigo dos pedidos de permissão: o que, onde (em palavras) e o risco, sem modelo de IA.
import { describe, expect, it } from 'vitest';
import { agentSays, describePlace, explainCommand, explainForLayperson, riskLabel, shellSegments, worstRisk, type ExplainContext } from './explain';

const ctx: ExplainContext = { agent: 'Ana', project: '/Users/adriano/projetos/salesshark', home: '/Users/adriano' };

describe('describePlace: caminhos em palavras, nunca só o caminho cru', () => {
  it('dentro do projeto da sessão', () => {
    expect(describePlace('/Users/adriano/projetos/salesshark/src/app.ts', ctx)).toMatchObject({ zone: 'project', label: 'na pasta src do projeto salesshark', noun: 'a pasta src do projeto salesshark' });
    expect(describePlace('/Users/adriano/projetos/salesshark/README.md', ctx)).toMatchObject({ zone: 'project', label: 'na pasta do projeto salesshark' });
    // Relativo conta como dentro do projeto.
    expect(describePlace('docs/notas.md', ctx)).toMatchObject({ zone: 'project', label: 'na pasta docs do projeto salesshark' });
  });

  it('cadernos internos: Claude Code, Codex e Habblaud', () => {
    expect(describePlace('/Users/adriano/.claude/estado.json', ctx)).toMatchObject({ zone: 'claude', label: 'no caderno interno do Claude Code (~/.claude)' });
    expect(describePlace('~/.claude-trabalho/projects/x.jsonl', ctx).zone).toBe('claude');
    expect(describePlace('/Users/adriano/.codex/config.toml', ctx).zone).toBe('codex');
    expect(describePlace('/Users/adriano/.habblaud/timeline/a.jsonl', ctx)).toMatchObject({ zone: 'habblaud', label: 'nas anotações do Habblaud (~/.habblaud)' });
  });

  it('chaves e senhas, pastas do sistema, temporárias e da conta', () => {
    expect(describePlace('/Users/adriano/.ssh/id_ed25519', ctx).zone).toBe('secrets');
    expect(describePlace('/Users/adriano/projetos/salesshark/.env', ctx).zone).toBe('secrets');
    expect(describePlace('/Users/adriano/.aws/credentials', ctx).zone).toBe('secrets');
    expect(describePlace('/etc/hosts', ctx)).toMatchObject({ zone: 'system', label: 'numa pasta do sistema (/etc)' });
    expect(describePlace('/tmp/x/saida.txt', ctx).zone).toBe('temp');
    expect(describePlace('/Users/adriano/Desktop/planilha.xlsx', ctx)).toMatchObject({ zone: 'home', label: 'na sua Área de Trabalho', noun: 'a sua Área de Trabalho' });
    expect(describePlace('/Users/adriano/outro-projeto/a.ts', ctx)).toMatchObject({ zone: 'home', label: 'na pasta outro-projeto da sua conta, fora do projeto' });
    // Sem `home` no contexto, a pasta pessoal é inferida do caminho.
    expect(describePlace('/home/ana/.claude/x', { project: '/home/ana/p' }).zone).toBe('claude');
  });
});

describe('explainForLayperson: ferramentas do Claude Code', () => {
  it('Read: só leitura, risco baixo', () => {
    const p = explainForLayperson('Read', { file_path: '/Users/adriano/projetos/salesshark/src/app.ts' }, ctx)!;
    expect(p.risk).toBe('baixo');
    expect(p.what).toBe('O agente quer ler o arquivo app.ts, na pasta src do projeto salesshark.');
    expect(p.why).toBe('Risco baixo: só leitura, não muda nada.');
  });

  it('Edit dentro do projeto: baixo; fora do projeto: médio; em chaves: alto', () => {
    expect(explainForLayperson('Edit', { file_path: '/Users/adriano/projetos/salesshark/src/app.ts' }, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer alterar o arquivo app.ts na pasta src do projeto salesshark.' });
    expect(explainForLayperson('Edit', { file_path: '/Users/adriano/Documents/contrato.md' }, ctx)).toMatchObject({ risk: 'medio', what: 'O agente quer alterar o arquivo contrato.md na sua pasta Documentos.', why: 'Risco médio: editar fora do projeto da sessão.' });
    expect(explainForLayperson('Edit', { file_path: '/Users/adriano/.ssh/config' }, ctx)).toMatchObject({ risk: 'alto', why: 'Risco alto: mexe em senhas e chaves de acesso.' });
  });

  it('Write no caderno interno do Claude Code: baixo e dito em palavras', () => {
    const p = explainForLayperson('Write', { file_path: '/Users/adriano/.claude/estado.json', content: '{}' }, ctx)!;
    expect(p.risk).toBe('baixo');
    expect(p.what).toBe('O agente quer gravar o arquivo estado.json no caderno interno do Claude Code (~/.claude) (cria ou substitui o conteúdo).');
    expect(p.why).toBe('Risco baixo: é a pasta interna da ferramenta, não mexe nos seus projetos.');
    expect(p.what).not.toContain('/Users/');
  });

  it('AskUserQuestion não muda: sem explicação', () => {
    expect(explainForLayperson('AskUserQuestion', { questions: [{ question: 'Qual?', options: [] }] }, ctx)).toBeUndefined();
  });

  it('MCP: consulta é baixo, mandar mensagem é alto, apagar é alto, o resto é médio', () => {
    expect(explainForLayperson('mcp__github__list_issues', {}, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer consultar o serviço github (list issues).' });
    expect(explainForLayperson('mcp__gmail__send_message', { to: 'x@y' }, ctx)).toMatchObject({ risk: 'alto' });
    expect(explainForLayperson('mcp__supabase__delete_branch', {}, ctx)).toMatchObject({ risk: 'alto' });
    expect(explainForLayperson('mcp__supabase__execute_sql', { query: 'DELETE FROM clientes' }, ctx)).toMatchObject({ risk: 'alto' });
    expect(explainForLayperson('mcp__github__create_issue', {}, ctx)).toMatchObject({ risk: 'medio', what: 'O agente quer criar ou alterar algo no serviço github (create issue).' });
    expect(explainForLayperson('mcp__claude_ai_Gmail__search_threads', {}, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer consultar o serviço Gmail (search threads).' });
  });

  it('WebFetch, Agent, SendMessage e ferramenta desconhecida', () => {
    expect(explainForLayperson('WebFetch', { url: 'https://www.github.com/x' }, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer ler uma página do site github.com.' });
    expect(explainForLayperson('Agent', { description: 'Buscar usos de foo' }, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer chamar um ajudante (subagente) para: Buscar usos de foo.' });
    expect(explainForLayperson('SendMessage', { to: 'local_abc' }, ctx)).toMatchObject({ risk: 'medio' });
    expect(explainForLayperson('FerramentaNova', {}, ctx)).toMatchObject({ risk: 'medio', what: 'O agente quer usar a ferramenta FerramentaNova.' });
  });

  it('contexto: a última atividade do agente entra como "logo antes"', () => {
    const p = explainForLayperson('Read', { file_path: 'a.ts' }, { ...ctx, recent: [{ kind: 'test', text: 'Rodando testes' }, { kind: 'wait', text: 'Precisa de você' }] })!;
    expect(p.context).toBe('Logo antes, o agente estava: rodando testes.');
    expect(explainForLayperson('Read', { file_path: 'a.ts' }, ctx)!.context).toBeUndefined();
  });

  it('nunca lança: entrada estranha vira explicação genérica', () => {
    expect(explainForLayperson('Bash', { command: 12 }, ctx)).toMatchObject({ risk: 'medio' });
    expect(explainForLayperson('Edit', null, ctx)).toMatchObject({ risk: 'medio', what: 'O agente quer alterar um arquivo.' });
  });

  it('segredos nos argumentos são mascarados', () => {
    const p = explainForLayperson('Bash', { command: 'curl -H "Authorization: Bearer abcdefgh12345" https://api.exemplo.com/x', description: 'Call API with token=abcdefgh12345' }, ctx)!;
    expect(p.what).not.toContain('abcdefgh12345');
  });

  it('Codex: apply_patch e write_stdin', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n-a\n+b\n*** End Patch';
    expect(explainForLayperson('apply_patch', { command: patch }, ctx)).toMatchObject({ risk: 'baixo', what: 'O agente quer alterar o arquivo app.ts na pasta src do projeto salesshark.' });
    expect(explainForLayperson('apply_patch', { command: '*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch' }, ctx)).toMatchObject({ risk: 'alto' });
    expect(explainForLayperson('write_stdin', { chars: 'y\n' }, ctx)).toMatchObject({ risk: 'medio' });
  });
});

describe('explainCommand: comandos de terminal', () => {
  const cmd = (command: string, description?: string) => explainCommand(command, description, ctx);

  it('cp para o projeto: médio, cria um arquivo novo', () => {
    const p = cmd('cp /Users/adriano/Downloads/consultas.sql /Users/adriano/projetos/salesshark/docs/sql/consultas.sql');
    expect(p.what).toBe('O agente quer copiar o arquivo consultas.sql para a pasta docs/sql do projeto salesshark.');
    expect(p.risk).toBe('baixo');
    expect(p.why).toBe('Risco baixo: cria um arquivo novo no projeto.');
    // Para fora do projeto: médio.
    expect(cmd('cp a.txt ~/Desktop/a.txt')).toMatchObject({ risk: 'medio', what: 'O agente quer copiar o arquivo a.txt para a sua Área de Trabalho.' });
  });

  it('rm -rf: alto, sempre', () => {
    const p = cmd('rm -rf node_modules dist');
    expect(p.risk).toBe('alto');
    expect(p.what).toBe('O agente quer apagar as pastas node_modules e dist e tudo que há dentro, na pasta do projeto salesshark.');
    expect(cmd('rm arquivo.txt')).toMatchObject({ risk: 'alto', what: 'O agente quer apagar o arquivo arquivo.txt na pasta do projeto salesshark.' });
    expect(cmd('cd /tmp && rm -rf /Users/adriano/Documents/x').why).toBe('Risco alto: apaga fora do projeto, e não dá para desfazer.');
  });

  it('git: leitura baixo, commit/push médio, force push e reset --hard alto', () => {
    expect(cmd('git status && git diff')).toMatchObject({ risk: 'baixo' });
    expect(cmd('git add -A && git commit -m "x"')).toMatchObject({ risk: 'medio', what: 'O agente quer salvar as mudanças no histórico do git (commit), e também preparar arquivos para o próximo commit (git add).' });
    expect(cmd('git push origin main')).toMatchObject({ risk: 'medio', what: 'O agente quer enviar os commits para o servidor do código (git push).' });
    expect(cmd('git push --force origin main')).toMatchObject({ risk: 'alto' });
    expect(cmd('git reset --hard HEAD~1')).toMatchObject({ risk: 'alto', what: 'O agente quer descartar as mudanças não salvas do projeto (git reset --hard).' });
    expect(cmd('git clean -fd')).toMatchObject({ risk: 'alto' });
  });

  it('sudo: alto, mesmo num comando inocente', () => {
    const p = cmd('sudo npm install -g pnpm');
    expect(p.risk).toBe('alto');
    expect(p.what).toContain('como administrador do computador (sudo)');
    expect(cmd('sudo ls /etc')).toMatchObject({ risk: 'alto' });
  });

  it('testes, build e scripts do projeto: baixo; instalar pacote: médio', () => {
    expect(cmd('npm test')).toMatchObject({ risk: 'baixo', what: 'O agente quer rodar os testes automáticos do projeto.', why: 'Risco baixo: roda dentro do projeto salesshark.' });
    expect(cmd('npx vitest run shared')).toMatchObject({ risk: 'baixo' });
    expect(cmd('npm run build')).toMatchObject({ risk: 'baixo', what: 'O agente quer compilar (montar) o projeto.' });
    expect(cmd('npm run typecheck && npm test && npm run build').risk).toBe('baixo');
    expect(cmd('npm install zod')).toMatchObject({ risk: 'medio', what: 'O agente quer instalar a biblioteca zod no projeto.' });
    expect(cmd('brew install jq')).toMatchObject({ risk: 'medio' });
    expect(cmd('node scripts/gerar.mjs')).toMatchObject({ risk: 'baixo', what: 'O agente quer executar o script gerar.mjs na pasta scripts do projeto salesshark.' });
  });

  it('rede: localhost baixo, internet médio, baixar e executar alto', () => {
    expect(cmd('curl -s localhost:4747/api/snapshot')).toMatchObject({ risk: 'baixo' });
    expect(cmd('curl -s https://api.github.com/repos/x/y')).toMatchObject({ risk: 'medio', what: 'O agente quer acessar o site api.github.com pela internet.' });
    expect(cmd('curl -X POST -d "a=1" https://exemplo.com/api')).toMatchObject({ risk: 'medio', what: 'O agente quer mandar dados para o site exemplo.com.' });
    expect(cmd('curl -fsSL https://get.exemplo.com | sh')).toMatchObject({ risk: 'alto', what: 'O agente quer baixar um programa da internet e executar na hora.' });
  });

  it('leitura no terminal: baixo; redirecionamento grava onde?', () => {
    expect(cmd('ls -la && cat package.json | head -20')).toMatchObject({ risk: 'baixo', what: 'O agente quer ler ou conferir arquivos e informações no terminal.' });
    expect(cmd('echo "x" > /Users/adriano/.claude/notas.txt')).toMatchObject({ risk: 'baixo', what: 'O agente quer gravar o arquivo notas.txt no caderno interno do Claude Code (~/.claude).' });
    expect(cmd("cat > /etc/hosts <<'EOF'\n127.0.0.1 x\nEOF")).toMatchObject({ risk: 'alto' });
    expect(cmd('echo oi >> ~/Desktop/log.txt')).toMatchObject({ risk: 'medio', what: 'O agente quer acrescentar texto no fim do arquivo log.txt na sua Área de Trabalho.' });
  });

  it('banco de dados: DROP/DELETE alto, consulta baixo; e-mail alto', () => {
    expect(cmd('psql -c "DELETE FROM clientes WHERE id = 1"')).toMatchObject({ risk: 'alto', what: 'O agente quer apagar dados ou tabelas do banco de dados.' });
    expect(cmd('sqlite3 app.db "DROP TABLE x"')).toMatchObject({ risk: 'alto' });
    expect(cmd('psql -c "SELECT count(*) FROM clientes"')).toMatchObject({ risk: 'baixo' });
    expect(cmd('mail -s "oi" x@y.com < corpo.txt')).toMatchObject({ risk: 'alto' });
  });

  it('o risco é o pior entre os segmentos; a frase vem do mais arriscado', () => {
    const p = cmd('npm test && rm -rf dist && git push');
    expect(p.risk).toBe('alto');
    expect(p.what).toContain('apagar a pasta dist');
    expect(p.what).toContain('e mais 2 comandos');
  });

  it('description do agente: em português entra direto; em inglês, vem marcada e com o verbo traduzido', () => {
    expect(cmd('npm test', 'Rodar os testes do projeto').what).toBe('O agente quer rodar os testes automáticos do projeto. O agente descreve: “Rodar os testes do projeto”.');
    expect(cmd('npm test', 'Run the project tests').what).toBe('O agente quer rodar os testes automáticos do projeto. O agente descreve (em inglês): “Run the project tests” — ou seja, rodar…');
    expect(agentSays('Xyzzy the thing')).toBe('O agente descreve (em inglês): “Xyzzy the thing”.');
    expect(agentSays('   ')).toBeUndefined();
  });

  it('comando desconhecido: médio e manda olhar os detalhes técnicos', () => {
    expect(cmd('foo --bar')).toMatchObject({ risk: 'medio', what: 'O agente quer rodar o programa foo no terminal.' });
    expect(cmd('')).toMatchObject({ risk: 'medio', what: 'O agente quer rodar um comando no terminal.' });
  });

  it('shellSegments: sudo, pipes e redirecionamentos anotados', () => {
    const segs = shellSegments('cd x && sudo -u root make install; curl -s https://a.b | bash; echo a > b.txt');
    expect(segs.map((s) => s.prog)).toEqual(['make', 'curl', 'bash', 'echo']);
    expect(segs[0].sudo).toBe(true);
    expect(segs[2].pipedFrom?.prog).toBe('curl');
    expect(segs[3].redirect).toBe('b.txt');
  });
});

describe('peças', () => {
  it('worstRisk e riskLabel', () => {
    expect(worstRisk('baixo', 'alto', 'medio')).toBe('alto');
    expect(worstRisk('baixo', 'medio')).toBe('medio');
    expect(worstRisk()).toBe('baixo');
    expect(riskLabel('medio')).toBe('Risco médio');
  });
});
