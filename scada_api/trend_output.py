"""Version: 1.0 | Date: 13/10/2026
Changes: Added allow-listed trend state publication, heartbeat, retry and separate PI write diagnostics.
"""
from __future__ import annotations

from trends import TREND_METRICS


class TrendPublisher:
    def __init__(self, config: dict) -> None:
        self.enabled = config.get("enableWrites", False)
        self.tags = {s["id"]: s.get("outputs", {}) for s in config["servers"]}
        self.heartbeat = config.get("outputHeartbeatSeconds", 60) * 1000
        self.retry = config.get("writeRetrySeconds", 30) * 1000
        self.last_success: dict[str, tuple[int, float]] = {}
        self.last_attempt: dict[str, float] = {}
        self.failed: set[str] = set()

    def publish(self, server_id: str, alarms: list[dict], client, now_ms: float) -> None:
        for alarm in alarms:
            tag = self.tags.get(server_id, {}).get(alarm["metric"])
            alarm["outputTag"] = tag
            alarm["writeStatus"] = "disabled" if not self.enabled else "not-configured" if not tag else "failed" if tag in self.failed else "pending"
            if not self.enabled or not tag:
                continue
            last = self.last_success.get(tag)
            alarm["lastWrittenState"] = last[0] if last else None
            alarm["lastWrittenAt"] = last[1] if last else None
            if last and last[0] == alarm["state"] and now_ms - last[1] < self.heartbeat:
                alarm["writeStatus"] = "written"
                continue
            if client is None or now_ms - self.last_attempt.get(tag, -float("inf")) < self.retry:
                continue
            self.last_attempt[tag] = now_ms
            try:
                client.write_alarm(tag, alarm["state"])
            except Exception:
                self.failed.add(tag)
                alarm["writeStatus"] = "failed"
                continue
            self.failed.discard(tag)
            self.last_success[tag] = (alarm["state"], now_ms)
            alarm.update(writeStatus="written", lastWrittenState=alarm["state"], lastWrittenAt=now_ms)
