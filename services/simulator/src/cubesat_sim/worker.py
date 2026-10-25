"""Owned subprocess entry point. Input/output paths are service-created only."""
import argparse
import json
from pathlib import Path

from .core import run_scenario
from .models import Scenario


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    scenario = Scenario.model_validate_json(Path(args.input).read_text())
    result = run_scenario(scenario)
    destination = Path(args.output)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
    temporary.replace(destination)


if __name__ == "__main__":
    main()
