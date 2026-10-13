"""Version: 1.1 | Date: 13/10/2026
Changes: Added restricted numeric alarm writes using an explicit output allow-list and PI SDK timestamp object.
"""
from __future__ import annotations

import math
from typing import Any


class PIReadClient:
    def __init__(self, server_name: str, allowed_outputs=()) -> None:
        self.server_name = server_name
        self.allowed_outputs = frozenset(allowed_outputs)
        self.write_time = None
        self.sdk: Any = None
        self.server: Any = None
        self.points: dict[str, Any] = {}

    def connect(self) -> None:
        if self.server is not None and bool(self.server.Connected):
            return
        self.close()
        import win32com.client
        self.sdk = win32com.client.Dispatch("PISDK.PISDK")
        server = self.sdk.Servers.Item(self.server_name)
        server.Open()
        if not bool(server.Connected):
            raise RuntimeError("PI connection unavailable")
        self.server = server

    def read(self, tag: str) -> dict[str, Any]:
        if not tag or tag.lower().startswith("af:") or tag.startswith("\\\\"):
            raise ValueError("Configure an unqualified PI Point name")
        if tag not in self.points:
            self.points[tag] = self.server.PIPoints.Item(tag)
        snapshot = self.points[tag].Data.Snapshot
        raw = snapshot.Value
        stamp = float(snapshot.TimeStamp.UTCSeconds) * 1000
        good = bool(getattr(snapshot, "IsGood", False))
        questionable = bool(getattr(snapshot, "Questionable", False))
        if hasattr(raw, "Name") or isinstance(raw, bool):
            good = False
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = None
        if value is None or not math.isfinite(value) or not math.isfinite(stamp) or questionable:
            good = False
        return {"value": value if good else None, "timestamp": stamp if math.isfinite(stamp) else None, "good": good, "status": "Good" if good else "Bad"}

    def write_alarm(self, tag: str, state: int) -> None:
        if tag not in self.allowed_outputs:
            raise PermissionError("PI output is not allow-listed")
        if type(state) is not int or state not in (0, 10, 20, 30, 40):
            raise ValueError("Invalid trend state")
        if self.server is None or not bool(self.server.Connected):
            raise RuntimeError("PI connection unavailable")
        import win32com.client
        if self.write_time is None:
            self.write_time = win32com.client.Dispatch("PITimeServer.PITimeFormat")
        self.write_time.InputString = "*"
        if tag not in self.points:
            self.points[tag] = self.server.PIPoints.Item(tag)
        self.points[tag].Data.UpdateValue(state, self.write_time, 1, None)

    def close(self) -> None:
        self.points.clear()
        self.write_time = None
        if self.server is not None:
            try:
                self.server.Close()
            except Exception:
                pass
        self.server = None
        self.sdk = None
