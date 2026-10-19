from __future__ import annotations

import argparse
import importlib.util
import platform
import struct
import sys
from pathlib import Path


def check_path(path: str) -> bool:
    return Path(path).exists()


def diagnose_native_sdk(server_name: str, tag_name: str | None = None) -> int:
    print(f"== Diagnóstico do SDK nativo PI para servidor '{server_name}' ==")
    print(f"Python: {platform.python_version()} | bits: {struct.calcsize('P') * 8}")
    print(f"OS: {platform.system()} {platform.release()} | platform: {sys.platform}")

    print("\n== Verificações básicas ==")
    for candidate in [
        r"C:\Program Files\PIPC",
        r"C:\Program Files (x86)\PIPC",
    ]:
        exists = check_path(candidate)
        print(f"{candidate}: {'OK' if exists else 'NÃO ENCONTRADO'}")

    print("\n== pywin32 ==")
    pywin32 = importlib.util.find_spec("win32com") is not None
    print(f"win32com instalado: {'SIM' if pywin32 else 'NÃO'}")

    if not pywin32:
        print("\nResultado: falha antes do SDK porque o módulo win32com não está instalado.")
        return 1

    print("\n== Verificação de COM do PI SDK ==")
    try:
        import win32com.client

        sdk = win32com.client.Dispatch("PISDK.PISDK")
        print("PI SDK COM: OK")
        print(f"Objeto instanciado: {type(sdk).__name__}")
    except Exception as exc:  # pragma: no cover - diagnostic only
        print("PI SDK COM: FALHOU")
        print(f"Erro: {exc}")
        print("\nDiagnóstico: o PI SDK COM não está registrado no host, ou a instalação está incompleta.")
        print("Possíveis causas:")
        print("- PI SDK não instalado no host")
        print("- arquitetura incompatível (32/64 bits)")
        print("- Python e PI SDK em arquiteturas diferentes")
        print("- COM não registrado no sistema")
        print("- sessão executada em máquina/host errado")
        return 2

    print("\n== Verificação de abertura do servidor ==")
    try:
        import win32com.client

        sdk = win32com.client.Dispatch("PISDK.PISDK")
        server = sdk.Servers.Item(server_name)
        print(f"Servidor localizado: {server_name}")
        server.Open()
        print(f"server.Connected: {bool(server.Connected)}")
        if tag_name:
            print(f"\n== Verificação de leitura da tag '{tag_name}' ==")
            point = server.PIPoints.Item(tag_name)
            snapshot = point.Data.Snapshot
            value = snapshot.Value
            ts = snapshot.TimeStamp
            print(f"valor: {value!r}")
            print(f"timestamp: {ts}")
            print(f"isGood: {getattr(snapshot, 'IsGood', None)}")
        server.Close()
        print("\nResultado: conexão nativa ao PI SDK OK")
        return 0
    except Exception as exc:  # pragma: no cover - diagnostic only
        print("Abertura do servidor PI: FALHOU")
        print(f"Erro: {exc}")
        print("\nDiagnóstico: o host tem o SDK instalado, mas o servidor não está acessível ou o usuário não tem autorização.")
        print("Verifique:")
        print("- nome do servidor correto")
        print("- permissões de rede/Windows do usuário")
        print("- PI Data Archive disponível")
        print("- PI SDK registrado e compatível com a arquitetura")
        return 3


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnóstico de conexão nativa PI SDK COM.")
    parser.add_argument("--server", required=True, help="Nome do servidor PI a verificar.")
    parser.add_argument("--tag", default=None, help="(Opcional) Tag PI para validar leitura após abrir o servidor.")
    args = parser.parse_args()
    return diagnose_native_sdk(args.server, args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
