# Runtime Monitor

Monitoramento de servidores SCADA com coleta no PI Data Archive, alarmes de tendência e limites absolutos independentes.

## Operação

A configuração operacional é `scada_api/config.toml`, incluída no Git com `pidatapro`, AF SDK e as entradas dos três servidores COGCGPRO. Não contém credenciais e mantém a escrita desabilitada. A estrutura de referência está em `scada_api/config.reference.toml`. Confira SDK e permissões do ambiente antes de iniciar a coleta.

```powershell
python -m pip install -r scada_api/requirements.txt
python -B scada_api/server.py --config scada_api/config.toml --check-config
python -B scada_api/server.py --config scada_api/config.toml --port 8768
```

Acesse `http://127.0.0.1:8768/#overview`. A API e o painel atendem somente loopback. A escrita PI vem desabilitada; AF SDK é somente leitura.

O adaptador adotado é `piAdapter = "af-sdk"`, conforme a configuração de referência. Instale o AF SDK no host e configure `piAfSdkDll` com o caminho da DLL, se diferente do padrão.

As 26 tags disponíveis de COGCGPRO12, COGCGPRO34 e COGCGPRO56 estão mapeadas em `scada_api/config.toml` e `scada_api/config.cogcgpro.toml` (78 entradas, sem escrita). A visão geral alterna entre três grupos de apresentação, com seleção manual; a página individual reúne os 26 pontos em seis seções. Timestamp de coleta, arquivo lido e status preservam o conteúdo publicado no PI. Não substitua uma configuração operacional existente sem preservar seus parâmetros. Consulte as verificações de unidades em `scada_api/README.md`.

`--check-config` verifica configuração e dependências locais sem conectar ao historiador nem escrever. Retorna código 0 quando essas verificações passam e 2 quando há pendências; não comprova autenticação nem existência das tags. Use o mesmo Python que executará o serviço. A tela mostra as medições válidas individualmente, mesmo durante a formação do histórico das tendências; dados vencidos ou sem qualidade não são exibidos como atuais.

Consulte [configuração, alarmes, segurança e implantação](scada_api/README.md). As pendências de ambiente devem ser resolvidas antes da liberação operacional.

## Estrutura

- `scada_api/`: serviço, configuração e diagnósticos.
- `web/`: interface operacional.
- `tests/`: verificações automatizadas, separadas da aplicação.
- `.vscode/launch.json`: configuração de execução no editor.
