"""Serve a local, read-only SCADA dashboard preview with synthetic PI values.

This utility never connects to PI Data Archive and never writes PI points. It is
intended solely for reviewing the web interface before real tag mappings exist.
"""
from __future__ import annotations

import argparse
import math
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import METRICS, SnapshotStore, make_handler


SIMULATED_METRICS = (
    "runCPU", "runMemory", "runPVT", "runTRD", "runLocalPending",
    "runRemotePending", "runOccupancy", "runErrorsPerMinute", "serverCPU",
    "serverHDL", "ioQueuePending", "ioQueueAvgDelay", "totalTime",
    "runUptimeMinutes", "localDiscardPercent", "remoteDiscardPercent",
)

PROFILES = (
    {
        "id": "COGCGPRO12", "name": "COGCGPRO12", "site": "Simulação",
        "environment": "Prévia local", "role": "Threads em elevação", "trend": {"runTRD": 10},
        "metrics": {
            "runCPU": 34.8, "runMemory": 61.5, "runPVT": 821_248, "runTRD": 126,
            "runLocalPending": 4, "runRemotePending": 2, "runOccupancy": 43.2,
            "runErrorsPerMinute": 0.2, "serverCPU": 18.4, "serverHDL": 874,
            "ioQueuePending": 1, "ioQueueAvgDelay": 3.4, "totalTime": 0.21,
            "runUptimeMinutes": 18_420, "localDiscardPercent": 0.03,
            "remoteDiscardPercent": 0.01,
        },
    },
    {
        "id": "COGCGPRO34", "name": "COGCGPRO34", "site": "Simulação",
        "environment": "Prévia local", "role": "CPU em elevação", "trend": {"runCPU": 10},
        "metrics": {
            "runCPU": 78.6, "runMemory": 72.4, "runPVT": 906_240, "runTRD": 184,
            "runLocalPending": 61, "runRemotePending": 12, "runOccupancy": 68.7,
            "runErrorsPerMinute": 1.3, "serverCPU": 44.8, "serverHDL": 1_128,
            "ioQueuePending": 7, "ioQueueAvgDelay": 11.2, "totalTime": 0.38,
            "runUptimeMinutes": 9_860, "localDiscardPercent": 0.18,
            "remoteDiscardPercent": 0.05,
        },
    },
    {
        "id": "COGCGPRO56", "name": "COGCGPRO56", "site": "Simulação",
        "environment": "Prévia local", "role": "Memória em elevação", "trend": {"runMemory": 20},
        "metrics": {
            "runCPU": 91.2, "runMemory": 94.1, "runPVT": 1_126_400, "runTRD": 246,
            "runLocalPending": 318, "runRemotePending": 87, "runOccupancy": 89.6,
            "runErrorsPerMinute": 7.8, "serverCPU": 76.3, "serverHDL": 1_796,
            "ioQueuePending": 29, "ioQueueAvgDelay": 42.8, "totalTime": 0.94,
            "runUptimeMinutes": 2_740, "localDiscardPercent": 0.94,
            "remoteDiscardPercent": 0.36,
        },
    },
)

TREND_LABELS = {
    "runTRD": "Threads",
    "runCPU": "CPU", "runMemory": "RAM", "runPVT": "Memória privada",
    "runErrorsPerMinute": "Erros de scripts", "runLocalPending": "Fila local",
    "runRemotePending": "Fila remota",
}


def simulated_values(profile: dict, now_seconds: float) -> dict:
    """Keep every displayed numeric value fresh, with a small harmless variation."""
    phase = (hash(profile["id"]) % 10) + now_seconds / 12
    values = dict(profile["metrics"])
    if profile["trend"].get("runTRD"):
        values["runTRD"] += int((now_seconds % 1800) / 60 * 4)
    for key, amplitude in (("runCPU", 0.35), ("runMemory", 0.2), ("runPVT", 512),
                           ("runErrorsPerMinute", 0.05), ("serverCPU", 0.3),
                           ("ioQueueAvgDelay", 0.4), ("totalTime", 0.01)):
        values[key] = round(max(0, values[key] + math.sin(phase) * amplitude), 3)
    return values


def trend(metric: str, state: int, timestamp: float) -> dict:
    labels = {0: "Normal", 10: "Atenção", 20: "Crítico"}
    slopes = {0: 0.0, 10: 4.0 if metric == "runTRD" else 0.62, 20: 1.18}
    scores = {0: 0.0, 10: 2.8, 20: 7.4}
    return {
        "metric": metric, "label": TREND_LABELS[metric], "state": state,
        "stateLabel": labels[state], "confirmedState": state, "sampleTime": timestamp,
        "evaluatedAt": timestamp, "reason": "Dados simulados localmente para avaliação visual.",
        "longWindowReady": True, "slope": slopes[state], "score": scores[state],
        "baselineSlope": 0.0, "windowSeconds": 600, "severityWindowSeconds": 600,
        "riseDurationSeconds": 600 if state else 0, "referenceReady": True,
        "pendingSamples": 0, "writeStatus": "disabled",
    }


def simulated_servers(now_ms: float | None = None) -> list[dict]:
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    now_seconds = now_ms / 1000
    servers = []
    for profile in PROFILES:
        values = simulated_values(profile, now_seconds)
        metrics = {key: values.get(key) for key in METRICS}
        quality = {
            key: {"good": True, "status": "Simulated", "timestamp": now_ms}
            for key in SIMULATED_METRICS
        }
        servers.append({
            **{key: profile[key] for key in ("id", "name", "site", "environment", "role")},
            "collecting": True, "sampleTime": now_ms, "metrics": metrics,
            "metricQuality": quality, "histories": {"local": [], "remote": []},
            "trends": [trend(metric, profile["trend"].get(metric, 0), now_ms) for metric in TREND_LABELS],
            "message": "Dados simulados localmente; não há leitura ou escrita no PI.",
        })
    return servers


def publish_simulation(store: SnapshotStore) -> None:
    while not store.stop.is_set():
        now_ms = time.time() * 1000
        with store.lock:
            store.snapshot.update(
                servers=simulated_servers(now_ms), serviceStatus="connected",
                generatedAt=datetime.now(timezone.utc).isoformat(),
            )
        store.stop.wait(3)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local simulated SCADA dashboard preview.")
    parser.add_argument("--port", type=int, default=8768)
    args = parser.parse_args()
    config = {
        "piAdapter": "simulated", "staleSeconds": 120, "enableWrites": False,
        "servers": [{key: profile[key] for key in ("id", "name", "site", "environment", "role")} for profile in PROFILES],
    }
    store = SnapshotStore(config)
    worker = threading.Thread(target=publish_simulation, args=(store,), name="simulated-pi-preview", daemon=True)
    http_server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, Path(__file__).resolve().parents[1] / "web"))
    worker.start()
    print(f"Simulated SCADA preview: http://127.0.0.1:{args.port}/", flush=True)
    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.stop.set()
        http_server.server_close()
        worker.join(timeout=3)


if __name__ == "__main__":
    main()
