"""Process boundary for a bounded mission; no numerical formulas here."""

import json
import os
from pathlib import Path
import sys
import time
from .mission_models import MissionScenario
from .mission.driver import run_mission


def atomic_json(path, value):
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")))
    os.replace(temporary, path)


def main():
    source, destination, progress_path = map(Path, sys.argv[1:4])
    config = MissionScenario.model_validate_json(source.read_text())
    last_progress = [0.0]

    def publish(value):
        now = time.monotonic()
        if now - last_progress[0] >= 0.1 or value.get("state") == "finished":
            atomic_json(progress_path, value)
            last_progress[0] = now

    result = run_mission(config, progress=publish)
    atomic_json(destination, result)


if __name__ == "__main__":
    main()
