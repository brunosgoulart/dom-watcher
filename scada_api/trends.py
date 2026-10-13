"""Version: 1.2 | Date: 13/10/2026
Changes: Triggered any sustained rise after the full configured duration, tolerated local oscillations and made historical reference optional for severity.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from statistics import median

TREND_METRICS = {
    "runCPU": ("CPU", "CPU", 0.1),
    "runMemory": ("RAM", "RAM", 0.1),
    "runPVT": ("PrivateMemory", "Memória privada", 1024.0),
    "runErrorsPerMinute": ("ScriptErrors", "Erros de scripts", 0.1),
    "runLocalPending": ("LocalQueue", "Fila local", 1.0),
    "runRemotePending": ("RemoteQueue", "Fila remota", 1.0),
}
STATE_LABELS = {0: "Normal", 10: "Atenção", 20: "Crítico", 30: "Histórico insuficiente", 40: "Dados inválidos"}


def slope(points: list[tuple[float, float]]) -> float:
    return median((b[1] - a[1]) / ((b[0] - a[0]) / 60000)
                  for i, a in enumerate(points) for b in points[i + 1:] if b[0] > a[0])


def mad(values: list[float]) -> float:
    center = median(values)
    return median(abs(value - center) for value in values)


@dataclass
class MetricState:
    points: deque = field(default_factory=lambda: deque(maxlen=120))
    confirmed: int = 0
    candidate: int | None = None
    streak: int = 0
    last_result: dict = field(default_factory=dict)
    anchors: dict = field(default_factory=dict)


class TrendEngine:
    def __init__(self, config: dict | None = None) -> None:
        config = config or {}
        self.interval_ms = config.get("measurementSeconds", 60) * 1000
        self.window_ms = config.get("windowSeconds", 600) * 1000
        self.reference_ms = config.get("referenceSeconds", 1800) * 1000
        self.slow_ms = config.get("memoryWindowSeconds", 900) * 1000
        self.history_capacity = math.ceil((max(self.window_ms, self.slow_ms) + self.reference_ms) / self.interval_ms) + 4
        self.critical = config.get("criticalScore", 6.0)
        self.recovery = config.get("recoverySamples", 3)
        self.resolutions = {key: config.get("resolution", {}).get(key, item[2]) for key, item in TREND_METRICS.items()}
        self.states: dict[tuple[str, str], MetricState] = {}

    def covered(self, points: list, start: float, end: float, reference: bool = False) -> bool:
        minimum = math.ceil((end - start) / self.interval_ms * 0.9) if reference else max(3, math.ceil((end - start) / self.interval_ms) + 1)
        return (len(points) >= minimum and points[0][0] <= start + self.interval_ms
                and points[-1][0] >= end - self.interval_ms
                and points[-1][0] - points[0][0] >= end - start - (self.interval_ms if reference else 0)
                and all(b[0] - a[0] <= self.interval_ms * 1.5 for a, b in zip(points, points[1:])))

    def analyze(self, state: MetricState, end: float, window: float, resolution: float) -> dict | None:
        start = end - window
        current = [p for p in state.points if start <= p[0] <= end]
        predecessor = [p for p in state.points if p[0] < start]
        if predecessor and (not current or current[0][0] > start):
            current.insert(0, predecessor[-1])
        if not self.covered(current, start, end):
            return None
        reference_end = current[0][0]
        reference = [p for p in state.points if reference_end - self.reference_ms <= p[0] < reference_end]
        current_slope = slope(current)
        neighborhood = min(len(current), 4)
        sustained = (current_slope > 0 and current[-1][1] > current[0][1]
                     and all(slope(current[i:i + neighborhood]) > 0
                             and current[i + neighborhood - 1][1] > current[i][1]
                             for i in range(len(current) - neighborhood + 1)))
        anchor = state.anchors.get(window)
        if anchor is None:
            if self.covered(reference, reference_end - self.reference_ms, reference_end, reference=True):
                base_slope = slope(reference)
                intercept = median(p[1] - base_slope * (p[0] - reference[0][0]) / 60000 for p in reference)
                residuals = [p[1] - intercept - base_slope * (p[0] - reference[0][0]) / 60000 for p in reference]
                width = min(len(reference), max(3, math.ceil(window / self.interval_ms) + 1))
                local_slopes = [slope(reference[i:i + width]) for i in range(len(reference) - width + 1)]
                anchor = {"baselineSlope": base_slope, "noise": max(resolution, 1.4826 * mad(residuals), 1.4826 * mad(local_slopes) * window / 60000)}
        score = max(0.0, (current_slope - max(0.0, anchor["baselineSlope"])) * window / 60000 / anchor["noise"]) if anchor else None
        if not sustained and score is not None:
            score = 0.0
        return {"baselineSlope": anchor["baselineSlope"] if anchor else None,
                "slope": current_slope, "score": score, "windowSeconds": window / 1000,
                "anchor": anchor, "sustained": sustained,
                "riseDurationSeconds": (end - current[0][0]) / 1000 if sustained else 0,
                "referenceReady": anchor is not None}

    def evaluate(self, server_id: str, metric: str, value: float | None, stamp: float | None, good: bool, now_ms: float, stale_seconds: float) -> dict:
        state = self.states.setdefault((server_id, metric), MetricState(points=deque(maxlen=self.history_capacity)))
        def result(code: int, reason: str, analysis: dict | None = None, long_ready: bool = False):
            data = {
                "metric": metric, "label": TREND_METRICS[metric][1],
                "state": code, "stateLabel": STATE_LABELS[code], "confirmedState": state.confirmed,
                "sampleTime": stamp if isinstance(stamp, (int, float)) and math.isfinite(stamp) else None,
                "evaluatedAt": now_ms, "reason": reason, "longWindowReady": long_ready,
                "slope": analysis["slope"] if analysis else None, "score": analysis["score"] if analysis else None,
                "baselineSlope": analysis["baselineSlope"] if analysis else None,
                "windowSeconds": analysis["windowSeconds"] if analysis else self.window_ms / 1000,
                "severityWindowSeconds": analysis.get("severityWindowSeconds", analysis["windowSeconds"]) if analysis else None,
                "riseDurationSeconds": analysis["riseDurationSeconds"] if analysis else 0,
                "referenceReady": analysis["referenceReady"] if analysis else False,
                "pendingSamples": state.streak,
            }
            state.last_result = data
            return data
        valid = (good and not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
                 and not isinstance(stamp, bool) and isinstance(stamp, (int, float)) and math.isfinite(stamp)
                 and 0 <= now_ms - stamp <= stale_seconds * 1000)
        if not valid:
            state.streak, state.candidate = 0, None
            return result(40, "Medição ausente, inválida, futura ou desatualizada; último estado confirmado preservado.")
        if state.points and stamp < state.points[-1][0]:
            state.streak, state.candidate = 0, None
            return result(40, "Timestamp fora de ordem.")
        if state.points and stamp == state.points[-1][0]:
            if state.points[-1][1] != value:
                state.points.clear()
                state.anchors.clear()
                state.streak, state.candidate = 0, None
                return result(40, "Valor alterado no mesmo timestamp; aguardando nova medição.")
            return dict(state.last_result)
        if state.points and stamp - state.points[-1][0] > self.interval_ms * 1.5:
            state.points.clear()
            state.anchors.clear()
            state.streak, state.candidate = 0, None
        state.points.append((stamp, value))
        primary = self.analyze(state, stamp, self.window_ms, self.resolutions[metric])
        if primary is None:
            state.streak, state.candidate = 0, None
            return result(30, f"Aguardando {self.window_ms / 60000:g} minutos completos de medições válidas e sem lacunas.")
        analyses = {self.window_ms: primary}
        if metric in ("runMemory", "runPVT"):
            slow = self.analyze(state, stamp, self.slow_ms, self.resolutions[metric])
            if slow is not None:
                analyses[self.slow_ms] = slow
        selected = max(analyses.values(), key=lambda item: item["score"] if item["sustained"] and item["score"] is not None else -1)
        score = selected["score"]
        candidate = (20 if score is not None and score >= self.critical else 10) if primary["sustained"] else 0
        if candidate == state.confirmed:
            state.streak, state.candidate = 0, None
        else:
            state.streak = state.streak + 1 if candidate == state.candidate else 1
            state.candidate = candidate
            required = self.recovery if candidate < state.confirmed else 1
            if state.streak >= required:
                state.confirmed = candidate
                state.streak, state.candidate = 0, None
                if candidate:
                    for window, analysis in analyses.items():
                        if analysis["anchor"] is not None:
                            state.anchors.setdefault(window, analysis["anchor"])
                else:
                    state.anchors.clear()
        if state.confirmed:
            for window, analysis in analyses.items():
                if analysis["anchor"] is not None:
                    state.anchors.setdefault(window, analysis["anchor"])
        selected = {**selected, "severityWindowSeconds": selected["windowSeconds"],
                    "windowSeconds": self.window_ms / 1000,
                    "riseDurationSeconds": primary["riseDurationSeconds"]}
        return result(state.confirmed, "Elevação sustentada pelo período completo, com oscilações locais permitidas; histórico apenas para gravidade.", selected, self.slow_ms in analyses)

    def evaluate_server(self, server: dict, now_ms: float, stale_seconds: float) -> list[dict]:
        return [self.evaluate(server["id"], key, server["metrics"].get(key),
                              server.get("metricQuality", {}).get(key, {}).get("timestamp"),
                              server.get("metricQuality", {}).get(key, {}).get("good", False),
                              now_ms, stale_seconds) for key in TREND_METRICS]
