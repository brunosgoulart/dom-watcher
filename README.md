# Runtime Monitor

Monitor local para coletar métricas de servidores SCADA no PI Data Archive, avaliar tendências e limites absolutos, e disponibilizar um contrato JSON para a interface operacional.

## Estado atual

A API continua somente leitura e não serve arquivos estáticos. A interface operacional em `web/` é independente e consome exclusivamente o contrato `GET /api/v1/status`.

O adaptador operacional é o AF SDK em modo somente leitura. Escritas no PI continuam desabilitadas por padrão e o adaptador AF SDK as rejeita.

## Executar com PI real

Na raiz do projeto:

```powershell
python -m pip install -r scada_api/requirements.txt
python -B scada_api/server.py --config scada_api/config.toml --check-config
python -B scada_api/server.py --config scada_api/config.toml --port 8768
```

Consulte o estado em [http://127.0.0.1:8768/api/v1/status](http://127.0.0.1:8768/api/v1/status). A API atende somente em loopback e não possui endpoints HTTP de mutação.

## Interface orbital

Sem carregar `config.toml`, conectar ao PI ou escrever pontos:

```powershell
python -B scada_api/server.py --simulate --port 8769
```

O endpoint será `http://127.0.0.1:8769/api/v1/status`. A resposta traz `"source": "simulated"` e preserva um cenário básico de três servidores: estável, em atenção e crítico. Esse modo usa um SQLite temporário e é descartado ao encerrar o processo.

Em outro terminal, abra a interface no mesmo contexto de origem da API:

```powershell
python -B tools/interface_preview.py --port 8770 --api-port 8769
```

Acesse `http://127.0.0.1:8770`. A aplicação usa exclusivamente a interface orbital em `web/`, com uma órbita 3D para priorizar CPU, memória, threads, filas e erros. Dados sem qualidade ou ausentes aparecem como `Sem dados` ou `Estado não confirmado`; a interface não interpreta ausência como normalidade.

## Estrutura

- `web/`: interface orbital operacional, sem dependências externas.
- `tools/interface_preview.py`: host local da interface e proxy somente-leitura para a API.
- `scada_api/`: serviço, API, configuração operacional, diagnóstico AF SDK e fonte simulada.
- `tests/python/`: testes do backend e do contrato simulado.
- `.vscode/launch.json`: configuração de execução no editor.

Detalhes de configuração, tendências, segurança e implantação estão em [scada_api/README.md](scada_api/README.md).
