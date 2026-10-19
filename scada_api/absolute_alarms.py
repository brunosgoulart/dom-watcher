"""Independent, optional upper-limit alarms for the six trend metrics."""
import math

from trends import TREND_METRICS


def validate_absolute(item):
    limits = item.get("absoluteLimits", {})
    outputs = item.get("absoluteOutputs", {})
    if not isinstance(limits, dict) or not isinstance(outputs, dict):
        raise ValueError("absoluteLimits and absoluteOutputs must be tables")
    for key, limit in limits.items():
        if key not in TREND_METRICS:
            raise ValueError("Unsupported absolute alarm metric")
        if limit == "":
            continue
        if type(limit) not in (int, float) or not math.isfinite(limit) or limit < 0:
            raise ValueError("Absolute limits must be finite nonnegative numbers or empty strings")
        if key in ("runCPU", "runMemory") and limit > 100:
            raise ValueError("Percentage limits must be between 0 and 100")
        if not item.get("tags", {}).get(key):
            raise ValueError("An absolute limit requires its input tag")
    for key, tag in outputs.items():
        if key not in TREND_METRICS or not isinstance(tag, str):
            raise ValueError("Unsupported absolute output")
        if tag == "":
            continue
        if tag != tag.strip() or ".SCADA.Absolute." not in tag or not tag.endswith(".State") or tag.startswith("\\\\"):
            raise ValueError("Use explicit SCADA.Absolute.*.State output PI Point names")


def evaluate_absolute(item, server, now_ms, stale_seconds):
    alarms = []
    for key, limit in item.get("absoluteLimits", {}).items():
        if limit == "":
            continue
        quality = server.get("metricQuality", {}).get(key, {})
        value = server.get("metrics", {}).get(key)
        stamp = quality.get("timestamp")
        valid = (quality.get("good") is True and type(value) in (int, float)
                 and math.isfinite(value) and value >= 0
                 and type(stamp) in (int, float) and math.isfinite(stamp)
                 and 0 <= now_ms - stamp <= stale_seconds * 1000)
        if valid and key in ("runCPU", "runMemory") and value > 100:
            valid = False
        state = 40 if not valid else 20 if value >= limit else 0
        alarms.append({"metric": key, "type": "absolute", "limit": limit,
                       "value": value if valid else None, "timestamp": stamp,
                       "state": state, "stateLabel": {0: "Normal", 20: "Limite atingido", 40: "Sem dados"}[state],
                       "reason": "Medição inválida ou desatualizada." if not valid else
                       "Valor igual ou superior ao limite." if state == 20 else "Valor abaixo do limite."})
    return alarms
