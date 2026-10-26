"""Version: 1.7 | Date: 25/10/2026
Changes: Clarified the API as the read-only data source for the standalone orbital interface.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sqlite3
import threading
import time
import tomllib
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pi_client import PIReadClient
from trends import TREND_METRICS, TrendEngine
from trend_output import TrendPublisher
from absolute_alarms import evaluate_absolute, validate_absolute
from readiness import configuration_report

METRICS = (
    "runCPU", "runMemory", "runPVT", "runTRD", "runLocalPending",
    "runRemotePending", "runOccupancy", "runErrorsPerMinute", "serverCPU",
    "serverHDL", "driveCFreeMB", "ioQueuePending", "ioQueueAvgDelay",
    "etlFileSizeMB", "totalTime", "runUptimeMinutes",
    "localEnteredRate", "localHandledRate", "localDiscardPercent",
    "remoteEnteredRate", "remoteHandledRate", "remoteDiscardPercent",
    "runAvgScriptTime", "runDiscardedEvents", "runErrors", "runHDL",
    "runPageFaults", "remoteDiscardedRate", "serverPVT",
    "collectionTimestamp", "fileRead", "serverStatus",
)
TEXT_METRICS = frozenset(("collectionTimestamp", "fileRead", "serverStatus"))
ESSENTIAL = ("runCPU", "runMemory", "runErrorsPerMinute", "runLocalPending", "runRemotePending")
PERCENTAGES = ("runCPU", "runMemory", "runOccupancy", "serverCPU", "localDiscardPercent", "remoteDiscardPercent")
CHART_METRICS = ("runCPU", "runMemory", "runTRD", "runOccupancy", "runErrorsPerMinute", "runLocalPending", "runRemotePending", "ioQueueAvgDelay")
CHART_HISTORY_SECONDS = 4 * 60 * 60
CHART_INTERVAL_SECONDS = 5 * 60
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
        "histories": {"local": [], "remote": []}, "chartHistory": {}, "message": message,
    }


def read_server(item: dict, client: PIReadClient, now_ms: float, stale_seconds: float) -> dict:
    result = empty_server(item, "")
    tags = item.get("tags", {})
    for key in METRICS:
        if key not in tags:
            result["metricQuality"][key] = {"good": False, "status": "NotConfigured", "timestamp": None}
            continue
        try:
            sample = client.read_value(tags[key]) if key in TEXT_METRICS else client.read(tags[key])
            value, stamp = sample["value"], sample["timestamp"]
            numeric = not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and value >= 0
            typed = key in TEXT_METRICS and (isinstance(value, bool) or isinstance(value, str) and bool(value.strip()) or numeric)
            valid = (sample["good"] and (typed if key in TEXT_METRICS else numeric)
                     and not isinstance(stamp, bool) and isinstance(stamp, (float, int)) and math.isfinite(stamp)
                     and 0 <= now_ms - stamp <= stale_seconds * 1000)
            if key in PERCENTAGES and valid and value > 100:
                valid = False
            result["metrics"][key] = value if valid else None
            result["metricQuality"][key] = {
                "good": bool(valid), "status": sample["status"] if valid else "InvalidOrStale",
                "timestamp": stamp if not isinstance(stamp, bool) and isinstance(stamp, (float, int)) and math.isfinite(stamp) else None,
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
        self.trend_history_stamps: dict[tuple[str, str], float] = {}
        self.chart_history: dict[tuple[str, str], list[dict]] = {}
        self.active_alarm_signatures: set[tuple[str, str, str, str]] = set()
        self.history_db = Path(config.get("historyDbPath", Path(__file__).with_name("runtime-history.sqlite3")))
        self.history_db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.history_db)) as connection, connection:
            connection.execute("CREATE TABLE IF NOT EXISTS alarm_history (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, server_id TEXT NOT NULL, server_name TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL)")
            connection.execute("CREATE INDEX IF NOT EXISTS alarm_history_observed_at ON alarm_history(observed_at DESC)")
        self.snapshot = {
            "schemaVersion": 1, "source": config.get("piAdapter", "pi-sdk-com"), "serviceStatus": "starting",
            "staleSeconds": config["staleSeconds"], "generatedAt": None,
            "trendPolicy": {"triggerMode": "sustained-rise", "continuitySeconds": 180, **{key: config.get("trend", {}).get(key, default) for key, default in (("measurementSeconds", 60), ("windowSeconds", 600), ("referenceSeconds", 1800), ("memoryWindowSeconds", 900), ("recoverySamples", 3))}},
            "servers": [empty_server(s, "Aguardando configuração e leitura PI.") for s in config["servers"]], "alarmHistory": self.alarm_history(),
        }

    def alarm_history(self, limit: int = 8) -> list[dict]:
        with closing(sqlite3.connect(self.history_db)) as connection:
            rows = connection.execute("SELECT observed_at, server_id, server_name, state, title, description FROM alarm_history ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [{"observedAt": row[0], "serverId": row[1], "serverName": row[2], "state": row[3], "title": row[4], "description": row[5]} for row in rows]

    def record_active_alarms(self, servers: list, observed_at: int) -> None:
        events = []
        signatures = set()
        for server in servers:
            for alarm in [*server.get("trends", []), *server.get("absoluteAlarms", [])]:
                state = alarm.get("state")
                if state not in (10, 20):
                    continue
                title = str(alarm.get("label") or alarm.get("metric") or "Alarme")
                description = str(alarm.get("reason") or alarm.get("stateLabel") or title)
                signature = (server["id"], str(state), title, description)
                signatures.add(signature)
                if signature not in self.active_alarm_signatures:
                    events.append((observed_at, server["id"], server.get("name", server["id"]), "critical" if state == 20 else "warning", title, description))
        if events:
            with closing(sqlite3.connect(self.history_db)) as connection, connection:
                connection.executemany("INSERT INTO alarm_history(observed_at, server_id, server_name, state, title, description) VALUES (?, ?, ?, ?, ?, ?)", events)
                connection.execute("DELETE FROM alarm_history WHERE id NOT IN (SELECT id FROM alarm_history ORDER BY id DESC LIMIT 2000)")
        self.active_alarm_signatures = signatures

    def get(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.snapshot)

    def update_chart_history(self, servers: list) -> None:
        cutoff = time.time() * 1000 - CHART_HISTORY_SECONDS * 1000
        for server in servers:
            chart_history = {}
            for metric in CHART_METRICS:
                history_key = (server["id"], metric)
                points = self.chart_history.setdefault(history_key, [])
                value = server["metrics"].get(metric)
                quality = server.get("metricQuality", {}).get(metric, {})
                timestamp = quality.get("timestamp")
                if (quality.get("good") is True and not isinstance(value, bool)
                        and isinstance(value, (int, float)) and math.isfinite(value)
                        and not isinstance(timestamp, bool) and isinstance(timestamp, (int, float)) and math.isfinite(timestamp)
                        and (not points or timestamp > points[-1]["timestamp"])):
                    points.append({"timestamp": timestamp, "value": value})
                self.chart_history[history_key] = [point for point in points if point["timestamp"] >= cutoff]
                chart_history[metric] = copy.deepcopy(self.chart_history[history_key])
            server["chartHistory"] = chart_history

    def publish(self, servers: list, status: str, client=None) -> None:
        now = time.time() * 1000
        for server in servers:
            server["trends"] = self.trends.evaluate_server(server, now, self.config["staleSeconds"])
            self.publisher.publish(server["id"], server["trends"], client, now)
            item = next(item for item in self.config["servers"] if item["id"] == server["id"])
            server["absoluteAlarms"] = evaluate_absolute(item, server, now, self.config["staleSeconds"])
            self.absolute_publisher.publish(server["id"], server["absoluteAlarms"], client, now)
        self.record_active_alarms(servers, int(now))
        self.update_chart_history(servers)
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
            self.snapshot.update(servers=servers, serviceStatus=status, generatedAt=datetime.now(timezone.utc).isoformat(), alarmHistory=self.alarm_history())

    def hydrate_chart_history_from_pi(self, client: PIReadClient, servers: list) -> None:
        if client.adapter != "af-sdk":
            return
        now = time.time() * 1000
        for server in servers:
            for metric in CHART_METRICS:
                history_key = (server["id"], metric)
                if history_key in self.chart_history:
                    continue
                tag = next((item["tags"].get(metric) for item in self.config["servers"] if item["id"] == server["id"]), None)
                if not tag:
                    self.chart_history[history_key] = []
                    continue
                try:
                    samples = client.read_interpolated(tag, now - CHART_HISTORY_SECONDS * 1000, now, CHART_INTERVAL_SECONDS)
                    self.chart_history[history_key] = [
                        {"timestamp": sample["timestamp"], "value": sample["value"]}
                        for sample in samples
                        if sample.get("good") is True and isinstance(sample.get("value"), (int, float))
                        and not isinstance(sample.get("value"), bool) and math.isfinite(sample["value"])
                    ]
                except Exception:
                    self.chart_history[history_key] = []

    def refresh_trends_from_pi(self, client: PIReadClient, servers: list) -> None:
        if client.adapter != "af-sdk":
            return
        history_seconds = int((max(self.trends.slow_ms, self.trends.window_ms) + self.trends.reference_ms) / 1000)
        interval_seconds = int(self.trends.interval_ms / 1000)
        for server in servers:
            for metric in TREND_METRICS:
                tag = next((item["tags"].get(metric) for item in self.config["servers"] if item["id"] == server["id"]), None)
                stamp = server.get("metricQuality", {}).get(metric, {}).get("timestamp")
                history_key = (server["id"], metric)
                if not tag or not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or self.trend_history_stamps.get(history_key) == stamp:
                    continue
                try:
                    end_ms = stamp - self.trends.interval_ms
                    self.trends.seed_history(server["id"], metric, client.read_interpolated(tag, end_ms - history_seconds * 1000, end_ms, interval_seconds))
                    self.trend_history_stamps[history_key] = stamp
                except Exception:
                    continue

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
                    self.refresh_trends_from_pi(client, servers)
                    self.hydrate_chart_history_from_pi(client, servers)
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


def make_handler(store: SnapshotStore):
    class Handler(BaseHTTPRequestHandler):
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
            self.send_error(403)

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
    parser.add_argument("--check-config", action="store_true", help="Validate local PI configuration and dependencies without connecting or writing.")
    parser.add_argument("--simulate", action="store_true", help="Serve synthetic read-only data for interface development; never connects to PI.")
    args = parser.parse_args()
    if args.simulate and args.check_config:
        parser.error("--simulate cannot be combined with --check-config")
    temporary_history = None
    try:
        if args.simulate:
            from tempfile import TemporaryDirectory
            from simulated_data import simulated_config
            temporary_history = TemporaryDirectory(prefix="dom-watcher-simulated-")
            config = simulated_config(Path(temporary_history.name) / "history.sqlite3")
        else:
            config = load_config(args.config)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(f"Configuration error: {exc}")
    if args.check_config:
        report = configuration_report(config)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        raise SystemExit(0 if report["readyForConnection"] else 2)
    store = SnapshotStore(config)
    if args.simulate:
        from simulated_data import publish_simulation
        worker = threading.Thread(target=publish_simulation, args=(store,), name="simulated-data", daemon=True)
        mode = "simulated API"
    else:
        worker = threading.Thread(target=store.poll, name="pi-reader", daemon=True)
        mode = "SCADA API"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store))
    worker.start()
    print(f"{mode}: http://127.0.0.1:{args.port}/api/v1/status", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.stop.set()
        server.server_close()
        worker.join(timeout=3)
        if temporary_history is not None:
            temporary_history.cleanup()


if __name__ == "__main__":
    main()

