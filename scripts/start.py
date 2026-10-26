"""Prepare local dependencies and serve Yapling. Ctrl-C stops the server."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import uuid
import venv
import webbrowser


ROOT = Path(__file__).resolve().parents[1]
PYTHON_DOWNLOAD = "https://www.python.org/downloads/"
NODE_DOWNLOAD = "https://nodejs.org/en/download"


class StartError(Exception):
    pass


def capture(command: list[str]) -> str:
    try:
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT, timeout=20).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise StartError(f"Could not run {command[0]}: {error}") from error


def prerequisites(root: Path) -> tuple[str, list[str], str]:
    if sys.version_info < (3, 11):
        raise StartError(f"Python 3.11 or newer is required: {PYTHON_DOWNLOAD}")
    for name in ("services/simulator/pyproject.toml", "services/simulator/requirements-tested.txt",
                 "apps/web/package.json", "apps/web/package-lock.json", "apps/web/index.html"):
        if not (root / name).is_file():
            raise StartError(f"Project file is missing: {name}. Extract the complete Yapling ZIP first.")
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node or not npm:
        raise StartError(f"Install Node.js 22.12 or newer, including npm: {NODE_DOWNLOAD}")
    version = capture([node, "--version"])
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version)
    if not match or tuple(map(int, match.groups())) < (22, 12, 0):
        raise StartError(f"Node.js 22.12 or newer is required (found {version}): {NODE_DOWNLOAD}")
    npm_command = [npm]
    if os.name == "nt":
        npm_cli = Path(npm).parent / "node_modules/npm/bin/npm-cli.js"
        if not npm_cli.is_file():
            raise StartError(f"npm is incomplete. Reinstall Node.js with npm: {NODE_DOWNLOAD}")
        npm_command = [node, str(npm_cli)]
    npm_version = capture([*npm_command, "--version"])
    print(f"Python {sys.version.split()[0]}; Node.js {version}; npm {npm_version}", flush=True)
    return node, npm_command, f"{version}/{npm_version}"


def digest(paths: list[Path], base: Path, extra: str = "") -> str:
    result = hashlib.sha256(extra.encode("utf-8"))
    files = sorted({file for path in paths for file in (path.rglob("*") if path.is_dir() else [path])
                    if file.is_file()})
    for path in files:
        result.update(str(path.relative_to(base)).replace(os.sep, "/").encode("utf-8") + b"\0")
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                result.update(chunk)
        result.update(b"\0")
    return result.hexdigest()


def web_inputs(web: Path) -> list[Path]:
    return [path for path in web.iterdir()
            if path.name not in {"node_modules", "dist"} and not path.name.endswith(".tsbuildinfo")]


def read_state(root: Path) -> dict:
    try:
        value = json.loads((root / ".yapling/state.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(root: Path, state: dict) -> None:
    path = root / ".yapling/state.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


@contextmanager
def setup_lock(root: Path):
    cache = root / ".yapling"
    cache.mkdir(exist_ok=True)
    with (cache / "setup.lock").open("a+b") as lock:
        lock.write(b"0")
        lock.flush()
        deadline = time.monotonic() + 600
        waiting = False
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise StartError("Another Yapling launcher is still setting up. Try again when it finishes.")
                if not waiting:
                    print("Waiting for another Yapling launcher to finish setup...", flush=True)
                    waiting = True
                time.sleep(0.25)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def run_setup(command: list[str], cwd: Path, label: str) -> None:
    print(label, flush=True)
    process = None
    try:
        options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
                   else {"start_new_session": True})
        process = subprocess.Popen(command, cwd=cwd, **options)
        if process.wait():
            raise StartError(f"{label} failed. See the output above; fix the reported problem and run start.py again.")
    except (OSError, subprocess.CalledProcessError) as error:
        raise StartError(f"{label} failed. See the output above; fix the reported problem and run start.py again.") from error
    finally:
        if process is not None:
            stop_server(process)


def local_python(root: Path, create: bool = False) -> tuple[Path, str]:
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not environment.exists():
        if not create:
            return python, "missing"
        print("Creating the project Python environment...", flush=True)
        try:
            venv.create(environment, with_pip=True)
        except (OSError, subprocess.SubprocessError) as error:
            raise StartError(f"Could not create .venv: {error}. Check that Python includes venv and pip.") from error
    try:
        if not (environment / "pyvenv.cfg").is_file():
            raise StartError("pyvenv.cfg is missing")
        details = json.loads(capture([str(python), "-c", "import json,sys; print(json.dumps([list(sys.version_info[:3]),sys.prefix]))"]))
        if tuple(details[0]) < (3, 11) or Path(details[1]).resolve() != environment.resolve():
            raise StartError("it does not contain a project Python 3.11+ environment")
        return python, ".".join(map(str, details[0]))
    except (StartError, ValueError, OSError) as error:
        raise StartError(f"The existing .venv cannot be used: {error}. Rename .venv to .venv-old and run again; it has been preserved.") from error


def python_ready(python: Path, root: Path) -> bool:
    code = ("import sys; sys.dont_write_bytecode=True; import pathlib,cubesat_sim,fastapi,pydantic,uvicorn; "
            f"assert pathlib.Path(cubesat_sim.__file__).resolve().is_relative_to(pathlib.Path({str(root)!r}))")
    try:
        capture([str(python), "-c", code])
        return True
    except StartError:
        return False


def prepare(root: Path, npm: list[str], node_identity: str, check: bool = False) -> Path:
    python, python_version = local_python(root, create=not check)
    state = read_state(root)
    service = root / "services/simulator"
    python_key = digest([service / "pyproject.toml", service / "requirements-tested.txt"], root,
                        f"{root}/{python_version}")
    python_current = state.get("python") == python_key and python_ready(python, root)
    web = root / "apps/web"
    npm_key = digest([web / "package.json", web / "package-lock.json"], root, node_identity)
    npm_current = state.get("npm") == npm_key and all(
        (web / name).is_file() for name in ("node_modules/vite/bin/vite.js", "node_modules/typescript/bin/tsc", "node_modules/.package-lock.json"))
    build_key = digest(web_inputs(web), root, npm_key)
    dist = web / "dist"
    build_current = (state.get("build") == build_key and (dist / "index.html").is_file()
                     and state.get("dist") == digest([dist], root))
    if check:
        for label, current in (("Python dependencies", python_current), ("Browser dependencies", npm_current), ("Browser build", build_current)):
            print(f"{label}: {'ready' if current else 'will prepare on launch'}")
        return python
    if not python_current:
        run_setup([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-c",
                   str(service / "requirements-tested.txt"), "-e", str(service)], root, "Installing project Python dependencies...")
        if not python_ready(python, root):
            raise StartError("Python dependencies installed but the service could not be imported.")
        state["python"] = python_key
        save_state(root, state)
    if not npm_current:
        run_setup([*npm, "ci", "--include=dev", "--no-audit", "--no-fund"], web, "Installing locked browser dependencies...")
        state["npm"] = npm_key
        save_state(root, state)
        build_current = False
    if not build_current:
        with tempfile.TemporaryDirectory(prefix="build-", dir=root / ".yapling") as temporary:
            build = Path(temporary) / "dist"
            run_setup([*npm, "run", "build", "--", "--outDir", str(build), "--emptyOutDir"], web, "Building the browser interface...")
            if not (build / "index.html").is_file():
                raise StartError("The browser build did not produce index.html. The previous build was preserved.")
            previous = Path(temporary) / "previous-dist"
            if dist.exists():
                dist.rename(previous)
            try:
                build.rename(dist)
            except OSError:
                if previous.exists():
                    previous.rename(dist)
                raise
        state.update(build=build_key, dist=digest([dist], root))
        save_state(root, state)
    else:
        print("Local setup is up to date.", flush=True)
    return python


def available_port(requested: int) -> int:
    with socket.socket() as probe:
        if requested:
            probe.settimeout(1)
            if probe.connect_ex(("127.0.0.1", requested)) == 0:
                raise StartError(f"Local port {requested} is in use. Omit --port to choose a free port automatically.")
            return requested
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_ready(process: subprocess.Popen, url: str, token: str, timeout: float = 60) -> None:
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise StartError(f"The local server stopped during startup (exit {process.returncode}).")
        try:
            with opener.open(url + "/api/health", timeout=1) as response:
                ready = (response.status == 200 and response.headers.get("X-Yapling-Launch-Token") == token
                         and json.load(response).get("status") == "ok")
            if ready:
                with opener.open(url + "/", timeout=2) as response:
                    if response.status == 200 and process.poll() is None:
                        return
        except (OSError, URLError, ValueError):
            pass
        time.sleep(0.1)
    raise StartError("The local server did not become ready within 60 seconds.")


def stop_server(process: subprocess.Popen) -> None:
    if os.name == "nt" and process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=12)
    except (OSError, subprocess.TimeoutExpired):
        if process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def serve(root: Path, python: Path, port: int, browser: bool) -> int:
    token = uuid.uuid4().hex
    url = f"http://127.0.0.1:{port}"
    log = root / ".yapling" / f"server-{os.getpid()}.log"
    env = os.environ.copy()
    env.update(CUBESAT_WEB_DIST=str(root / "apps/web/dist"), CUBESAT_LAUNCH_TOKEN=token,
               PYTHONUNBUFFERED="1", PYTHONUTF8="1")
    options = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
               else {"start_new_session": True})
    process = None
    try:
        with log.open("w", encoding="utf-8") as stream:
            process = subprocess.Popen([str(python), "-m", "uvicorn", "cubesat_sim.api:app", "--host", "127.0.0.1",
                                        "--port", str(port), "--no-access-log"], cwd=root, env=env,
                                       stdout=stream, stderr=subprocess.STDOUT, **options)
            wait_ready(process, url, token)
            print(f"\nYapling Observatory: {url}\nKeep this window open. Ctrl-C stops Yapling.\nServer log: {log}", flush=True)
            if browser:
                try:
                    webbrowser.open(url)
                except webbrowser.Error:
                    print(f"Open {url} in your browser.", flush=True)
            code = process.wait()
            raise StartError(f"The local server stopped (exit {code}).")
    except StartError:
        print(f"Server log: {log}", file=sys.stderr)
        if log.exists():
            print("\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]), file=sys.stderr)
        raise
    finally:
        if process is not None:
            stop_server(process)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="show prerequisites and setup status without changing files")
    parser.add_argument("--no-browser", action="store_true", help="print the URL without opening a browser")
    parser.add_argument("--port", type=int, default=0, help="choose a localhost port (default: automatically select a free port)")
    args = parser.parse_args(argv)
    if args.port and not 1024 <= args.port <= 65535:
        parser.error("Choose a port from 1024 through 65535, or 0 for automatic selection.")

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signals = [signal.SIGTERM] + ([signal.SIGBREAK] if os.name == "nt" else [])
    previous = {number: signal.signal(number, interrupted) for number in signals}
    try:
        _, npm, node_identity = prerequisites(ROOT)
        if args.port:
            available_port(args.port)
        if args.check:
            prepare(ROOT, npm, node_identity, check=True)
            print("Prerequisites are ready. Run start.py to prepare and open Yapling.")
            return 0
        with setup_lock(ROOT):
            python = prepare(ROOT, npm, node_identity)
        return serve(ROOT, python, available_port(args.port), not args.no_browser)
    except KeyboardInterrupt:
        print("\nYapling stopped.", flush=True)
        return 0
    except (StartError, OSError) as error:
        print(f"\nCould not start Yapling: {error}", file=sys.stderr)
        return 1
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    sys.exit(main())
