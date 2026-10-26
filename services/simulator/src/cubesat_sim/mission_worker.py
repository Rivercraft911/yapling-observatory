"""Process boundary for a bounded mission; no numerical formulas here."""

import json
import os
from pathlib import Path
import sys
import time
from .mission_models import MissionScenario, mission_execution_limits
from .mission.driver import run_mission


def atomic_json(path, value, *, maximum_bytes=None):
    temporary = path.with_suffix(".partial")
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if maximum_bytes is not None and len(encoded) > maximum_bytes:
        raise ValueError(
            "Mission result exceeds 64 MiB; choose an explicitly coarser output clock or a narrower telemetry configuration"
        )
    temporary.write_bytes(encoded)
    os.replace(temporary, path)


def main():
    source, destination, progress_path = map(Path, sys.argv[1:4])
    config = MissionScenario.model_validate_json(source.read_text())
    last_progress = [0.0]
    limits = mission_execution_limits(config)
    started = time.monotonic()

    def publish(value):
        now = time.monotonic()
        if now - last_progress[0] >= 0.1 or value.get("state") == "finished":
            atomic_json(progress_path, value | dict(
                worker_elapsed_s=now - started, execution_limits=limits,
            ))
            last_progress[0] = now

    result = run_mission(config, progress=publish)
    atomic_json(destination, result, maximum_bytes=64 * 1024 * 1024)


if __name__ == "__main__":
    main()
