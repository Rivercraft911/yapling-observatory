"""Headless reproduction: cubesat-sim default, run, or serve."""
import argparse
import json
from pathlib import Path

from .core import run_scenario
from .models import Scenario, default_scenario


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    default = sub.add_parser("default", help="Print the complete editable illustrative Scenario JSON")
    default.add_argument("--output")
    run = sub.add_parser("run", help="Evaluate a Scenario JSON without a browser or API")
    run.add_argument("scenario")
    run.add_argument("--output", required=True)
    serve = sub.add_parser("serve", help="Serve the loopback API on 127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn
        uvicorn.run("cubesat_sim.api:app", host="127.0.0.1", port=args.port)
    elif args.command == "default":
        text = json.dumps(default_scenario().model_dump(mode="json"), indent=2, allow_nan=False)
        if args.output:
            Path(args.output).write_text(text+"\n")
        else:
            print(text)
    else:
        scenario = Scenario.model_validate_json(Path(args.scenario).read_text())
        Path(args.output).write_text(json.dumps(run_scenario(scenario), allow_nan=False, separators=(",", ":"))+"\n")


if __name__ == "__main__":
    main()
