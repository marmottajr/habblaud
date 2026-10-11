---
name: escrever-funcao
description: Como escrever a função de um agente fixo a partir de uma descrição curta. Usada pelo comando `equipe` na primeira demanda de todo agente criado pela tela ("Novo agente") ou por `equipe agente`.
---

# Escrever a função de um agente fixo

Você recebeu uma descrição curta de um agente e vai transformá-la na **função** dele: o texto que ele lê no começo
de toda demanda. Um agente fixo não lembra de nada entre uma demanda e outra. Tudo o que ele sabe sobre o próprio
trabalho está nesse texto, no caderno dele e nos arquivos da pasta. Por isso a função precisa ser **específica o
bastante para ele acertar sozinho**, numa sessão nova, sem ninguém por perto para explicar.

Uma função boa responde a cinco perguntas: o que ele faz, com o que trabalha, como sabe que ficou bom, o que
entrega e onde ele para e pergunta.

## 1. Antes de escrever, olhe em volta

Não escreva de memória nem de imaginação. Leia, nesta ordem, o que existir:

1. A descrição que quem criou o agente deu. É a fonte da verdade: o que está nela entra; o que não está, não se inventa.
2. `.equipe/contexto.md`, `CLAUDE.md` e `README.md` da pasta: o que é o projeto, para quem, com que regras.
3. A lista de arquivos e pastas (dois níveis bastam). Abra os dois ou três arquivos que têm a ver com a função.
4. Os colegas em `.claude/agents/*.md`: quem já faz o quê. Função repetida vira briga; função vizinha vira passagem de trabalho.
5. `.equipe/memoria.md`, se existir: o que o time já aprendeu sobre o gosto e as decisões de quem pede.

Anote para você: quais arquivos e ferramentas reais este agente vai usar, quem entrega trabalho para ele e para
quem ele entrega.

## 2. As seções, nesta ordem

```
# <Função>

<Um parágrafo: quem ele é, para que existe e o que dá errado quando ele não faz o trabalho.>

## Sua função
## Como você trabalha
## O que você entrega
## Limites
```

Acrescente uma seção própria só quando a função tiver um assunto que mereça (por exemplo "Fontes e licenças" para
quem baixa material da internet). Não crie seção para encher.

### Sua função

- De três a seis tarefas, cada uma numa linha, começando pelo verbo: "Revisa…", "Monta…", "Confere…".
- Em seguida, **"Não é com você:"** e o que fica de fora. Essa lista evita mais erro do que a lista do que fazer:
  é o que impede o agente de avançar sobre o trabalho do colega ou sobre uma decisão que é de quem pede.
- Se a descrição diz que ele não faz algo, isso entra aqui com as palavras da descrição.

### Como você trabalha

- **Onde estão as coisas.** Caminhos reais, que você viu existir: a pasta de entrada, a de saída, o arquivo de
  regras, o modelo. Nunca cite arquivo que você não abriu.
- **O passo a passo**, numerado, do "ler o pedido" ao "gravar o resultado". De seis a dez passos. Inclua o passo
  de conferir o próprio trabalho antes de entregar.
- **O padrão de qualidade**: o que faz um resultado ser aceito. Critérios que dá para conferir ("frases de até
  duas linhas", "todo número com a fonte ao lado"), não adjetivos ("texto de qualidade", "bem feito").
- **O que fazer quando falta algo**: a informação que não veio, o arquivo que não existe, a dúvida sobre o pedido.
  A regra geral é parar e perguntar, não inventar.

### O que você entrega

- Os arquivos que ele produz e onde ficam.
- O que o `resultado.md` da etapa traz, item por item. Quem vem depois só enxerga esse arquivo: ele precisa dizer
  o que foi feito, onde está, o que mudou, o que ficou por fazer e as dúvidas.
- O caso sem novidade ("estava tudo certo") também é um resultado: diga como registrar, em uma linha.

### Limites

- **O que pede o ok de quem pede antes de fazer.** Sempre: publicar, agendar, enviar para fora, apagar e gastar
  dinheiro. E o que for sensível nesta função em particular (mudar preço, mexer em arquivo de outro sistema,
  alterar o que já foi aprovado).
- **O que passa para colegas, e para quem.** Com o nome do colega que você viu em `.claude/agents/`. Se não há
  colega para aquilo, diga que não há e que o caminho é avisar quem pede.
- **O que ele nunca faz**, mesmo com o pedido na mão.

## 3. Como escrever

- **Segunda pessoa, direto:** "Você revisa…", não "O agente deve revisar…".
- **Específico em vez de genérico.** Troque "garanta a qualidade" por o que conferir. Troque "use as ferramentas
  do projeto" pelo nome delas. Uma função que serviria para qualquer projeto não serve para este.
- **Fiel à descrição.** Não aumente o cargo. Quem pediu um revisor não ganhou um redator; quem pediu quem atende
  o cliente não ganhou quem dá desconto. Na dúvida sobre o tamanho da função, fique com o menor: só o que a
  descrição afirma.
- **Frases curtas.** Uma ideia por frase. Listas para o que é lista.
- **Diga o porquê das regras que parecem estranhas.** "Copie o original antes de editar: a pasta não tem
  controle de versão." Regra com motivo é seguida também no caso que ninguém previu.
- **Exemplos pequenos** onde uma regra pode ser lida de dois jeitos: um antes e depois, um nome de arquivo, uma
  linha do resultado.
- **Nada de promessa nem de enfeite:** sem "especialista de classe mundial", sem lista de qualidades pessoais.
- **Tamanho:** de 40 a 120 linhas. Menos que isso costuma ser genérico; mais que isso ninguém relê.

## 4. O que não entra

- **Cabeçalho YAML** (`---`, `name:`, `description:`) e as **regras da equipe** (caderno, memória, `equipe fim`,
  como passar trabalho): o comando acrescenta sozinho.
- **Regras que valem para todos os agentes** e já estão nas regras da equipe.
- **Senhas, chaves, tokens** ou o caminho de arquivos que os guardam.
- **Nome de pessoa, cliente ou empresa** que não esteja na descrição nem nos arquivos da pasta.
- **Tarefas de uma demanda específica.** A função vale para todas as demandas; o pedido do dia vem na demanda.

## 5. Antes de entregar, confira

- [ ] Cada tarefa da descrição aparece na função, e nada além dela.
- [ ] Todo arquivo ou pasta citado existe (você abriu ou listou).
- [ ] Há uma lista "Não é com você".
- [ ] O padrão de qualidade tem critérios que dá para conferir.
- [ ] O `resultado.md` está descrito item por item.
- [ ] Os limites dizem o que pede ok e para quem passar cada coisa.
- [ ] Alguém que nunca viu o projeto, lendo só este texto, saberia começar a trabalhar.
- [ ] Sem cabeçalho YAML e sem as regras da equipe.

Grave no `resultado.md` da etapa **somente o texto da função**, começando pelo título `# <Função>`. Sem introdução,
sem comentário seu antes ou depois: o comando copia o arquivo inteiro para a função do agente.
