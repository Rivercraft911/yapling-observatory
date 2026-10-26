"""Exercise first and cached local launches through the real HTTP service."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]


def request(base, path, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    query = urllib.request.Request(base + path, data=data,
                                   headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(query, timeout=10) as response:
        return response.read()


def exercise(port, log_path):
    base = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    for key in ("CUBESAT_MODEL_MANIFEST", "CUBESAT_WEB_DIST", "CUBESAT_LAUNCH_TOKEN"):
        env.pop(key, None)
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {}
    with log_path.open("wb") as log:
        child = subprocess.Popen([sys.executable, str(ROOT / "start.py"), "--no-browser", "--port", str(port)],
                                 cwd=log_path.parent, env=env, stdout=log, stderr=subprocess.STDOUT, **options)
        try:
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise AssertionError(f"Launcher exited with {child.returncode}")
                try:
                    health = json.loads(request(base, "/api/health"))
                    if health["status"] == "ok":
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.25)
            else:
                raise AssertionError("Local setup did not become ready within ten minutes")

            page = request(base, "/").decode("utf-8")
            assert "Yapling Observatory" in page
            scripts = re.findall(r'<script[^>]+src="([^"]+)"', page)
            assert scripts and all(request(base, path) for path in scripts)
            assert request(base, "/THIRD_PARTY_NOTICES.txt")
            assert request(base, "/earth/cloud-tiles.json")
            assert request(base, "/api/assets/spacecraft.glb?variant=dipole")[:4] == b"glTF"
            try:
                request(base, "/api/does-not-exist")
            except urllib.error.HTTPError as exc:
                assert exc.code == 404
            else:
                raise AssertionError("Unknown API path returned a successful page")

            scenario = json.loads(request(base, "/api/mission/default"))["scenario"]
            scenario.update(name="Local launch \u00b7 S\u00e3o Paulo \U0001f6f0", duration_s=60)
            job = json.loads(request(base, "/api/mission/runs", {"scenario": scenario}))
            deadline = time.monotonic() + 90
            while job["status"] in ("queued", "running", "cancelling") and time.monotonic() < deadline:
                time.sleep(0.1)
                job = json.loads(request(base, "/api/mission/runs/" + job["run_id"]))
            assert job["status"] == "complete", job.get("error", job["status"])
            result = job["result"]
            assert result["manifest"]["scenario"]["name"] == scenario["name"]
            assert result["samples"]["time_s"][-1] == 60
            assert result["summary"]["end_reason"] == "requested_duration"
        finally:
            if child.poll() is None:
                child.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGINT)
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], check=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    child.kill()
                child.wait(timeout=5)
                raise AssertionError("Launcher did not shut down cleanly")
    with socket.socket() as probe:
        probe.settimeout(1)
        assert probe.connect_ex(("127.0.0.1", port)) != 0, "Service remained after launcher shutdown"
    assert child.returncode == 0, f"Launcher shutdown exit code: {child.returncode}"


def main():
    with tempfile.TemporaryDirectory(prefix="yapling launch check ") as directory:
        folder = Path(directory)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        cache_before = None
        for label in ("first", "cached"):
            log = folder / (label + ".log")
            try:
                exercise(port, log)
            except Exception:
                print(log.read_text(encoding="utf-8", errors="replace"), file=sys.stderr)
                raise
            cache_after = tuple(path.stat().st_mtime_ns for path in
                                (ROOT / ".yapling/state.json", ROOT / "apps/web/dist/index.html"))
            if cache_before is not None:
                assert cache_after == cache_before, "Cached launch repeated setup or rebuilt the interface"
            cache_before = cache_after
            print(f"{label.capitalize()} launch: interface, bundled assets, numerical worker and shutdown passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
