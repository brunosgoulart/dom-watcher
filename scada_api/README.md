# Runtime Monitor

Atualizado em: 21/10/2026.

## Manutenção

Toda alteração deve manter este documento coerente com o código, atualizar as pendências e registrar as verificações executadas. Distinguir validação automatizada de validação no ambiente PI. Não declarar a implantação concluída enquanto houver requisitos de comissionamento pendentes. Não habilitar escrita nem alterar os parâmetros de comunicação sem autorização.

## Arquitetura

O serviço monitora até sete servidores SCADA a partir de snapshots do PI Data Archive. Uma thread de aquisição mantém um cache compartilhado com métricas, qualidade, históricos de filas e alarmes. O navegador consulta o cache; abrir mais abas não aumenta as leituras PI.

- `server.py`: configuração, aquisição, cache e API HTTP.
- `pi_client.py`: adaptadores AF SDK e PI SDK COM.
- `trends.py`: seis análises de elevação sustentada.
- `absolute_alarms.py`: seis alarmes opcionais por limite superior.
- `trend_output.py`: publicação autorizada, heartbeat e retentativas independentes por família de alarmes.
- `config.toml`: configuração operacional versionada, sem credenciais, com AF SDK, `pidatapro` e os três servidores COGCGPRO.
- `config.reference.toml`: referência de estrutura com sete posições; os endereços precisam corresponder ao ambiente.
- `servidores_tags.csv`: catálogo de mapeamento de entradas e saídas de tendência.
- `diagnose_pi.py`, `diagnose_afsdk.py`, `diagnose_runtime.py`: ferramentas de diagnóstico explícito.
- `../web/`: interface estática.
- `../tests/`: verificações automatizadas, separadas do código servido ao navegador.

A chegada das medições ao PI é responsabilidade do sistema SCADA existente e não integra esta aplicação. Não há descoberta de tags, PI Web API, navegação AF, leitura de arquivos de log ou geração de medições na aplicação.

## Configuração operacional

O serviço carrega `scada_api/config.toml` por padrão. Esse arquivo agora acompanha o repositório, com o inventário aprovado e sem credenciais. É possível selecionar outro arquivo com `--config`. Não há fallback automático para a referência. Preserve alterações específicas do ambiente antes de atualizar o repositório; nunca inclua senhas ou segredos nesse arquivo.

A configuração local e o perfil `config.cogcgpro.toml` possuem as entradas de COGCGPRO12, COGCGPRO34 e COGCGPRO56 mapeadas e usam o PI Data Archive `pidatapro`, confirmado pelo operador. O AF SDK ainda precisa estar instalado no caminho configurado; não há conexão real validada nesta estação.

### Inventário disponível: COGCGPRO12, COGCGPRO34 e COGCGPRO56

O perfil versionado `config.cogcgpro.toml` e o arquivo operacional contêm as 26 tags existentes por servidor (78 leituras), com os nomes exatos fornecidos em 19/10/2026. Usam AF SDK, escrita desabilitada, nenhum endereço de saída presumido e nenhum limite absoluto arbitrário. O serviço continua carregando `config.toml` por padrão; o perfil é uma fonte de provisionamento, não um fallback. Confira `piAfSdkDll` no arquivo operacional e reinicie o serviço após alterações.

Todos os sufixos abaixo recebem o prefixo `CSEO.<SERVIDOR>.`:

| Métrica | Sufixo PI |
|---|---|
| `runCPU` | `E3Run.CPU` |
| `runMemory` | `E3Run.Memory` |
| `runPVT` | `E3Run.PVT` |
| `runTRD` | `E3Run.TRD` |
| `runLocalPending` | `E3Run.PendingEvents` |
| `runRemotePending` | `E3Run.RemotePending` |
| `runOccupancy` | `E3Run.Occupancy` |
| `runErrorsPerMinute` | `E3Run.ErrorsPerMinute` |
| `serverCPU` | `E3Server.CPU` |
| `serverHDL` | `E3Server.HDL` |
| `ioQueuePending` | `ioQueue.Pending` |
| `ioQueueAvgDelay` | `ioQueue.AvgDelay` |
| `totalTime` | `TotalTime` |
| `runUptimeMinutes` | `E3Run.UpTimeMinutes` |
| `remoteHandledRate` | `E3Run.RemoteHandledPerMinute` |
| `remoteDiscardPercent` | `E3Run.RemoteDiscardPercent` |
| `runAvgScriptTime` | `E3Run.AvgScriptTime` |
| `runDiscardedEvents` | `E3Run.DiscardedEvents` |
| `runErrors` | `E3Run.Errors` |
| `runHDL` | `E3Run.HDL` |
| `runPageFaults` | `E3Run.PageFaults` |
| `remoteDiscardedRate` | `E3Run.RemoteDiscardedPerMinute` |
| `serverPVT` | `E3Server.PVT` |
| `collectionTimestamp` | `CollectionTimeStamp` |
| `fileRead` | `FileRead` |
| `serverStatus` | `E3Server.Status` |

`PendingEvents` foi associado à fila local; confirmar essa semântica no comissionamento. Confirmar também PVT em KiB, TotalTime em segundos e as demais unidades de origem: nomes de tags não comprovam unidades. Não há conversão implícita. CPU/RAM/ocupação/descarte remoto devem chegar em 0–100; erros e tratados remotos já como taxas por minuto.

Todos esses pontos são coletados e exibidos nas duas páginas. `collectionTimestamp`, `fileRead` e `serverStatus` admitem texto, booleano, número ou rótulo digital válido; são informações, não entradas de cálculo de tendência. O valor de `CollectionTimeStamp` não substitui o timestamp do snapshot para validar frescor. Estados digitais de sistema/erro e qualidade ruim são rejeitados. Não se presume que um código de status represente um processo saudável. Os demais pontos continuam numéricos, não negativos, com qualidade e timestamp válidos.

`AvgScriptTime` e `ioQueue.AvgDelay` mostram o valor sem unidade presumida, com essa ressalva na tela; confirmar a unidade no PI antes de acrescentá-la. `Errors`, `DiscardedEvents` e `PageFaults` são valores/contadores publicados, não taxas derivadas. `RemoteDiscardedPerMinute` é taxa por minuto. Memória privada do E3Server segue apresentação em KiB, como a do E3Run; confirmar a unidade de origem no comissionamento.

Não foram informadas tags de taxas de entrada/tratamento/descarte percentual local, entrada remota, espaço livre ou tamanho ETL. Essas métricas permanecem indisponíveis e não ocupam cartões nas páginas atualizadas. Os históricos de fluxo não são apresentados, sem estimar fluxos a partir de pendências ou contadores. Tratados e descartados remotos aparecem em cartões próprios, independentemente do histórico.

### Apresentação das métricas

Nas duas telas, Runtime e scripts, Eventos e Servidor e coleta são páginas selecionáveis com os 26 pontos distribuídos em seis seções. Na visão geral, a cada 10 s o carrossel avança o grupo; depois dos três grupos, passa ao próximo servidor. Na página individual, alternam os grupos e as páginas dos alarmes daquele servidor. A pausa global e o foco em controles dos painéis suspendem a rotação. Ambas as telas foram conferidas sem rolagem em 1280×720 e em Full HD; telas menores permitem rolagem vertical. Valores textuais completos permanecem no título do valor. Status e metadados são escapados como texto, nunca HTML. Não são criados alarmes adicionais para as novas entradas.

Os cartões herdam a maior severidade de alarme da respectiva métrica. Dados ausentes têm indicação “Sem dados”; uma medição recente com análise indisponível mostra “Análise pendente”. Valores sem alarme ficam neutros. Somente percentuais têm barras proporcionais de 0–100; não são presumidos máximos para threads, handles, contadores ou tempos.

Parâmetros globais:

| Parâmetro | Uso |
|---|---|
| `piServer` | Nome explícito do PI Data Archive |
| `piAdapter` | `af-sdk` ou `pi-sdk-com`, sem fallback |
| `piAfSdkDll` | Caminho da DLL AF SDK |
| `pollSeconds` | Consulta PI; padrão 30 s, intervalo 5–3600 s |
| `staleSeconds` | Validade da medição; padrão 120 s, intervalo 5–86400 s |
| `enableWrites` | Autoriza publicação; padrão `false` |
| `outputHeartbeatSeconds` | Republicação de estado estável; padrão 60 s |
| `writeRetrySeconds` | Retentativa de publicação; padrão 30 s |

Heartbeat e retentativa aceitam 5–3600 segundos. Reinicie o serviço após qualquer alteração no TOML. A autenticação usa a conta Windows do processo; não há senha na configuração.

Cada `[[servers]]` possui `id` único e seguro para URL, `name`, `site`, `environment`, `role` e os mapeamentos abaixo. As tabelas de cada servidor pertencem ao último `[[servers]]`; não duplicar uma tabela no mesmo servidor.

### Entradas: [servers.tags]

Somente nomes explícitos de PI Points são aceitos. Configure apenas as entradas existentes.

```text
runCPU, runMemory, runPVT, runTRD
runLocalPending, runRemotePending
runOccupancy, runErrorsPerMinute
serverCPU, serverHDL
driveCFreeMB, etlFileSizeMB
ioQueuePending, ioQueueAvgDelay
totalTime, runUptimeMinutes
localEnteredRate, localHandledRate, localDiscardPercent
remoteEnteredRate, remoteHandledRate, remoteDiscardPercent
runAvgScriptTime, runDiscardedEvents, runErrors, runHDL, runPageFaults
remoteDiscardedRate, serverPVT
collectionTimestamp, fileRead, serverStatus
```

São 32 entradas suportadas, das quais 26 existem no inventário COGCGPRO informado. CPU, RAM, erros/minuto e as duas filas pendentes são essenciais para `collecting=true`. Memória privada é necessária para completar as seis tendências. Memória privada é esperada em KiB; erros/minuto e fluxos já devem chegar como taxas por minuto. O serviço não transforma contadores brutos em taxas.

Nas métricas numéricas, valores ausentes, ruins, questionáveis, booleanos, não numéricos, não finitos, negativos, futuros ou antigos são indisponíveis, nunca zero. Os três campos informativos permitem os tipos descritos acima, com o mesmo controle de qualidade e frescor. Percentuais devem estar entre 0 e 100. O timestamp geral é o mais antigo das entradas essenciais. Falhas são isoladas por métrica; uma falha de conexão não confirma normalidade.

O AF SDK usa `pythonnet`, runtime `netfx`, `PIServer.FindPIServer`, `Connect` e snapshots de PIPoints. Reutiliza sessão/cache e reconecta após falha de snapshot. O COM usa uma thread própria com inicialização COM. Chamadas nativas não possuem timeout cancelável.

### Tendências: [trend] e [servers.outputs]

As seis métricas são `runCPU`, `runMemory`, `runPVT`, `runErrorsPerMinute`, `runLocalPending` e `runRemotePending`.

A ativação exige uma janela completa de elevação sustentada. Padrão: 600 s, 11 medições cobrindo dez minutos, com cadência de origem de 60 s. Não há espera adicional após completar a janela. Timestamps repetidos não contam como novas medições. Lacunas maiores que 90 s reiniciam a janela.

O cálculo usa inclinação robusta Theil–Sen e variação líquida positiva na janela e em trechos móveis de quatro pontos. Pequenas oscilações são toleradas; picos isolados e estabilidade prolongada não ativam. Qualquer elevação sustentada pode ativar atenção, mesmo habitual.

A referência anterior de 30 min é opcional para ativação e serve à gravidade. O score é normalizado pelo ruído e resolução; padrão crítico 6. RAM e memória privada também possuem análise de 15 min para gravidade, sem atrasar a janela principal. Recuperação/redução exige três novas medições qualificadas.

- `measurementSeconds`: fixo em 60.
- `windowSeconds`: 120–3600, padrão 600.
- `referenceSeconds`: 600–7200, padrão 1800.
- `memoryWindowSeconds`: 120–3600, padrão 900, nunca menor que a principal.
- Janelas são múltiplos de 60.
- `criticalScore`: positivo e finito; padrão 6.
- `recoverySamples`: 2–10; padrão 3.
- `[trend.resolution]`: resolução positiva e finita para cada métrica.

Saídas: `CSEO.<SERVIDOR>.SCADA.Trend.<MÉTRICA>.State`, com CPU, RAM, PrivateMemory, ScriptErrors, LocalQueue e RemoteQueue. Use as mesmas seis chaves das métricas em `[servers.outputs]`.

| Estado | Significado |
|---|---|
| 0 | Sem elevação sustentada confirmada |
| 10 | Atenção |
| 20 | Crítico |
| 30 | Histórico insuficiente ou reconstrução |
| 40 | Medição inválida, ausente, antiga, futura ou fora de ordem |

### Limites absolutos: [servers.absoluteLimits] e [servers.absoluteOutputs]

As mesmas seis métricas podem ter um alarme independente, sem depender de tendência ou aquecimento. Limite numérico habilita; chave omitida ou `""` desabilita cálculo e publicação. **Zero é um limite válido.** TOML não aceita uma atribuição sem valor.

```toml
[servers.absoluteLimits]
runCPU = ""
runMemory = ""
runPVT = ""
runErrorsPerMinute = ""
runLocalPending = ""
runRemotePending = ""

[servers.absoluteOutputs]
runCPU = ""
runMemory = ""
runPVT = ""
runErrorsPerMinute = ""
runLocalPending = ""
runRemotePending = ""
```

Valor válido **igual ou superior** ao limite gera `20`; abaixo gera `0`; inválido gera `40`. Não há histerese, temporização nem segundo patamar. A recuperação ocorre na primeira coleta válida abaixo do limite. Limites usam a unidade da entrada e precisam de tag de entrada mapeada; percentuais aceitam 0–100, demais valores são finitos e não negativos.

Saídas: `CSEO.<SERVIDOR>.SCADA.Absolute.<MÉTRICA>.State`, com os mesmos seis sufixos. Saída vazia impede apenas publicação: se o limite estiver habilitado, o alarme continua no painel e em `absoluteAlarms` na API.

Desabilitar interrompe a publicação, mas **não limpa o último valor no PI**. Os consumidores devem considerar habilitação e heartbeat.

## Publicação PI

A escrita exige `enableWrites=true`, adaptador `pi-sdk-com`, PI Data Archive explícito, tags preexistentes e permissões aprovadas. **AF SDK permanece somente leitura**: a configuração rejeita escrita com esse adaptador.

Até 12 saídas por servidor, 84 no total. As seis tendências exigem mapeamento completo quando a escrita está habilitada; as seis saídas absolutas são opcionais. Todas as saídas são validadas globalmente contra duplicidades, colisões com entradas e namespace. Somente endereços autorizados podem receber estados.

A publicação usa `UpdateValue`, timestamp atual PI e substituição de duplicados. Heartbeat e retentativas são independentes por saída. A API expõe `writeStatus` e o painel sinaliza falhas. Não existe confirmação por releitura; sem conexão não é possível publicar o estado inválido.

## API e interface

`GET /api/v1/status` expõe o cache, qualidade, timestamps, históricos, tendências, limites absolutos, diagnóstico de publicação e política de análise. `source` aceita somente `af-sdk` e `pi-sdk-com`. Não existe API HTTP de mutação. Arquivos fora de `web/` não são servidos; listagem de diretórios é bloqueada.

O navegador consulta a cada 10 s, com timeout de 8 s. O Monitoramento mostra dois alarmes ativos por página e dois eventos históricos por página, com índices independentes: um histórico mais longo não produz páginas vazias de alarmes ativos. Existem seleção direta de servidor, navegação anterior/próximo e pausa. A pausa global suspende consulta e rotação no navegador, não aquisição/cálculo/publicação do serviço; a validade das leituras continua sendo reavaliada. Os cartões absolutos são identificados como “Limite”.

O cabeçalho unifica a identificação em um único grupo com um ícone de gráfico: “DASHBOARD DE”, “performance SCADA” e “Runtime Elipse E3 e Power”. Runtime Monitor identifica as abas de visão geral e de servidor. O tema é inspirado na página e na demonstração pública de status do [UptimeRobot](https://uptimerobot.com/): superfícies grafite, verde vivo para navegação/estado confirmado sem alarmes, bordas suaves, indicadores com texto e separação de ativos/histórico. Não usa bibliotecas, fontes remotas, rastreamento ou integração com esse serviço.

As alturas dos cartões se ajustam ao espaço da janela; fontes aumentam em monitores Full HD. Os seletores de servidor apresentam o estado por cor e texto. O Monitoramento resume quantos alarmes estão ativos e quantos servidores estão afetados, com contagens discretas de críticos/atenção; o diagnóstico pendente aparece quando existe. Quando faltam dados ou histórico de análise, mostra “Estado não confirmado”, nunca um sinal verde de normalidade. A interface não exibe avisos de “troca automática a cada X segundos”; mantém paginação, idade da amostra e pausa global, sem botão de pausa exclusivo do carrossel.

A faixa de disponibilidade conta apenas os 26 pontos apresentados de cada servidor com qualidade e timestamp válidos. Distingue leituras recentes, leitura parcial, ausência de leituras e atualização pausada. `78 / 78 pontos` significa disponibilidade das medições dos três servidores, não ausência de alarmes nem saúde do SCADA. No Monitoramento, o nome do servidor precede a leitura; sinais de elevação e de limite usam ícones distintos. O histórico traduz chaves conhecidas para os mesmos rótulos das métricas, preservando os valores e descrições originais.

Os cartões de Monitoramento e as linhas de alarme individuais usam símbolos vetoriais de traço fino (22–27 px): octógono com exclamação em crítico e triângulo com exclamação em atenção. Indisponibilidade usa interrogação e texto explícito. A paleta concentra cor nos valores, marcadores e filetes laterais; superfícies e bordas são discretas. Forma, cor e texto são redundantes; não há piscadas nem mudança de prioridade. Os símbolos são decorativos para leitores de tela, que continuam recebendo o estado em texto. A navegação por teclado possui foco visível e as transições de hover respeitam a preferência por movimento reduzido.

A faixa de conexão mantém a data completa e a hora atual sempre visíveis, atualizadas a cada segundo no fuso `America/Sao_Paulo`, no formato `domingo, 18 de outubro de 2026 - 19:05:48`. A mensagem da origem/conexão e o horário da última resposta ficam em um painel aberto pelo ícone de informações, acionável por clique ou teclado. O relógio usa o horário do computador do navegador e continua funcionando durante a pausa de atualização; ele não comprova atualidade dos dados PI. Os status continuam atualizando mesmo quando o painel de informações está fechado.

As seções de métricas são Performance, Scripts e execução, Eventos locais, Eventos remotos, Servidor e Coleta e E/S. Não são mostrados percentuais de disponibilidade nem gráficos de uptime: esses indicadores não são calculados pela aplicação.

O cabeçalho da página individual apresenta os alarmes em linhas operacionais: ponto, condição, valor atual e estado. Formato percentual absoluto: `E3Run.CPU - Percentual Muito Alto (95,0 %) - Ativo`. Tendências usam “Tendência de Elevação”; métricas não percentuais usam suas unidades próprias. Dados/histórico indisponíveis são identificados como “Indisponível”, não contam como alarmes ativos e não reutilizam valores antigos. Os nomes dos pontos apresentados são rótulos da interface, não substituem os endereços PI configurados. Falhas de publicação continuam sinalizadas; detalhes técnicos permanecem no tooltip e na API. Não há reconhecimento de alarmes nem alteração de limites por essa apresentação.

O histórico de alarmes trazido pela versão base persiste em `runtime-history.sqlite3` (caminho alternativo: `historyDbPath`), retém até 2.000 eventos e fornece os oito mais recentes à interface. Eventos históricos não comprovam alarmes ainda ativos. Os estados internos das análises continuam em memória; o AF SDK pode recompor as janelas com leituras interpoladas do PI. O histórico do PI não é apagado. O servidor HTTP atende somente loopback, sem autenticação; acesso remoto depende de proxy controlado, TLS e autenticação corporativa. O timeout do navegador não cancela chamadas COM nativas.

## Execução

Requisitos: Windows, Python 3.11+, SDK selecionado instalado, dependências de `requirements.txt` e conta Windows autorizada. AF SDK requer .NET Framework 4.x, pythonnet e a DLL configurada; COM requer pywin32 e arquitetura compatível.

Na raiz do projeto:

```powershell
python -m venv .venv
& '.\.venv\Scripts\python.exe' -m pip install -r scada_api/requirements.txt
& '.\.venv\Scripts\python.exe' -u scada_api/server.py --config scada_api/config.toml --port 8768
```

Abra `http://127.0.0.1:8768/#overview`. Não iniciar uma segunda instância na mesma porta. O `config.toml` operacional acompanha o Git; confira o caminho da DLL e as permissões locais antes de iniciar. Nunca habilitar escrita automaticamente.

Diagnóstico, executado somente sob demanda:

```powershell
python -B scada_api/server.py --config scada_api/config.toml --check-config
python -B scada_api/diagnose_afsdk.py client --config scada_api/config.toml
python -B scada_api/diagnose_pi.py --server NOME_DO_PI --tag NOME_DA_TAG
python -B scada_api/diagnose_runtime.py
```

`--check-config` não abre conexão nem cria cliente PI: verifica o endereço configurado, as cinco entradas essenciais por servidor, Windows e os módulos Python do adaptador. Retorna 0 quando esses requisitos locais passam e 2 quando há pendências. A DLL AF SDK continua validada ao carregar a configuração. Execute com o mesmo Python do serviço. Esse resultado não comprova SDK COM registrado, autenticação, existência/unidades das tags ou acesso ao historiador.

Os demais comandos podem realizar leitura no PI; não publicam alarmes. O diagnóstico AF SDK usa o arquivo operacional ou os argumentos `--server` e `--tag`, sem servidor/tag fixados no código.

Cada medição é apresentada conforme sua própria qualidade e timestamp, sem esperar o histórico mínimo das tendências e sem ocultar as leituras válidas por falha de outra entrada. Valores vencidos, futuros, inválidos ou após falha da API não são mostrados como atuais. Memória privada é apresentada em KiB e erros/minuto com uma casa decimal. A origem simulada permanece bloqueada no painel operacional.

## Verificação de engenharia

### Prévia de interface isolada

Para inspeção visual, execute `python -B tools/interface_preview.py --port 8769` a partir da raiz e abra `http://127.0.0.1:8769/#overview`. A ferramenta fica em `tools/`, não carrega `config.toml`, não conecta ao PI e não escreve saídas. O serviço operacional permanece na porta 8768.

A prévia fornece COGCGPRO12, COGCGPRO34 e COGCGPRO56, com os 26 pontos selecionados, cenários de tendência pré-definidos e limites absolutos de CPU/RAM em 90% exclusivamente para avaliação visual. COGCGPRO12 tem CPU estável em aproximadamente 95%, sem tendência CPU e com alarme absoluto. O histórico simulado usa um SQLite temporário próprio, sem ler nem modificar o histórico operacional. A ferramenta não comprova o algoritmo de tendências nem define limites operacionais.

Apenas a prévia serve `pi-config.js` com `allowSimulatedData=true`. O arquivo operacional mantém `false` e rejeita essa origem. A interface identifica explicitamente `SIMULAÇÃO LOCAL`, incluindo tela individual e rodapé. Os campos e parâmetros operacionais permanecem sem nomenclatura de demonstração; a funcionalidade isolada existe somente para esta inspeção.

### Cobertura automatizada

As verificações automatizadas ficam isoladas em `tests/python/` e `tests/web/`; não são modos de operação da aplicação. Não remover essa cobertura ao preparar implantação.

```powershell
python -B -m unittest discover -s tests/python
node --test tests/web/test-*.cjs
```

Node.js só é necessário para as verificações do frontend. As verificações Python isolam dependências SDK com mocks, inclusive a existência da DLL; não comprovam disponibilidade da DLL real nem autenticação, leitura ou escrita PI no ambiente.

Verificação em 21/10/2026: 71 verificações Python aprovadas em cópia temporária isolada (para preservar o SQLite operacional). No refinamento visual, 28 verificações JavaScript foram aprovadas, incluindo contagem de leituras recentes independente da severidade, qualidade/expiração, distinção dos tipos de alarme e rótulos seguros no histórico. Mantêm cobertura das 26 métricas, rejeição de simulação na origem operacional, paginação independente de ativos e histórico, pausa e foco de teclado. A prévia isolada na porta 8771 foi conferida no navegador em 1280×720, 1920×1080 e 390×844, incluindo seleção de servidor, grupos de métricas, histórico e alarmes. AF SDK, `pidatapro`, tags, limites e permissões de escrita foram preservados. Não foi realizada conexão real ao PI nesta revisão visual.

## Pendências de implantação

Ampliação das páginas em 19/10/2026: 68 verificações Python e 20 JavaScript aprovadas, incluindo leitura das 78 entradas, qualidade/tipos de metadados, rejeição de estados digitais de sistema, escape HTML e cobertura das 26 métricas por servidor no carrossel (também com apenas um servidor configurado). Prévia visual isolada na porta 8770; nenhum acesso ao PI. A conferência visual da visão geral em 1280×720 não indicou rolagem da janela. Instalação da DLL AF SDK, permissões e validação das unidades no PI continuam pendentes.

Distribuição do arquivo operacional em 19/10/2026: `config.toml` incluído no versionamento por solicitação do operador, removendo a necessidade de cópia manual após baixar o projeto. Contém somente os dados já aprovados no perfil COGCGPRO, sem credenciais. 65 verificações Python aprovadas, incluindo equivalência entre o arquivo padrão e o perfil; SDK simulado apenas nos testes. A ausência local da DLL AF SDK continua impedindo a validação de conexão real.

Mapeamento de entradas em 19/10/2026: 64 verificações Python e 16 JavaScript aprovadas. Os novos casos conferem nomes e capitalização das 48 tags, leitura das três máquinas, ausência de saídas/limites presumidos e manutenção de métricas/históricos ausentes como indisponíveis. Os valores de teste usam um cliente isolado; não houve acesso ao PI. A configuração privada preservou os parâmetros globais e recebeu somente o inventário e os mapeamentos. A DLL AF SDK ainda não está disponível no caminho padrão e o PI Data Archive não foi informado.

Preparação para leitura real em 18/10/2026: 61 verificações Python e 16 JavaScript aprovadas. Cobrem também leitura parcial, métricas durante formação de tendências, expiração individual, indisponibilidade da API e timestamps inválidos na serialização JSON. A configuração privada e a comunicação existente foram preservadas. A verificação local aponta ausência de PI Data Archive, mapeamento das entradas e módulos COM no Python utilizado; não foi possível validar conexão ou valores reais. Não considerar este resultado um comissionamento concluído.

Verificação visual em 18/10/2026: títulos de métricas discretos, nomes de servidores ampliados, cartões compactos e botão de pausa exclusivo do carrossel removido. Dez verificações JavaScript aprovadas, incluindo ausência desse botão e preservação da pausa global. No navegador, não houve corte de cartões nem rolagem da página nos viewports de 1280×720 e 2133×1000. Não houve alteração da comunicação ou acesso ao PI.

Implementado e verificado no código:

- [x] Configuração operacional `config.toml`, referência separada e nomenclaturas operacionais.
- [x] Aplicação restrita a fontes PI reais, sem geração local de medições.
- [x] Tendências e limites absolutos independentes com saídas autorizadas.
- [x] Verificações de engenharia separadas dos arquivos de execução.
- [x] Prévia visual isolada em `tools/`, sem PI, com habilitação explícita no frontend servido apenas pela porta 8769.

Antes da liberação no ambiente:

- [ ] Confirmar no ambiente o PI Data Archive, o inventário e as entradas já mapeadas; aprovar saídas somente se houver publicação.
- [ ] Conferir unidades, qualidade e timestamps; assegurar publicação das entradas a cada 60 s e políticas de exceção/compressão.
- [ ] Instalar e verificar SDK, DLL, arquitetura e dependências no host de execução.
- [ ] Validar autenticação e permissões da conta Windows.
- [ ] Aprovar janelas, gravidade, resoluções e limites absolutos.
- [ ] Validar leitura, disparo, recuperação, lacunas, falhas de conexão e reinício com dados reais.
- [ ] Provisionar tipos, códigos, retenção e exceção/compressão das saídas.
- [ ] Autorizar escrita COM e conferir transições/heartbeat no PI antes de habilitá-la.
- [ ] Definir conta de serviço, inicialização automática, supervisão, reinício e diagnóstico.
- [ ] Implantar proxy/TLS/autenticação e firewall se houver acesso de outra máquina.
- [ ] Validar apresentação na TV e registrar aprovação operacional.

Limitações a avaliar: restauração dos estados das análises; política de backup do SQLite; isolamento de chamadas COM bloqueadas; confirmação de escrita por releitura. A existência de código e verificações locais não substitui o comissionamento no PI.

