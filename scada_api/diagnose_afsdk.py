import argparse
import os
import tomllib
from pathlib import Path
import sys
import traceback

AF_DLL = r"C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll"
SERVER = ""
TAG = ""


def direct_read():
    print("[direct] START", flush=True)
    print(f"[direct] executable={sys.executable}", flush=True)
    print(f"[direct] dll={AF_DLL}", flush=True)
    print(f"[direct] server={SERVER}", flush=True)
    print(f"[direct] tag={TAG}", flush=True)
    print("[direct] loading pythonnet netfx", flush=True)
    try:
        import pythonnet
        pythonnet.load("netfx")
        print("[direct] pythonnet.load('netfx') OK", flush=True)
    except Exception:
        print("[direct] pythonnet.load('netfx') FAILED", flush=True)
        traceback.print_exc()
        raise

    print("[direct] adding reference", flush=True)
    try:
        import clr
        clr.AddReference(AF_DLL)
        print("[direct] clr.AddReference OK", flush=True)
    except Exception:
        print("[direct] clr.AddReference FAILED", flush=True)
        traceback.print_exc()
        raise

    try:
        from OSIsoft.AF.PI import PIServer, PIPoint
        print("[direct] imported OSIsoft.AF.PI", flush=True)
        print("[direct] resolving server", flush=True)
        server = PIServer.FindPIServer(SERVER)
        print(f"[direct] server object={server}", flush=True)
        if server is None:
            raise RuntimeError(f"PIServer not found: {SERVER}")
        print("[direct] connecting", flush=True)
        server.Connect()
        print(f"[direct] connected={bool(getattr(server, 'Connected', False))}", flush=True)

        point = PIPoint.FindPIPoint(server, TAG)
        print(f"[direct] point object={point}", flush=True)
        if point is None:
            raise RuntimeError(f"PIPoint not found: {TAG}")

        snapshot = point.Snapshot()
        print(f"[direct] snapshot type={type(snapshot)}", flush=True)
        print(f"[direct] value={getattr(snapshot, 'Value', None)}", flush=True)
        print(f"[direct] status={getattr(snapshot, 'Status', None)}", flush=True)
        print(f"[direct] isgood={getattr(snapshot, 'IsGood', None)}", flush=True)
        print(f"[direct] timestamp={getattr(snapshot, 'Timestamp', None)}", flush=True)
        print("[direct] SUCCESS", flush=True)
        return 0
    except Exception:
        print("[direct] EXCEPTION", flush=True)
        traceback.print_exc()
        return 1
    finally:
        try:
            import clr
            from OSIsoft.AF.PI import PIServer
            if 'server' in locals():
                print("[direct] disconnecting", flush=True)
                server.Disconnect()
        except Exception:
            print("[direct] disconnect FAILED", flush=True)
            traceback.print_exc()


def client_read():
    print("[client] START", flush=True)
    print(f"[client] executable={sys.executable}", flush=True)
    print(f"[client] dll={AF_DLL}", flush=True)
    print(f"[client] server={SERVER}", flush=True)
    print(f"[client] tag={TAG}", flush=True)
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from pi_client import PIReadClient
        client = PIReadClient(SERVER, adapter='af-sdk', af_sdk_dll=AF_DLL)
        print("[client] created PIReadClient", flush=True)
        print("[client] calling connect()", flush=True)
        client.connect()
        print(f"[client] connected={bool(getattr(client.server, 'Connected', False))}", flush=True)
        print("[client] calling read()", flush=True)
        sample = client.read(TAG)
        print(f"[client] sample={sample}", flush=True)
        print("[client] SUCCESS", flush=True)
        return 0
    except Exception:
        print("[client] EXCEPTION", flush=True)
        traceback.print_exc()
        return 1
    finally:
        try:
            if 'client' in locals():
                print("[client] disconnecting", flush=True)
                client.close()
        except Exception:
            print("[client] disconnect FAILED", flush=True)
            traceback.print_exc()


def main():
    global AF_DLL, SERVER, TAG
    parser = argparse.ArgumentParser(description="Diagnóstico de leitura AF SDK.")
    parser.add_argument("mode", choices=("direct", "client"), nargs="?", default="client")
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.toml"))
    parser.add_argument("--server")
    parser.add_argument("--tag")
    args = parser.parse_args()
    with args.config.open("rb") as stream:
        config = tomllib.load(stream)
    AF_DLL = config.get("piAfSdkDll", AF_DLL)
    SERVER = args.server or config.get("piServer", "")
    TAG = args.tag or next((tag for server in config.get("servers", []) for tag in server.get("tags", {}).values()), "")
    if not SERVER or not TAG:
        parser.error("Configure piServer e uma tag de entrada, ou informe --server e --tag.")
    mode = args.mode
    if mode == "direct":
        raise SystemExit(direct_read())
    if mode == "client":
        raise SystemExit(client_read())
    print(f"unsupported mode: {mode}", flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
