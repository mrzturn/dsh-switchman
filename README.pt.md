# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | **Português** | [Русский](./README.ru.md)

> **A família switchman**, mesmo autor, mesma orquestração: [opencode-switchman](https://github.com/mrzturn/opencode-switchman) (o original para OpenCode) · [zcode-switchman](https://github.com/mrzturn/zcode-switchman) (o port para ZCode) · **dsh-switchman** (este repositório, para DeepSeek Harness).

![dsh-switchman — o nível de água do contexto comanda o switchman, que desvia a rota](docs/assets/hero.svg)

> Contexto no medidor. Tarefas que se distribuem sozinhas.

Um plugin para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Depois de instalado, seu modelo primário para de fazer tudo sozinho e vira um dispatcher: mede o nível da água, escolhe a faixa, entrega a tarefa, confere o trabalho. Quatro coisas:

**1. Controle do nível de água do contexto.** A cada turno mede os tokens ao vivo da sessão. Soft (50k por padrão) recomenda delegar, hard (90k) aperta o orçamento de leitura por turno e empurra para encerrar, force (130k) faz backup da sessão e a entrega à compactação — automaticamente. Rode uma sessão o dia inteiro; seu contexto nunca se afoga na própria história. Cada subagent despachado carrega o próprio hard cap e sai com um resumo HANDOFF ao atingi-lo.

**2. Dispatch em seis faixas.** economy / mechanical / main / hard / vision / review — seis faixas cognitivas. Escolha os modelos candidatos por faixa na página de configurações, ordine-os do mais forte (ancoragem opcional em tiers S/A/B/C) e fixe um reasoning effort por rota — o dropdown lista os níveis que cada modelo *realmente* suporta, não três níveis genéricos. Uma tabela `[SWITCHMAN:POOLS]` vai junto com cada prompt para o modelo saber a quem chamar; o modo `enforce` rejeita na hora modelos fora do pool.

**3. Preferências de idioma.** Um dropdown para respostas, um para comentários de código e um para documentos escritos. Não definiu? Perguntam uma vez, fica guardado para sempre e toda sessão seguinte o segue.

**4. Doutrina delegate-by-default.** Substitui a política de equipe conservadora de fábrica do DSH ("crie teammates apenas quando pedido"): o trabalho miúdo fica nas suas mãos (<200 linhas lidas, <50 alteradas), o trabalho de verdade é delegado por padrão; toda alteração é verificada — acima de 20 linhas vai para um tester, acima de 300 linhas ou lógica central vai para um reviewer. Diga "não use equipes" e ela sai de cena na hora.

Só um modelo? Ainda vale a pena — o controle de nível de água e a doutrina não ligam para quantos modelos você tem.

## Skills embutidas

- **db-query** — verificação somente leitura em MySQL/Redis: rode SQL para checar registros, chaves de cache / TTLs, consistência entre stores. Recusa qualquer escrita. Configuração única abaixo.
- **git-commit-message** — texto de commit dentro das convenções. Só texto; nunca toca no git.
- **requirement-docs** — uma especificação única para requisitos / PRD / documentos de design, arquivada em `docs/requirements-and-design/`.

## Início rápido

1. **Instale** — de qualquer sessão de agent, ou pelo gerenciador de plugins Web:

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   ou de um checkout local (link; rode `remove_bundle` + `install_bundle` novamente depois de puxar as mudanças):

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   ou pelo terminal via CLI `dsh` — escolha o perfil que corresponde a como você executa o DSH:

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # app desktop
   ```

2. **Reinicie o DSH** — feche o app por completo e reabra (recarregar a página não basta) para que a tabela de módulos do cliente reconheça o bundle.

3. **Abra a página de configurações** — Settings → dsh-switchman. A primeira tela é a preferência de idioma: um dropdown para respostas / comentários / documentos, cada um com uma linha ao vivo `current: …`. Pode pular — perguntam uma vez e fica guardado.

   ![Página de configurações e preferência de idioma](docs/assets/conf-demo1.png)

4. **Preencha os seis pools** — cada card de pool lista os candidatos agrupados por provider; marque os que quiser. Marque **manual order** e o card vira uma lista de prioridade numerada com controles ↑ ↓ ×. O dropdown de effort ao lado de cada rota selecionada vem em *follow lane* por padrão; ao fixá-lo, ele lista os níveis que aquele modelo realmente suporta (Low / High / Max…). Uma linha de resumo acompanha o progresso ao vivo: “6/6 pools definidos · 3 ranqueados · modo advice”.

   ![Pools de dispatch](docs/assets/conf-demo2.png)

5. **Ranking e watermark** — a ordem da tabela de ranking é a ordem de capacidade (mais forte primeiro), com tiers opcionais S/A/B/C; o modo de execução é `off` / advice / enforce (enforce = modelos fora do pool são rejeitados). Abaixo, a seção de watermark endurece o comportamento conforme o uso de tokens: três limiares, um orçamento de leitura por chamada, o comportamento do modo hard (cap / deny), uma chave de handover automático e um cap separado para subagents. A linha de baixo traz os comandos: `/ctx-pause` para parar de intervir · `/ctx-resume` para retomar · `/ctx-handover` para fazer backup e entregar agora.

   ![Ranking e watermark de contexto](docs/assets/conf-demo3.png)

6. **Verifique** — o badge ⚡ aparece ao lado do chip de preset no cabeçalho de qualquer sessão; pergunte ao modelo “o que diz a última seção do seu system prompt?” — ele deve mencionar a doutrina dsh-switchman.

**Configuração única do db-query** (as dependências dos scripts vivem dentro do diretório da skill):

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## Como funciona

- A metade Host (`index.js` + `host/`) injeta três seções dinâmicas no system prompt, os gates de orçamento de leitura e enforce, a captura automática de respostas e três comandos slash. Todas as configurações são campos voláteis — mudanças salvas valem a partir da próxima montagem de prompt, sem reinício.
- A metade Client (`client.js`) renderiza o badge ⚡ ao lado do chip de preset e a página de configurações, pelos serviços oficiais de settings-form.
- `cordis.patch.yml` reafirma verbatim a lista de plugins de cada preset de fábrica e só estende o sufixo de persona; as ferramentas Agent Teams em si continuam vindo do `@deepseek-ai/dsh-experimental-agent-team-profile` de fábrica.

## Manutenção

- Depois de um upgrade do DSH que mude as listas de plugins dos presets de fábrica, ressincronize `cordis.patch.yml` a partir dos novos `presets/*.patch.yml` (mantenha o sufixo da doutrina) e reinstale.
- As linhas de protocolo voltadas ao modelo (`[SWITCHMAN:LANG|POOLS|WATERMARK]`) são deliberadamente em inglês e estáveis a byte — não as localize.
- `npm pack --dry-run` deve continuar na forma auditada de 34 arquivos / ~111 kB (os screenshots de `docs/` nunca vão no pacote).

## License

MIT
