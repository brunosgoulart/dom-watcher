# Runtime Monitor

Monitoramento de servidores SCADA com coleta no PI Data Archive, alarmes de tendência e limites absolutos independentes.

## Operação

A configuração operacional é `scada_api/config.toml`, mantida localmente e ignorada pelo Git. A estrutura de referência está em `scada_api/config.reference.toml`. Preencha os dados do ambiente antes de iniciar a coleta; sem configuração, a interface indica indisponibilidade.

```powershell
python -m pip install -r scada_api/requirements.txt
python -B scada_api/server.py --config scada_api/config.toml --check-config
python -B scada_api/server.py --config scada_api/config.toml --port 8768
```

Acesse `http://127.0.0.1:8768/#overview`. A API e o painel atendem somente loopback. A escrita PI vem desabilitada; AF SDK é somente leitura.

O adaptador adotado é `piAdapter = "af-sdk"`, conforme a configuração de referência. Instale o AF SDK no host e configure `piAfSdkDll` com o caminho da DLL, se diferente do padrão.

As entradas disponíveis de COGCGPRO12, COGCGPRO34 e COGCGPRO56 estão mapeadas em `scada_api/config.cogcgpro.toml` (16 métricas existentes por servidor, sem escrita). Para outra instalação, copie esse perfil para o `config.toml` local e preencha `piServer` e o caminho da DLL conforme o ambiente. Não substitua uma configuração operacional existente sem preservar seus parâmetros. Os pontos ainda não associados às métricas e as verificações de unidades estão descritos em `scada_api/README.md`.

`--check-config` verifica configuração e dependências locais sem conectar ao historiador nem escrever. Retorna código 0 quando essas verificações passam e 2 quando há pendências; não comprova autenticação nem existência das tags. Use o mesmo Python que executará o serviço. A tela mostra as medições válidas individualmente, mesmo durante a formação do histórico das tendências; dados vencidos ou sem qualidade não são exibidos como atuais.

Consulte [configuração, alarmes, segurança e implantação](scada_api/README.md). As pendências de ambiente devem ser resolvidas antes da liberação operacional.

## Estrutura

- `scada_api/`: serviço, configuração e diagnósticos.
- `web/`: interface operacional.
- `tests/`: verificações automatizadas, separadas da aplicação.
- `.vscode/launch.json`: configuração de execução no editor.
