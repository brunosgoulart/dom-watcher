"""Version: 1.2 | Date: 25/10/2026
Changes: Kept a compact, explicit simulated scenario set for the standalone orbital interface.
"""
from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from pathlib import Path

from absolute_alarms import evaluate_absolute
from server import METRICS, SnapshotStore

SIMULATED_METRICS = tuple(METRICS)

BASIC_PROFILES = (
    {"id": "COGCGPRO12", "name": "COGCGPRO12", "role": "Dados estáveis", "trend": {"runCPU": 0},
     "metrics": {"runCPU": 42.0, "runMemory": 61.5, "runPVT": 821248, "runTRD": 126,
                 "runLocalPending": 4, "runRemotePending": 2, "runErrorsPerMinute": 0.2}},
    {"id": "COGCGPRO34", "name": "COGCGPRO34", "role": "CPU em elevação", "trend": {"runCPU": 10},
     "metrics": {"runCPU": 78.6, "runMemory": 72.4, "runPVT": 906240, "runTRD": 184,
                 "runLocalPending": 61, "runRemotePending": 12, "runErrorsPerMinute": 1.3}},
    {"id": "COGCGPRO56", "name": "COGCGPRO56", "role": "Memória em condição crítica", "trend": {"runMemory": 20},
     "metrics": {"runCPU": 91.2, "runMemory": 94.1, "runPVT": 1126400, "runTRD": 246,
                 "runLocalPending": 318, "runRemotePending": 87, "runErrorsPerMinute": 7.8}},
)


def simulated_config(history_path: Path) -> dict:
    return {
        "piAdapter": "simulated", "staleSeconds": 120, "enableWrites": False,
        "pollSeconds": 3, "historyDbPath": str(history_path),
        "servers": [{key: profile[key] for key in ("id", "name", "role")} for profile in BASIC_PROFILES],
    }


def _trend(metric: str, state: int, timestamp: float) -> dict:
    labels = {0: "Normal", 10: "Atenção", 20: "Crítico"}
    return {"metric": metric, "label": metric, "state": state, "stateLabel": labels[state],
            "confirmedState": state, "sampleTime": timestamp, "evaluatedAt": timestamp,
            "reason": "Dado simulado para desenvolvimento da interface.", "writeStatus": "disabled"}


def simulated_servers(now_ms: float | None = None) -> list[dict]:
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    now_seconds = now_ms / 1000
    servers = []
    for profile in BASIC_PROFILES:
        phase = now_seconds / 12 + (hash(profile["id"]) % 10)
        values = {key: 0.0 for key in METRICS}
        values.update(profile["metrics"])
        values.update({"runOccupancy": 43.2, "serverCPU": 18.4, "serverHDL": 874,
                       "driveCFreeMB": 204800, "ioQueuePending": 1, "ioQueueAvgDelay": 3.4,
                       "etlFileSizeMB": 6.2, "totalTime": 0.21, "runUptimeMinutes": 18420,
                       "localEnteredRate": 38.5, "localHandledRate": 38.4, "localDiscardPercent": 0.03,
                       "remoteEnteredRate": 12.0, "remoteHandledRate": 11.9, "remoteDiscardPercent": 0.01,
                       "runAvgScriptTime": 0.004, "runDiscardedEvents": 12, "runErrors": 48,
                       "runHDL": 920, "runPageFaults": 12480, "remoteDiscardedRate": 0.2,
                       "serverPVT": 245760, "collectionTimestamp": datetime.fromtimestamp(now_seconds, timezone.utc).isoformat(),
                       "fileRead": f"Coleta_{profile['id']}.xml", "serverStatus": "Em execução (simulado)"})
        for key, amplitude in (("runCPU", 0.35), ("runMemory", 0.2), ("runPVT", 512), ("runErrorsPerMinute", 0.05)):
            values[key] = round(max(0, values[key] + math.sin(phase) * amplitude), 3)
        quality = {key: {"good": True, "status": "Simulated", "timestamp": now_ms} for key in METRICS}
        server = {"id": profile["id"], "name": profile["name"], "site": "Simulação", "environment": "Desenvolvimento local",
                  "role": profile["role"], "collecting": True, "sampleTime": now_ms, "metrics": values,
                  "metricQuality": quality, "histories": {"local": [], "remote": []},
                  "trends": [_trend(metric, profile["trend"].get(metric, 0), now_ms) for metric in ("runCPU", "runMemory", "runPVT", "runErrorsPerMinute", "runLocalPending", "runRemotePending")],
                  "message": "Dados simulados localmente; não há leitura ou escrita no PI."}
        server["absoluteAlarms"] = evaluate_absolute({"absoluteLimits": {"runCPU": 90.0, "runMemory": 90.0}}, server, now_ms, 120)
        for alarm in server["absoluteAlarms"]:
            alarm["writeStatus"] = "disabled"
        servers.append(server)
    return servers


def publish_simulation(store: SnapshotStore) -> None:
    while not store.stop.is_set():
        now_ms = time.time() * 1000
        servers = simulated_servers(now_ms)
        store.record_active_alarms(servers, int(now_ms))
        with store.lock:
            store.snapshot.update(servers=servers, serviceStatus="connected",
                                  generatedAt=datetime.now(timezone.utc).isoformat(),
                                  alarmHistory=store.alarm_history())
        store.stop.wait(3)
