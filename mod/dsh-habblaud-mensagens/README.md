# dsh-habblaud-mensagens

Plugin (bundle) do DeepSeek Harness que leva para a sessão do DSH as mensagens digitadas no Habblaud — nos
detalhes do agente ou no rodapé do terminal. É o equivalente do `mod/habblaud-mensagens` do Claude Code, com o
mesmo protocolo (`POST /api/mod/inbox` e `/api/mod/inbox/ack` em `127.0.0.1`).

## Instalar

No DeepSeek Harness: **Plugins** > **Adicionar plugin** > pasta local, e escolha esta pasta
(`mod/dsh-habblaud-mensagens`). Depois de instalado, em até 2 s a caixa de mensagem acende para os agentes do DSH
no escritório.

Porta: 4747, ou a variável `HABBLAUD_PORT` do processo do DSH, ou `config.port` na linha do plugin.

## Como funciona

A cada 2 s, para cada sessão viva (`ctx.agents.list()`), pergunta ao Habblaud se há mensagens; cada uma entra na
fila da sessão por `ctx.sessionController.prompt({ mode: 'queue' })` (agente ocupado: entra quando ele terminar o
turno) e o resultado volta em um ack. Habblaud fora do ar: pergunta a cada 30 s.
