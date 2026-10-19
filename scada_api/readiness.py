"""Read-only deployment checks. Never creates a PI client or opens a connection."""
import importlib.util
import os

REQUIRED_INPUTS = ("runCPU", "runMemory", "runErrorsPerMinute", "runLocalPending", "runRemotePending")


def configuration_report(config):
    issues = []
    if not config.get("piServer", "").strip():
        issues.append("Informe piServer no arquivo operacional.")
    servers = []
    for item in config["servers"]:
        missing = [key for key in REQUIRED_INPUTS if not item.get("tags", {}).get(key)]
        servers.append({"id": item["id"], "inputCount": len(item.get("tags", {})), "missingEssentialInputs": missing})
        if missing:
            issues.append(f"{item['id']}: mapeie as entradas essenciais: {', '.join(missing)}.")
    if os.name != "nt":
        issues.append("Execute a coleta PI em Windows com o SDK instalado.")
    adapter = config.get("piAdapter", "pi-sdk-com")
    modules = ("pythonnet",) if adapter == "af-sdk" else ("win32com", "pythoncom")
    for module in modules:
        try:
            available = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            available = False
        if not available:
            issues.append(f"Dependência ausente no Python de execução: {module}.")
    return {"readyForConnection": not issues, "adapter": adapter,
            "writesEnabled": config.get("enableWrites", False), "servers": servers,
            "issues": issues, "scope": "Configuração e dependências locais; não verifica conexão, permissões, existência das tags ou valores PI."}
