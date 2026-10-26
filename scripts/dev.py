"""Run the local interface and numerical service. Ctrl-C stops both."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=8765)
    parser.add_argument("--web-port", type=int, default=5173)
    args = parser.parse_args()
    for port in (args.api_port, args.web_port):
        if not 1024 <= port <= 65535:
            parser.error("Choose ports from 1024 through 65535.")
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                parser.error(f"Port {port} is already in use. Choose another port.")
    if args.api_port == args.web_port:
        parser.error("The interface and service need different ports.")
    python = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    npm = shutil.which("npm")
    if not python.exists() or not (root / "apps/web/node_modules/vite").is_dir() or not npm:
        print("Run python3 scripts/setup.py before starting the simulator.", file=sys.stderr)
        return 1
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["VITE_API_TARGET"] = f"http://127.0.0.1:{args.api_port}"
    children: list[subprocess.Popen] = []

    def stop(_signum=None, _frame=None):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    print(f"Simulator: http://127.0.0.1:{args.web_port}", flush=True)
    print(f"Numerical service: http://127.0.0.1:{args.api_port}", flush=True)
    try:
        children.append(subprocess.Popen(
            [str(python), "-m", "uvicorn", "cubesat_sim.api:app", "--host", "127.0.0.1",
             "--port", str(args.api_port), "--no-access-log"], cwd=root, env=env,
            start_new_session=(os.name != "nt")))
        children.append(subprocess.Popen(
            [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(args.web_port),
             "--strictPort"], cwd=root / "apps/web", env=env,
            start_new_session=(os.name != "nt")))
        while True:
            for child in children:
                code = child.poll()
                if code is not None:
                    print(f"A development process stopped (exit {code}).", file=sys.stderr)
                    return code or 1
            time.sleep(0.4)
    except KeyboardInterrupt:
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                if os.name == "nt":
                    child.terminate()
                else:
                    os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    child.kill()
                else:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == "__main__":
    sys.exit(main())
