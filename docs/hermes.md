# Hermes no Habblaud (integração local)

Rode o Habblaud diretamente no macOS/Linux (`npm run build && npm start`), não no Docker. Ele detecta `~/.hermes/state.db` automaticamente; se usar outra pasta, defina `HERMES_HOME`. Para desligar: `HABBLAUD_HERMES=0 npm start`.

A conta Hermes aparece no escritório. Sessões CLI com projeto (`cwd` ou raiz Git) e metadados atualizados nos últimos 2 minutos aparecem; sessões encerradas e registros antigos sem processo confirmado não são tratados como ativos. O status `working` é indicado apenas quando houve resultado de ferramenta nos últimos 15 segundos. Isso é uma aproximação conservadora: o Hermes não associa PID a todas as sessões, então uma sessão ociosa há mais de 2 minutos desaparece mesmo que o terminal ainda esteja aberto. Uma nova atividade a traz de volta.

A integração abre o SQLite em modo somente leitura e consulta apenas id da sessão, origem, projeto, título, modelo, estatísticas, horário e nome da última ferramenta. Nunca consulta conteúdo de conversas, argumentos/resultados de ferramentas, senhas ou arquivos de credenciais. Não há, por enquanto, terminal de conversa, histórico de sessões Hermes, envio de mensagens, permissões nem suporte Docker. O Habblaud World não recebe agentes Hermes, pois o protocolo remoto só representa Claude/Codex.
