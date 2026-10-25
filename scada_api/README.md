# Runtime Monitor API

Serviço local de coleta PI para monitoramento SCADA. Ele lê métricas, valida qualidade e frescor, calcula tendências e limites absolutos e expõe um snapshot JSON. Não inclui interface web.

## Contrato HTTP

O servidor escuta somente em `127.0.0.1`.

- `GET /api/v1/status`: snapshot atual do serviço.
- Qualquer outro caminho retorna `403`.
- Não existem endpoints HTTP de escrita ou configuração.

O snapshot contém `source`, `serviceStatus`, `generatedAt`, `servers`, `alarmHistory` e a política de tendências. Cada servidor inclui métricas, qualidade/timestamp por métrica, tendências, limites absolutos e históricos de filas.

`source` é `af-sdk`, `pi-sdk-com` ou `simulated`. Uma futura interface deve apresentar a origem `simulated` claramente e nunca tratá-la como leitura operacional.

## Adaptadores e segurança

- `af-sdk`: caminho recomendado neste ambiente Windows. Requer .NET Framework, `pythonnet` e `piAfSdkDll`. É somente leitura neste projeto.
- `pi-sdk-com`: mantido para compatibilidade. Requer PI SDK COM e `pywin32` compatíveis.
- Não há troca automática de adaptador.
- Escrita no PI exige `enableWrites = true`, adaptador COM, pontos de saída aprovados e permissões adequadas. AF SDK com escrita é rejeitado já na configuração.

## Configuração real

`config.toml` contém o perfil operacional; `config.reference.toml` é uma referência sem tags de entrada. Os caminhos Windows em TOML devem usar aspas simples ou barras `/`, por exemplo:

```toml
piAdapter = "af-sdk"
piAfSdkDll = 'C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll'
enableWrites = false
```

Cada servidor pode mapear até 32 métricas conhecidas em `[servers.tags]`. As cinco entradas essenciais são `runCPU`, `runMemory`, `runErrorsPerMinute`, `runLocalPending` e `runRemotePending`. Valores ruins, não numéricos quando exigidos, futuros ou vencidos são apresentados como indisponíveis, nunca como zero.

As tendências usam seis métricas: CPU, memória, PVT, erros por minuto, fila local e fila remota. A cadência é de 60 s; a avaliação usa inclinação Theil–Sen e estados 0 (normal), 10 (atenção), 20 (crítico), 30 (histórico insuficiente) e 40 (amostra inválida). Limites absolutos são independentes das tendências.

## Execução

```powershell
python -m pip install -r scada_api/requirements.txt
python -B scada_api/server.py --config scada_api/config.toml --check-config
python -B scada_api/server.py --config scada_api/config.toml --port 8768
```

`--check-config` não abre conexão PI e não escreve. Ele valida o arquivo, o adaptador e as dependências locais, mas não confirma credenciais Windows, acesso ao PI ou existência das tags.

Para desenvolver uma interface sem PI, use `--simulate --port 8769`. Esse modo não carrega o arquivo operacional, não abre conexões e não persiste seu SQLite temporário após o encerramento.

## Testes

```powershell
python -B -m unittest discover -s tests/python
```

Os testes isolam SDK e PI por mocks. Eles verificam o contrato e as proteções do código, mas não substituem comissionamento contra o historiador real.

## Antes de operar em produção

- Confirmar DLL/SDK, permissões da conta Windows e acesso ao PI Data Archive.
- Validar tags, unidades, qualidade e timestamps reais.
- Manter `enableWrites = false` até que saídas, permissões e transições sejam aprovadas.
- Definir supervisão do processo, backup do SQLite e, caso necessário, proxy corporativo com TLS/autenticação para acesso remoto à API.
