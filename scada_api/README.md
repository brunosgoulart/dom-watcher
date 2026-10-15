# README

Atualizado em: 14/10/2026.

## Regra obrigatória de manutenção para IAs e desenvolvedores

Toda IA ou pessoa que alterar o código desta solução deverá, na mesma entrega:

1. Revisar e atualizar a descrição do funcionamento neste README quando a alteração modificar o comportamento, a arquitetura, as configurações, as entradas, as saídas ou os limites do sistema.
2. Revisar e atualizar a lista de pendências: marcar como concluído somente o que tiver sido efetivamente implementado e verificado, acrescentar novas pendências e manter explícitas as limitações ainda existentes.
3. Distinguir implementação, teste offline e validação em ambiente real. Testes com mocks não comprovam conexão ou publicação no PI de produção.
4. Atualizar a data deste documento e informar os testes realizados e as verificações que não puderam ser executadas.
5. Não afirmar que a solução está pronta para produção enquanto houver pendências obrigatórias de comissionamento.

Este documento deve refletir o código atual, não apenas propostas. Não contém histórico de versões. O projeto `must-processor` é referência somente de leitura e não deve ser alterado neste trabalho.

## Escopo e estado atual

A solução monitora até sete servidores SCADA, lê medições do PI Data Archive, calcula alarmes de tendência, disponibiliza os resultados em uma API local e os exibe em uma página web. Também pode publicar os estados dos alarmes em tags de saída do PI.

A chegada das medições ao PI via SCADA já está implementada externamente e não é uma pendência desta solução. A coleta anterior à chegada ao PI está fora deste documento.

A implementação está disponível para integração e comissionamento e foi validada no ambiente Windows atual usando o adaptador AF SDK do PI. Na configuração de exemplo, `piServer` está vazio, os mapeamentos de entrada estão vazios e `enableWrites=false`. Portanto, essa configuração não conecta ao PI nem publica alarmes.

## Componentes

- `../web/`: front-end estático em HTML, CSS e JavaScript, sem login.
- `server.py`: configuração, aquisição em segundo plano, cache e API HTTP.
- `pi_client.py`: conexão PI SDK COM compatível e rota AF SDK via pythonnet/netfx, leitura de snapshots e escrita restrita dos estados.
- `trends.py`: cálculo das tendências e estados por métrica e servidor.
- `trend_output.py`: publicação dos estados, heartbeat e retentativas.
- `config.example.toml`: exemplo de configuração com sete posições e nomes ilustrativos.
- `test_server.py` e `test_trends.py`: testes offline.

Este serviço é independente da aplicação analítica em `../app/`. Não utiliza o adaptador AF SDK dessa aplicação, SQLite ou modelos de machine learning.

## Funcionamento do sistema

### 1. Conexão e leitura

O serviço aceita seleção explícita entre `pi-sdk-com` e `af-sdk`, sem fallback automático. O teste real de uma tag relatado em 14/10/2026 utilizou AF SDK via `pythonnet`, runtime `netfx` e `OSIsoft.AFSDK.dll`, com `PIServer.FindPIServer(...)` e `Connect()`. Esse teste não representa comissionamento completo do serviço ou do painel. O modo AF SDK reutiliza a sessão e o cache de PIPoints entre coletas; uma exceção de leitura do snapshot descarta a sessão para reconectar no próximo ciclo. Falhas de localização de uma tag continuam isoladas dessa sessão.

A autenticação usa a identidade Windows do processo. A conexão é direta ao PI Data Archive e a PIPoints; não utiliza PI Web API nem navegação em elementos do AF/PI System Explorer. Os nomes das tags precisam ser mapeados explicitamente, sem descoberta automática.

Uma única thread executa as chamadas ao adaptador PI. A inicialização COM ocorre somente no modo `pi-sdk-com`. Ela consulta os snapshots a cada 30 segundos no padrão. As medições de origem possuem cadência de 60 segundos; leituras repetidas de um mesmo timestamp não contam como novas medições.

São suportadas 22 métricas: CPU, RAM, memória privada, threads, filas local/remota, ocupação, erros por minuto, CPU do servidor, handles, espaço livre em disco, fila e atraso de E/S, tamanho do arquivo informado pela tag, tempo de execução, uptime e taxas de entrada/tratamento/descarte das filas. Apenas as tags configuradas são lidas. O serviço não lê arquivos locais nem calcula taxas a partir de contadores brutos.

### 2. Qualidade das medições

Valores ausentes, ruins, questionáveis, booleanos, não numéricos, não finitos, negativos, futuros ou antigos são tratados como indisponíveis, nunca como zero. Percentuais devem estar entre 0 e 100. A idade máxima padrão é 120 segundos. A configuração também é rejeitada na inicialização quando `tags` não for um mapeamento de métricas para nomes explícitos de PI Points.

A validade e os cálculos usam os timestamps PI das medições, não o horário de consulta. CPU, RAM, erros por minuto e as duas filas pendentes são essenciais para confirmar a coleta do servidor. O timestamp geral corresponde ao mais antigo entre essas medições essenciais.

Falhas de leitura são isoladas por métrica. Falha de conexão ou da API não gera dados simulados nem confirmação artificial de saúde.

### 3. Alarmes de tendência

Cada servidor possui seis análises independentes: CPU, RAM, memória privada, erros de scripts por minuto, fila local e fila remota.

O alarme de atenção dispara quando a elevação se mantém por uma janela completa de 10 minutos no padrão. Com cadência de 60 segundos, são necessárias 11 medições cobrindo pelo menos 600 segundos reais. Não há confirmações adicionais para ativar após completar esse período.

A tendência usa inclinação robusta Theil–Sen e variação líquida positiva na janela completa e em cada trecho móvel de quatro pontos, equivalente a três minutos na cadência atual. Pequenas quedas ou estabilidade local podem ocorrer; picos isolados, inversão e estabilidade prolongada não satisfazem a regra. Qualquer elevação sustentada pode ativar atenção, mesmo que seja habitual.

A referência histórica anterior, de 30 minutos no padrão, é opcional para ativação e serve para classificar gravidade. O crescimento acima dessa referência, normalizado pelo ruído e pela resolução configurada, pode gerar estado crítico quando o score alcança 6. RAM e memória privada possuem uma análise complementar de 15 minutos para gravidade, sem atrasar a ativação pela janela principal.

A recuperação ou redução de gravidade exige três novas medições qualificadas no padrão. Uma lacuna maior que 90 segundos reinicia a construção da janela. Dados inválidos prevalecem na saída, preservando o último estado confirmado internamente durante a execução.

| Estado | Significado |
|---|---|
| 0 | Sem elevação sustentada confirmada |
| 10 | Elevação sustentada de atenção confirmada |
| 20 | Elevação sustentada crítica confirmada |
| 30 | Histórico insuficiente ou reconstrução após lacuna |
| 40 | Medição inválida, ausente, antiga, futura ou fora de ordem |

No bloco `[trend]`, `windowSeconds` é parametrizável entre 120 e 3600 segundos, `referenceSeconds` entre 600 e 7200 e `memoryWindowSeconds` entre 120 e 3600, nunca menor que a janela principal. Todas são múltiplos de 60. A cadência suportada atualmente permanece em 60 segundos. Também são configuráveis o score crítico, a resolução de cada métrica e as amostras de recuperação. Reinicie o serviço após alterar a configuração.

### 4. Publicação dos alarmes no PI

A escrita é opcional e vem desabilitada. O adaptador AF SDK está restrito à leitura neste projeto: `enableWrites=true` com `piAdapter = "af-sdk"` é rejeitado na inicialização com mensagem clara, porque a rota AF SDK validada no host foi usada apenas para coleta e não para gravação de estados. São seis tags de estado por servidor, até 42 saídas para sete servidores. O padrão sugerido é `CSEO.<SERVIDOR>.SCADA.Trend.<MÉTRICA>.State`, com os sufixos CPU, RAM, PrivateMemory, ScriptErrors, LocalQueue e RemoteQueue.

As tags devem existir previamente no PI. O serviço não cria tags nem altera sua configuração. A inicialização valida nomes de saída no namespace `.SCADA.Trend.*.State`, duplicidades, separação entre entradas e saídas e mapeamento completo das seis análises quando a escrita está habilitada.

Somente tags explicitamente autorizadas podem receber os códigos 0, 10, 20, 30 e 40. A publicação usa `UpdateValue`, timestamp PI atual e substituição de duplicados. Estados estáveis recebem heartbeat de 60 segundos; falhas têm retentativa de 30 segundos no padrão, sempre com o estado mais recente.

O status de publicação aparece na API e falhas ficam visíveis no painel. Sucesso da chamada SDK não inclui leitura posterior para confirmar a gravação. Sem conexão PI, o estado inválido não pode ser publicado naquele momento; é necessário monitorar também o heartbeat das saídas.

### 5. API e painel web

`GET /api/v1/status` entrega o cache com métricas, qualidade, timestamps, tendências, estados de publicação e política de análise. O campo `source` identifica `af-sdk` ou `pi-sdk-com`; o painel aceita ambos e identifica o adaptador no indicador de conexão. Abrir mais abas não aumenta as consultas ao PI. Não existe API HTTP de mutação.

O navegador atualiza a cada 10 segundos no padrão. A visão geral foi desenhada para TV, com nomes e indicadores ampliados, radar operacional visual, lista de alarmes e acesso aos detalhes de cada servidor.

O painel “Desempenho do Ambiente SCADA” mantém posições fixas na ordem configurada, sem ordenar pelas métricas. As barras CPU/RAM utilizam limites absolutos visuais demonstrativos, diferentes da regra de tendência usada pelos alarmes. Radar e inventário possuem suas próprias regras de organização e paginação.

Os gráficos de fluxo acumulam até 120 amostras por fila e servidor somente durante a execução. Não existe consulta retroativa ao histórico PI. Pausar a atualização no navegador não interrompe aquisição, cálculo ou publicação no serviço.

### 6. Limites atuais

Históricos e estados internos ficam em memória. Reiniciar o serviço perde o histórico local e exige reconstruir a janela com medições válidas; o histórico do PI não é apagado. Não há persistência ou restauração dos alarmes confirmados após reinício.

O HTTP atende somente `127.0.0.1`, sem autenticação. Uma TV em outro computador não acessa diretamente esse servidor. O timeout de oito segundos do navegador não interrompe chamadas COM nativas bloqueadas.

## Execução e verificação

Para conexão real são necessários Windows, Python 3.11+, runtime .NET Framework 4.x, `pythonnet`, a DLL AF SDK instalada em `C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll`, e uma conta Windows autorizada no PI. O caminho nativo `PI SDK COM` continua disponível, mas no host validado a leitura real foi obtida somente via AF SDK.

No diretório `C:\dev\dom-watcher`:

```powershell
python -m pip install -r scada_api/requirements.txt
python -B scada_api/server.py --config scada_api/config.example.toml --port 8768
```

Abra `http://127.0.0.1:8768/#overview`. Em produção, utilize uma cópia própria da configuração, preenchida com os dados reais, passando seu caminho em `--config`.

```powershell
python -B scada_api/test_server.py
python -B scada_api/test_trends.py
```

Verificação desta revisão em 14/10/2026: 44 testes Python offline e quatro testes Node.js aprovados, além de verificação de sintaxe JavaScript. Os testes Node geram respostas pelo `SnapshotStore` real e verificam sua aceitação pelo JavaScript para ambos os adaptadores. Os testes de conexão e reconexão usam mocks; nenhum acesso ao PI real ou escrita foi executado nesta revisão. A leitura real de uma tag pelo cliente AF SDK foi relatada anteriormente na estação PI e precisa ser repetida no ambiente de implantação.

### Preparação da implantação de leitura em 15/10/2026

1. Atualize a instalação com a revisão aprovada. Crie uma cópia local de `config.example.toml` como `scada_api/config.pi-test.toml`, sem versionar os dados do ambiente.
2. Selecione `piAdapter = "af-sdk"`, confira `piAfSdkDll`, informe o PI Data Archive e mantenha `enableWrites = false`. No TOML, use barras duplas em strings com aspas duplas ou um caminho literal com aspas simples.
3. Cadastre inicialmente um servidor e mapeie suas tags reais, sem nomes presumidos. CPU, RAM, erros/min e filas pendentes local/remota são essenciais para `collecting=true`; memória privada também é necessária para completar as seis análises de tendência.
4. Prepare o ambiente Windows com AF SDK instalado e uma conta autorizada. Instale as dependências no ambiente virtual de execução:

```powershell
python -m venv .venv-afsdk
& '.\.venv-afsdk\Scripts\python.exe' -m pip install -r scada_api/requirements.txt
& '.\.venv-afsdk\Scripts\python.exe' -u scada_api/server.py --config scada_api/config.pi-test.toml --port 8768
```

5. Abra `http://127.0.0.1:8768/api/v1/status` e `http://127.0.0.1:8768/#overview`. Confirme `source=af-sdk`, valores, unidades, qualidade e timestamps recentes. Durante a construção do histórico de tendência, a interface pode mostrar estado desconhecido e ocultar os valores; confira as métricas individuais na API durante esse período.
6. Observe por pelo menos 15 minutos e valide perda/retomada de conexão em ambiente controlado. Registre as evidências e só então amplie o inventário. A conta Windows do processo define a identidade usada: ao executar manualmente é a conta do terminal; serviço/tarefa agendada usa a conta configurada para a execução.

Verificações reproduzíveis, a partir da raiz do projeto:

```powershell
& '.\.venv-afsdk\Scripts\python.exe' -B -m unittest discover -s scada_api -p 'test_*.py'
$env:PYTHON = (Resolve-Path '.\.venv-afsdk\Scripts\python.exe').Path
node --test web/test-data-source.cjs
```

Node.js é necessário para os testes do frontend, não para executar o painel. A configuração de exemplo mantém COM e entradas vazias, portanto iniciá-la sem ajustes não valida a conexão AF SDK. O serviço permanece limitado a loopback e o acesso de uma TV remota exige a implantação de rede descrita nas pendências. O AF SDK continua bloqueado para escrita; nenhuma alteração nesta revisão habilita publicação no PI.

Arquivos `__pycache__`, bytecode e o resultado local `real_read_afsdk.txt` foram retirados da versão rastreada; os conteúdos anteriores continuam recuperáveis no histórico Git. O `.gitignore` impede sua inclusão futura. Isso não remove dados do histórico nem os arquivos da estação de teste.

## Pendências

### Obrigatórias para comissionamento e produção

- [ ] Informar o PI Data Archive e cadastrar os servidores reais, até sete, na ordem desejada.
- [ ] Mapear as tags reais de entrada e conferir unidades, qualidade e timestamps; memória privada é esperada em KiB, erros e fluxos já devem estar em taxas por minuto.
- [ ] Validar publicação/heartbeat das entradas e sua exceção/compressão para assegurar novas medições a cada 60 segundos e evitar falsas lacunas ou dados antigos.
- [ ] Validar Windows, Python, PI SDK, arquitetura COM e `pywin32` no computador de execução.
- [ ] Validar autenticação da conta Windows e permissões de leitura das entradas e escrita somente nas saídas aprovadas.
- [ ] Provisionar ou confirmar as tags reais de saída, seus tipos numéricos, códigos, exceção/compressão e retenção.
- [ ] Validar leitura real, comportamento dos alarmes de 10 minutos, recuperação, qualidade inválida e falhas de conexão em ambiente controlado.
- [ ] Habilitar `enableWrites=true` somente após aprovação dos mapeamentos e permissões; confirmar as gravações no PI, incluindo transições e heartbeat.
- [ ] Aprovar parâmetros de gravidade, resoluções e limites absolutos visuais conforme o ambiente real.
- [ ] Definir execução contínua: conta do serviço, inicialização automática, supervisão, reinício e diagnóstico operacional.
- [ ] Se a TV estiver em outro computador, implantar acesso de rede controlado com proxy, TLS, autenticação corporativa e regras de firewall; validar a apresentação na TV real.
- [ ] Registrar evidências do teste ponta a ponta e a aprovação para produção neste documento.

### Limitações a avaliar, sem compromisso de implementação

- [ ] Decidir se é necessária persistência/restauração de histórico e estados após reinício.
- [ ] Decidir se é necessária leitura histórica PI para reduzir o aquecimento inicial.
- [ ] Avaliar isolamento e supervisão para chamadas COM bloqueadas; atualmente não existe timeout que cancele a chamada nativa.
- [ ] Avaliar confirmação de escrita por releitura e diagnóstico operacional adicional.

A chegada dos dados ao PI via SCADA está resolvida externamente e não deve ser reintroduzida como pendência. Nenhum item deve ser marcado como concluído apenas por existir código: as pendências de ambiente precisam de validação real.

