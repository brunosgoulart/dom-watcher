"""Version: 1.5 | Date: 14/10/2026
Changes: Selected COM or read-only AF SDK explicitly, validated the AF assembly path and limited COM initialization to the COM adapter.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import threading
import time
import tomllib
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pi_client import PIReadClient
from trends import TREND_METRICS, TrendEngine
from trend_output import TrendPublisher
from absolute_alarms import evaluate_absolute, validate_absolute

METRICS = (
    "runCPU", "runMemory", "runPVT", "runTRD", "runLocalPending",
    "runRemotePending", "runOccupancy", "runErrorsPerMinute", "serverCPU",
    "serverHDL", "driveCFreeMB", "ioQueuePending", "ioQueueAvgDelay",
    "etlFileSizeMB", "totalTime", "runUptimeMinutes",
    "localEnteredRate", "localHandledRate", "localDiscardPercent",
    "remoteEnteredRate", "remoteHandledRate", "remoteDiscardPercent",
)
ESSENTIAL = ("runCPU", "runMemory", "runErrorsPerMinute", "runLocalPending", "runRemotePending")
PERCENTAGES = ("runCPU", "runMemory", "runOccupancy", "serverCPU", "localDiscardPercent", "remoteDiscardPercent")
MAX_SERVERS = 7


def load_config(path: Path) -> dict:
    with path.open("rb") as stream:
        config = tomllib.load(stream)
    servers = config.get("servers", [])
    if not 1 <= len(servers) <= MAX_SERVERS:
        raise ValueError("Configure between one and seven servers")
    ids = [s.get("id", "") for s in servers]
    if any(not isinstance(i, str) or not i or not all(c.isalnum() or c in "-_" for c in i) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Server IDs must be unique and URL-safe")
    for server in servers:
        tags = server.get("tags", {})
        if not isinstance(tags, dict):
            raise ValueError("tags must map metric names to PI Point names")
        for key, tag in tags.items():
            if key not in METRICS or not isinstance(tag, str) or not tag.strip() or tag.lower().startswith("af:") or tag.startswith("\\\\"):
                raise ValueError("Use supported metric keys and explicit PI Point names")
    for key, default, minimum, maximum in (("pollSeconds", 30, 5, 3600), ("staleSeconds", 120, 5, 86400)):
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"Invalid {key}")
        config[key] = value
    if not isinstance(config.get("piServer", ""), str):
        raise ValueError("piServer must be a string")
    adapter = config.get("piAdapter", "pi-sdk-com")
    if adapter not in {"pi-sdk-com", "af-sdk"}:
        raise ValueError("piAdapter must be 'pi-sdk-com' or 'af-sdk'")
    config["piAdapter"] = adapter
    default_af_dll = r"C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll"
    af_dll = config.get("piAfSdkDll", default_af_dll)
    if not isinstance(af_dll, str) or not af_dll.strip():
        raise ValueError("piAfSdkDll must be a non-empty string")
    config["piAfSdkDll"] = af_dll
    if adapter == "af-sdk" and not os.path.exists(af_dll):
        raise FileNotFoundError(f"AF SDK DLL is missing: {af_dll}")
    enabled = config.get("enableWrites", False)
    if type(enabled) is not bool:
        raise ValueError("enableWrites must be boolean")
    if enabled and adapter == "af-sdk":
        raise ValueError("AF SDK adapter is read-only in this project; set enableWrites=false or select pi-sdk-com for writes.")
    inputs = {tag.casefold() for s in servers for tag in s.get("tags", {}).values()}
    outputs = []
    for server in servers:
        validate_absolute(server)
        outputs.extend(tag.casefold() for tag in server.get("absoluteOutputs", {}).values() if tag)
        mapping = server.get("outputs", {})
        if not isinstance(mapping, dict):
            raise ValueError("outputs must map metric names to PI Points")
        for key, tag in mapping.items():
            if key not in TREND_METRICS or not isinstance(tag, str) or not tag.strip() or tag != tag.strip() or ".SCADA.Trend." not in tag or not tag.endswith(".State") or tag.startswith("\\\\"):
                raise ValueError("Use explicit SCADA.Trend.*.State output PI Point names")
            outputs.append(tag.casefold())
        if enabled and (set(mapping) != set(TREND_METRICS) or not set(TREND_METRICS).issubset(server.get("tags", {}))):
            raise ValueError("Writing requires six explicit input and output tags per server")
    if len(outputs) != len(set(outputs)) or inputs.intersection(outputs):
        raise ValueError("Output tags must be unique and separate from input tags")
    if enabled and not config.get("piServer", "").strip():
        raise ValueError("Writing requires an explicit PI Data Archive")
    trend = config.setdefault("trend", {})
    if not isinstance(trend, dict):
        raise ValueError("trend must be a table")
    if type(trend.get("measurementSeconds", 60)) is not int or trend.get("measurementSeconds", 60) != 60:
        raise ValueError("measurementSeconds must be 60 for the current input cadence")
    trend["measurementSeconds"] = 60
    for key, default, minimum, maximum in (("windowSeconds", 600, 120, 3600), ("referenceSeconds", 1800, 600, 7200), ("memoryWindowSeconds", 900, 120, 3600)):
        value = trend.get(key, default)
        if type(value) is not int or not minimum <= value <= maximum or value % trend["measurementSeconds"]:
            raise ValueError(f"{key} must be a multiple of 60 between {minimum} and {maximum} seconds")
        trend[key] = value
    if trend["memoryWindowSeconds"] < trend["windowSeconds"]:
        raise ValueError("memoryWindowSeconds must not be shorter than windowSeconds")
    for key in ("activationSamples", "warningScore", "clearScore"):
        trend.pop(key, None)
    for key, default in (("criticalScore", 6.0),):
        value = trend.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"Invalid {key}")
        trend[key] = value
    for key in ("recoverySamples",):
        value = trend.get(key, 3)
        if type(value) is not int or not 2 <= value <= 10:
            raise ValueError(f"Invalid {key}")
        trend[key] = value
    resolution = trend.get("resolution", {})
    if not isinstance(resolution, dict):
        raise ValueError("resolution must be a table")
    for key, value in resolution.items():
        if key not in TREND_METRICS or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError("Resolution must be finite and positive")
    for key, default in (("outputHeartbeatSeconds", 60), ("writeRetrySeconds", 30)):
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 5 <= value <= 3600:
            raise ValueError(f"Invalid {key}")
        config[key] = value
    return config


def empty_server(item: dict, message: str) -> dict:
    return {
        "id": item["id"], "name": item.get("name", item["id"]),
        "site": item.get("site", ""), "environment": item.get("environment", ""),
        "role": item.get("role", ""), "collecting": False, "sampleTime": None,
        "metrics": {key: None for key in METRICS}, "metricQuality": {},
        "histories": {"local": [], "remote": []}, "message": message,
    }


def read_server(item: dict, client: PIReadClient, now_ms: float, stale_seconds: float) -> dict:
    result = empty_server(item, "")
    tags = item.get("tags", {})
    for key in METRICS:
        if key not in tags:
            result["metricQuality"][key] = {"good": False, "status": "NotConfigured", "timestamp": None}
            continue
        try:
            sample = client.read(tags[key])
            value, stamp = sample["value"], sample["timestamp"]
            valid = (sample["good"] and not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value)
                     and value >= 0 and isinstance(stamp, (float, int)) and math.isfinite(stamp)
                     and 0 <= now_ms - stamp <= stale_seconds * 1000)
            if key in PERCENTAGES and valid and value > 100:
                valid = False
            result["metrics"][key] = value if valid else None
            result["metricQuality"][key] = {
                "good": bool(valid), "status": sample["status"] if valid else "InvalidOrStale",
                "timestamp": stamp,
            }
        except Exception:
            result["metricQuality"][key] = {"good": False, "status": "ReadFailure", "timestamp": None}
    stamps = [result["metricQuality"][key]["timestamp"] for key in ESSENTIAL]
    result["collecting"] = all(result["metrics"][key] is not None for key in ESSENTIAL)
    if result["collecting"]:
        result["sampleTime"] = min(stamps)
    else:
        result["message"] = "Métricas essenciais ausentes, inválidas ou sem amostra recente."
    return result


class SnapshotStore:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.trends = TrendEngine(config.get("trend"))
        self.publisher = TrendPublisher(config)
        self.absolute_publisher = TrendPublisher(config, "absoluteOutputs")
        self.snapshot = {
            "schemaVersion": 1, "source": config.get("piAdapter", "pi-sdk-com"), "serviceStatus": "starting",
            "staleSeconds": config["staleSeconds"], "generatedAt": None,
            "trendPolicy": {"triggerMode": "sustained-rise", "continuitySeconds": 180, **{key: config.get("trend", {}).get(key, default) for key, default in (("measurementSeconds", 60), ("windowSeconds", 600), ("referenceSeconds", 1800), ("memoryWindowSeconds", 900), ("recoverySamples", 3))}},
            "servers": [empty_server(s, "Aguardando configuração e leitura PI.") for s in config["servers"]],
        }

    def get(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.snapshot)

    def publish(self, servers: list, status: str, client=None) -> None:
        now = time.time() * 1000
        for server in servers:
            server["trends"] = self.trends.evaluate_server(server, now, self.config["staleSeconds"])
            self.publisher.publish(server["id"], server["trends"], client, now)
            item = next(item for item in self.config["servers"] if item["id"] == server["id"])
            server["absoluteAlarms"] = evaluate_absolute(item, server, now, self.config["staleSeconds"])
            self.absolute_publisher.publish(server["id"], server["absoluteAlarms"], client, now)
        with self.lock:
            previous = {s["id"]: s for s in self.snapshot["servers"]}
            for server in servers:
                for kind in ("local", "remote"):
                    history = previous[server["id"]]["histories"][kind][-120:]
                    fields = [kind + "EnteredRate", kind + "HandledRate", kind + "DiscardPercent"]
                    if all(server["metrics"][key] is not None for key in fields):
                        stamp = min(server["metricQuality"][key]["timestamp"] for key in fields)
                        if not history or stamp > history[-1]["timestamp"]:
                            history = history + [dict(zip(("timestamp", "entered", "handled", "discard"), [stamp] + [server["metrics"][key] for key in fields]))]
                    server["histories"][kind] = history[-120:]
            self.snapshot.update(servers=servers, serviceStatus=status, generatedAt=datetime.now(timezone.utc).isoformat())

    def poll(self) -> None:
        if not self.config.get("piServer", "").strip() or not any(s.get("tags") for s in self.config["servers"]):
            self.publish([empty_server(s, "Configure o PI Data Archive e as tags de leitura.") for s in self.config["servers"]], "not-configured")
            return
        outputs = [tag for s in self.config["servers"] for group in ("outputs", "absoluteOutputs") for tag in s.get(group, {}).values() if tag] if self.config.get("enableWrites", False) else []
        client = PIReadClient(
            self.config["piServer"],
            allowed_outputs=outputs,
            adapter=self.config.get("piAdapter", "pi-sdk-com"),
            af_sdk_dll=self.config.get("piAfSdkDll"),
        )
        initialized = False
        try:
            if self.config.get("piAdapter", "pi-sdk-com") == "pi-sdk-com":
                import pythoncom
                pythoncom.CoInitialize()
                initialized = True
            while not self.stop.is_set():
                try:
                    client.connect()
                    now = time.time() * 1000
                    servers = [read_server(s, client, now, self.config["staleSeconds"]) for s in self.config["servers"]]
                    self.publish(servers, "connected" if all(s["collecting"] for s in servers) else "degraded", client)
                except Exception:
                    client.close()
                    self.publish([empty_server(s, "Conexão PI indisponível. Verifique SDK, servidor e permissões Windows.") for s in self.config["servers"]], "unavailable")
                self.stop.wait(self.config["pollSeconds"])
        except ImportError:
            self.publish([empty_server(s, "PI SDK COM requer Windows e pywin32 instalado.") for s in self.config["servers"]], "unavailable")
        finally:
            client.close()
            if initialized:
                pythoncom.CoUninitialize()


def make_handler(store: SnapshotStore, web_root: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def do_GET(self):
            if self.path.split("?")[0] == "/api/v1/status":
                body = json.dumps(store.get(), allow_nan=False, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.split("?")[0].startswith("/api/"):
                self.send_error(404)
                return
            super().do_GET()

        def list_directory(self, path):
            self.send_error(403)
            return None

        def end_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def log_message(self, format, *args):
            return
    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.toml"))
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    config = load_config(args.config)
    store = SnapshotStore(config)
    worker = threading.Thread(target=store.poll, name="pi-com-reader", daemon=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, Path(__file__).resolve().parents[1] / "web"))
    worker.start()
    print(f"SCADA front-end/API: http://127.0.0.1:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.stop.set()
        server.server_close()
        worker.join(timeout=3)


if __name__ == "__main__":
    main()

