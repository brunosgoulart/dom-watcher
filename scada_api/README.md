# Runtime Monitor

Atualizado em: 18/10/2026.

## Manutenção

Toda alteração deve manter este documento coerente com o código, atualizar as pendências e registrar as verificações executadas. Distinguir validação automatizada de validação no ambiente PI. Não declarar a implantação concluída enquanto houver requisitos de comissionamento pendentes. Não habilitar escrita nem alterar os parâmetros de comunicação sem autorização.

## Arquitetura

O serviço monitora até sete servidores SCADA a partir de snapshots do PI Data Archive. Uma thread de aquisição mantém um cache compartilhado com métricas, qualidade, históricos de filas e alarmes. O navegador consulta o cache; abrir mais abas não aumenta as leituras PI.

- `server.py`: configuração, aquisição, cache e API HTTP.
- `pi_client.py`: adaptadores AF SDK e PI SDK COM.
- `trends.py`: seis análises de elevação sustentada.
- `absolute_alarms.py`: seis alarmes opcionais por limite superior.
- `trend_output.py`: publicação autorizada, heartbeat e retentativas independentes por família de alarmes.
- `config.toml`: configuração operacional local, fora do versionamento.
- `config.reference.toml`: referência de estrutura com sete posições; os endereços precisam corresponder ao ambiente.
- `servidores_tags.csv`: catálogo de mapeamento de entradas e saídas de tendência.
- `diagnose_pi.py`, `diagnose_afsdk.py`, `diagnose_runtime.py`: ferramentas de diagnóstico explícito.
- `../web/`: interface estática.
- `../tests/`: verificações automatizadas, separadas do código servido ao navegador.

A chegada das medições ao PI é responsabilidade do sistema SCADA existente e não integra esta aplicação. Não há descoberta de tags, PI Web API, navegação AF, leitura de arquivos de log ou geração de medições na aplicação.

## Configuração operacional

O serviço carrega `scada_api/config.toml` por padrão. É possível selecionar outro arquivo com `--config`. Não há fallback automático para a referência. Se o arquivo não existir, deve ser provisionado a partir de `config.reference.toml` e preenchido com os dados aprovados.

A configuração local desta estação ainda está sem PI Data Archive e sem entradas mapeadas. A aplicação deve indicar essa condição, sem apresentar valores inventados.

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
```

São 22 entradas suportadas. CPU, RAM, erros/minuto e as duas filas pendentes são essenciais para `collecting=true`. Memória privada é necessária para completar as seis tendências. Memória privada é esperada em KiB; erros e fluxos já devem chegar como taxas por minuto. O serviço não transforma contadores brutos em taxas.

Valores ausentes, ruins, questionáveis, booleanos, não numéricos, não finitos, negativos, futuros ou antigos são indisponíveis, nunca zero. Percentuais devem estar entre 0 e 100. O timestamp geral é o mais antigo das entradas essenciais. Falhas são isoladas por métrica; uma falha de conexão não confirma normalidade.

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

O navegador consulta a cada 10 s, com timeout de 8 s. A visão geral alterna os servidores a cada 10 s; o Monitoramento mostra dois alarmes por página com rotação independente. Existem seleção direta, navegação anterior/próximo e pausa. A pausa global suspende atualização e rotação no navegador, não aquisição/cálculo/publicação do serviço. Os cartões absolutos são identificados como “Limite”.

O cabeçalho unifica a identificação em um único grupo com um ícone de gráfico: “DASHBOARD DE”, “performance SCADA” e “Runtime Elipse E3 e Power”, com hierarquia tipográfica e acabamento em tons frios. Runtime Monitor identifica as abas de visão geral e de servidor. A interface não exibe avisos de “troca automática a cada X segundos”: o Monitoramento mantém somente a paginação, e a legenda dos servidores mantém a idade da amostra e o aviso de atualização pausada, quando aplicável. Os intervalos e a rotação permanecem inalterados. Marcação do título único e remoção desses avisos cobertas pelas 14 verificações JavaScript aprovadas nesta revisão.

Na visão geral de desktop, os cartões de métricas usam altura compacta responsiva de 135–165 px e títulos discretos de 14–20 px, com espaçamento interno reduzido. A identificação principal do servidor usa 30–42 px; os nomes no Monitoramento usam 20–28 px e peso 700. Não há botão de pausa exclusivo do carrossel; permanecem setas, seleção direta e pausa global. Valores, unidades e regras dos alarmes não foram alterados por esse ajuste visual.

Os cartões de Monitoramento possuem símbolos vetoriais grandes (44–64 px), adequados para identificação à distância: octógono com exclamação em crítico, triângulo com exclamação em atenção e círculo com interrogação quando indisponível. Forma, cor e texto são redundantes; não há piscadas nem mudança de prioridade. Os símbolos são decorativos para leitores de tela, que continuam recebendo o estado em texto.

A faixa de conexão mantém a data completa e a hora atual sempre visíveis, atualizadas a cada segundo no fuso `America/Sao_Paulo`, no formato `domingo, 18 de outubro de 2026 - 19:05:48`. A mensagem da origem/conexão e o horário da última resposta ficam em um painel aberto pelo ícone de informações, acionável por clique ou teclado. O relógio usa o horário do computador do navegador e continua funcionando durante a pausa de atualização; ele não comprova atualidade dos dados PI. Os status continuam atualizando mesmo quando o painel de informações está fechado.

As páginas individuais exibem Performance, Eventos, Processos, Qualidade e Recursos. Gráficos de filas acumulam até 120 amostras por fila/servidor em memória; não há consulta histórica retroativa ao PI. O layout de desktop distribui a visão geral na janela; telas estreitas permitem rolagem.

O cabeçalho da página individual apresenta os alarmes em linhas operacionais: ponto, condição, valor atual e estado. Formato percentual absoluto: `E3Run.CPU - Percentual Muito Alto (95,0 %) - Ativo`. Tendências usam “Tendência de Elevação”; métricas não percentuais usam suas unidades próprias. Dados/histórico indisponíveis são identificados como “Indisponível”, não contam como alarmes ativos e não reutilizam valores antigos. Os nomes dos pontos apresentados são rótulos da interface, não substituem os endereços PI configurados. Falhas de publicação continuam sinalizadas; detalhes técnicos permanecem no tooltip e na API. Não há reconhecimento de alarmes nem alteração de limites por essa apresentação.

Históricos e estados internos não persistem após reinício. A janela de tendência precisa ser reconstruída. O histórico do PI não é apagado. O servidor HTTP atende somente loopback, sem autenticação; acesso remoto depende de proxy controlado, TLS e autenticação corporativa. O timeout do navegador não cancela chamadas COM nativas.

## Execução

Requisitos: Windows, Python 3.11+, SDK selecionado instalado, dependências de `requirements.txt` e conta Windows autorizada. AF SDK requer .NET Framework 4.x, pythonnet e a DLL configurada; COM requer pywin32 e arquitetura compatível.

Na raiz do projeto:

```powershell
python -m venv .venv
& '.\.venv\Scripts\python.exe' -m pip install -r scada_api/requirements.txt
& '.\.venv\Scripts\python.exe' -u scada_api/server.py --config scada_api/config.toml --port 8768
```

Abra `http://127.0.0.1:8768/#overview`. Não iniciar uma segunda instância na mesma porta. Provisionar a configuração local antes de iniciar; o arquivo é ignorado pelo Git para preservar dados do ambiente. Nunca habilitar escrita automaticamente.

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

A prévia fornece COGCGPRO12, COGCGPRO34 e COGCGPRO56, com os 16 pontos selecionados, cenários de tendência pré-definidos e limites absolutos de CPU/RAM em 90% exclusivamente para avaliação visual. COGCGPRO12 tem CPU estável em aproximadamente 95%, sem tendência CPU e com alarme absoluto. A ferramenta não comprova o algoritmo de tendências nem define limites operacionais.

Apenas a prévia serve `pi-config.js` com `allowSimulatedData=true`. O arquivo operacional mantém `false` e rejeita essa origem. A interface identifica explicitamente `SIMULAÇÃO LOCAL`, incluindo tela individual e rodapé. Os campos e parâmetros operacionais permanecem sem nomenclatura de demonstração; a funcionalidade isolada existe somente para esta inspeção.

### Cobertura automatizada

As verificações automatizadas ficam isoladas em `tests/python/` e `tests/web/`; não são modos de operação da aplicação. Não remover essa cobertura ao preparar implantação.

```powershell
python -B -m unittest discover -s tests/python
node --test tests/web/test-*.cjs
```

Node.js só é necessário para as verificações do frontend. As verificações Python isolam dependências SDK com mocks, inclusive a existência da DLL; não comprovam disponibilidade da DLL real nem autenticação, leitura ou escrita PI no ambiente.

Verificação do serviço: 56 verificações Python aprovadas; a integração HTTP local é exercitada sem acessar o PI. Verificação da apresentação em 18/10/2026: 14 verificações JavaScript aprovadas, incluindo painel acessível de informações da conexão e relógio no fuso de São Paulo e independente da pausa, símbolos de severidade, formato das linhas de alarme, distinção de tendência/limite e separação entre ativo e indisponível. Incluem a geração isolada dos três servidores e a rejeição da origem simulada pelo frontend operacional. Prévia na porta 8769 conferida no navegador com valores e alarmes absolutos/tendência. Comunicação e permissões de escrita foram preservadas. A configuração local foi renomeada sem alterar os parâmetros de conexão, consulta ou publicação; apenas os metadados do servidor foram padronizados.

## Pendências de implantação

Preparação para leitura real em 18/10/2026: 61 verificações Python e 16 JavaScript aprovadas. Cobrem também leitura parcial, métricas durante formação de tendências, expiração individual, indisponibilidade da API e timestamps inválidos na serialização JSON. A configuração privada e a comunicação existente foram preservadas. A verificação local aponta ausência de PI Data Archive, mapeamento das entradas e módulos COM no Python utilizado; não foi possível validar conexão ou valores reais. Não considerar este resultado um comissionamento concluído.

Verificação visual em 18/10/2026: títulos de métricas discretos, nomes de servidores ampliados, cartões compactos e botão de pausa exclusivo do carrossel removido. Dez verificações JavaScript aprovadas, incluindo ausência desse botão e preservação da pausa global. No navegador, não houve corte de cartões nem rolagem da página nos viewports de 1280×720 e 2133×1000. Não houve alteração da comunicação ou acesso ao PI.

Implementado e verificado no código:

- [x] Configuração operacional `config.toml`, referência separada e nomenclaturas operacionais.
- [x] Aplicação restrita a fontes PI reais, sem geração local de medições.
- [x] Tendências e limites absolutos independentes com saídas autorizadas.
- [x] Verificações de engenharia separadas dos arquivos de execução.
- [x] Prévia visual isolada em `tools/`, sem PI, com habilitação explícita no frontend servido apenas pela porta 8769.

Antes da liberação no ambiente:

- [ ] Preencher PI Data Archive, inventário real, entradas e saídas aprovadas.
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

Limitações a avaliar: persistência/restauração de estados; leitura histórica; isolamento de chamadas COM bloqueadas; confirmação de escrita por releitura. A existência de código e verificações locais não substitui o comissionamento no PI.

