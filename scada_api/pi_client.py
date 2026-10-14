"""Version: 1.3 | Date: 14/10/2026
Changes: Enforced AF SDK read-only mode, hardened UTC timestamp conversion and quality checks, and kept COM mode for compatibility.
"""
from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from typing import Any

DEFAULT_AFSDK_DLL = r"C:\Program Files (x86)\PIPC\AF\PublicAssemblies\4.0\OSIsoft.AFSDK.dll"


class PIReadClient:
    def __init__(self, server_name: str, allowed_outputs=(), adapter: str = "pi-sdk-com", af_sdk_dll: str | None = None) -> None:
        self.server_name = server_name
        self.allowed_outputs = frozenset(allowed_outputs)
        self.write_time = None
        self.sdk: Any = None
        self.server: Any = None
        self.points: dict[str, Any] = {}
        self.adapter = adapter
        self.af_sdk_dll = af_sdk_dll or DEFAULT_AFSDK_DLL

    def _ensure_af_runtime(self):
        try:
            import pythonnet
        except ImportError as exc:
            raise RuntimeError("pythonnet is required for the AF SDK adapter") from exc
        pythonnet.load("netfx")
        import clr
        return clr

    def _validate_af_dll(self) -> str:
        if not self.af_sdk_dll:
            raise ValueError("AF SDK DLL path is required when using the AF SDK adapter")
        if not os.path.exists(self.af_sdk_dll):
            raise FileNotFoundError(f"AF SDK DLL not found: {self.af_sdk_dll}")
        return self.af_sdk_dll

    def _af_timestamp_to_ms(self, timestamp_obj: Any) -> float | None:
        for candidate in (timestamp_obj, getattr(timestamp_obj, "UtcTime", None), getattr(timestamp_obj, "Value", None)):
            if candidate is None:
                continue
            dt = candidate
            if hasattr(dt, "ToUniversalTime"):
                try:
                    dt = dt.ToUniversalTime()
                except Exception:
                    pass
            if isinstance(dt, datetime):
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                else:
                    dt = dt.astimezone(timezone.utc)
                epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
                return float((dt - epoch).total_seconds() * 1000)
            if isinstance(dt, (int, float)) and math.isfinite(float(dt)):
                return float(dt)
        try:
            import System
            epoch = System.DateTime(1970, 1, 1, 0, 0, 0, System.DateTimeKind.Utc)
            for candidate in (timestamp_obj, getattr(timestamp_obj, "UtcTime", None)):
                if candidate is None:
                    continue
                if hasattr(candidate, "ToUniversalTime"):
                    candidate = candidate.ToUniversalTime()
                if hasattr(candidate, "Ticks"):
                    delta = candidate - epoch
                    return float(delta.TotalMilliseconds)
        except Exception:
            return None
        return None

    def connect(self) -> None:
        if self.adapter == "af-sdk":
            self.close()
            clr = self._ensure_af_runtime()
            dll = self._validate_af_dll()
            clr.AddReference(dll)
            from OSIsoft.AF.PI import PIServer
            server = PIServer.FindPIServer(self.server_name)
            if server is None:
                raise RuntimeError(f"PI server not found: {self.server_name}")
            try:
                server.Connect()
            except Exception as exc:
                raise RuntimeError("AF SDK connection unavailable") from exc
            self.server = server
            return

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

    def _read_af_snapshot(self, tag: str) -> dict[str, Any]:
        if self.server is None:
            raise RuntimeError("AF SDK connection unavailable")
        if tag not in self.points:
            from OSIsoft.AF.PI import PIPoint
            self.points[tag] = PIPoint.FindPIPoint(self.server, tag)
        point = self.points[tag]
        if point is None:
            raise RuntimeError(f"AF point not found: {tag}")
        snapshot = point.Snapshot()
        raw = getattr(snapshot, "Value", None)
        status = str(getattr(snapshot, "Status", "Bad") or "Bad")
        good = bool(getattr(snapshot, "IsGood", False))
        if any(token in status.lower() for token in ("bad", "questionable", "unavailable", "not good", "digital")):
            good = False
        if isinstance(raw, bool):
            good = False
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = None
        if value is None or not math.isfinite(value):
            good = False
        timestamp_ms = self._af_timestamp_to_ms(getattr(snapshot, "Timestamp", None))
        if timestamp_ms is None or not math.isfinite(timestamp_ms):
            good = False
        if not good:
            status = status if status else "Bad"
        else:
            status = status or "Good"
        return {
            "value": value if good else None,
            "timestamp": timestamp_ms if good and math.isfinite(timestamp_ms) else None,
            "good": good,
            "status": status if status else ("Good" if good else "Bad"),
        }

    def read(self, tag: str) -> dict[str, Any]:
        if not tag or tag.lower().startswith("af:") or tag.startswith("\\\\"):
            raise ValueError("Configure an unqualified PI Point name")
        if self.adapter == "af-sdk":
            return self._read_af_snapshot(tag)
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
        if self.adapter == "af-sdk":
            raise RuntimeError("AF SDK adapter is read-only in this project; set enableWrites=false or use the PI SDK COM adapter for writes.")
        if tag not in self.allowed_outputs:
            raise PermissionError("PI output is not allow-listed")
        if type(state) is not int or state not in (0, 10, 20, 30, 40):
            raise ValueError("Invalid trend state")
        if self.server is None:
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
                if self.adapter == "af-sdk" and hasattr(self.server, "Disconnect"):
                    self.server.Disconnect()
                elif hasattr(self.server, "Close"):
                    self.server.Close()
            except Exception:
                pass
        self.server = None
        self.sdk = None
