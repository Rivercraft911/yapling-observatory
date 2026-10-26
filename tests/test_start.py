"""Launcher behavior without downloading dependencies or starting the simulator."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SPEC = importlib.util.spec_from_file_location("yapling_start", Path(__file__).resolve().parents[1] / "scripts/start.py")
start = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(start)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="Yapling test with spaces ")
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.web = self.root / "apps/web"
        for name in ("services/simulator/pyproject.toml", "services/simulator/requirements-tested.txt",
                     "apps/web/package.json", "apps/web/package-lock.json", "apps/web/index.html",
                     "apps/web/src/main.ts", "apps/web/public/asset.txt"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("input", encoding="utf-8")

    def test_missing_prerequisite_is_actionable_and_does_not_mutate_project(self):
        before = set(self.root.rglob("*"))
        with patch.object(start.shutil, "which", return_value=None):
            with self.assertRaisesRegex(start.StartError, "https://nodejs.org/en/download"):
                start.prerequisites(self.root)
        self.assertEqual(before, set(self.root.rglob("*")))

    def test_node_22_early_minor_is_rejected(self):
        with patch.object(start.shutil, "which", return_value="node"), patch.object(start, "capture", return_value="v22.11.0"):
            with self.assertRaisesRegex(start.StartError, "22.12"):
                start.prerequisites(self.root)

    def test_check_on_clean_zip_does_not_create_environment_or_cache(self):
        before = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        with patch.object(start, "ROOT", self.root), patch.object(start, "prerequisites", return_value=("node", ["npm"], "22.12/10")):
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(start.main(["--check"]), 0)
        self.assertIn("will prepare", output.getvalue())
        self.assertFalse((self.root / ".venv").exists())
        self.assertFalse((self.root / ".yapling").exists())
        after = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)

    def fake_setup(self, command, cwd, label):
        self.commands.append(command)
        if "ci" in command:
            for name in ("vite/bin/vite.js", "typescript/bin/tsc", ".package-lock.json"):
                path = self.web / "node_modules" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("installed", encoding="utf-8")
        if "--outDir" in command:
            build = Path(command[command.index("--outDir") + 1])
            build.mkdir(parents=True)
            (build / "index.html").write_text("working interface", encoding="utf-8")

    def prepare(self):
        return start.prepare(self.root, ["npm"], "22.12/10")

    def setup_cache(self):
        (self.root / ".yapling").mkdir()
        self.commands = []
        self.enterContext(patch.object(start, "local_python", return_value=(Path(sys.executable), "3.11.0")))
        self.enterContext(patch.object(start, "python_ready", return_value=True))
        self.enterContext(patch.object(start, "run_setup", side_effect=self.fake_setup))
        self.enterContext(redirect_stdout(io.StringIO()))

    def test_first_launch_installs_production_dependencies_and_second_launch_reuses_cache(self):
        self.setup_cache()
        self.prepare()
        self.assertEqual(len(self.commands), 3)
        pip = self.commands[0]
        self.assertIn(str(self.root / "services/simulator/requirements-tested.txt"), pip)
        self.assertIn(str(self.root / "services/simulator"), pip)
        self.assertFalse(any("[dev]" in value for value in pip))
        self.assertIn("ci", self.commands[1])
        self.commands.clear()
        self.prepare()
        self.assertEqual(self.commands, [])

    def test_source_asset_lock_and_constraints_changes_invalidate_the_right_steps(self):
        self.setup_cache()
        self.prepare()
        for name, expected in (("apps/web/src/main.ts", 1), ("apps/web/public/asset.txt", 1),
                               ("apps/web/package-lock.json", 2), ("services/simulator/requirements-tested.txt", 1)):
            self.commands.clear()
            (self.root / name).write_text("changed", encoding="utf-8")
            self.prepare()
            self.assertEqual(len(self.commands), expected, name)
            self.assertIn("pip" if name.endswith("requirements-tested.txt") else "build", self.commands[-1])

    def test_missing_build_output_is_repaired(self):
        self.setup_cache()
        self.prepare()
        (self.web / "dist/index.html").unlink()
        self.commands.clear()
        self.prepare()
        self.assertEqual(len(self.commands), 1)
        self.assertTrue((self.web / "dist/index.html").is_file())

    def test_failed_build_preserves_working_dist_and_does_not_stamp_failure(self):
        self.setup_cache()
        self.prepare()
        before = (self.root / ".yapling/state.json").read_bytes()
        (self.web / "src/main.ts").write_text("change", encoding="utf-8")
        with patch.object(start, "run_setup", side_effect=start.StartError("build failed")):
            with self.assertRaisesRegex(start.StartError, "build failed"):
                self.prepare()
        self.assertEqual((self.web / "dist/index.html").read_text(encoding="utf-8"), "working interface")
        self.assertEqual(before, (self.root / ".yapling/state.json").read_bytes())

    def test_invalid_existing_environment_is_preserved(self):
        (self.root / ".venv").mkdir()
        marker = self.root / ".venv/keep.txt"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(start.StartError, "Rename .venv"):
            start.local_python(self.root, create=True)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_busy_port_is_not_reused_or_closed_and_automatic_port_is_available(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            with self.assertRaisesRegex(start.StartError, "Omit --port"):
                start.available_port(port)
            self.assertEqual(occupied.getsockname()[1], port)
            automatic = start.available_port(0)
            self.assertNotEqual(automatic, port)
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", automatic))

    def test_readiness_requires_own_health_token_and_served_interface(self):
        class Handler(BaseHTTPRequestHandler):
            token = "other-server"
            ui_status = 200

            def do_GET(self):
                self.send_response(200 if self.path == "/api/health" else self.ui_status)
                self.send_header("X-Yapling-Launch-Token", self.token)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}' if self.path == "/api/health" else b"interface")

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        process = Mock()
        process.poll.return_value = None
        url = f"http://127.0.0.1:{server.server_port}"
        with self.assertRaises(start.StartError):
            start.wait_ready(process, url, "ours", timeout=0.15)
        Handler.token = "ours"
        Handler.ui_status = 404
        with self.assertRaises(start.StartError):
            start.wait_ready(process, url, "ours", timeout=0.15)
        Handler.ui_status = 200
        start.wait_ready(process, url, "ours", timeout=1)
        process.poll.return_value = 1
        process.returncode = 1
        with self.assertRaisesRegex(start.StartError, "exit 1"):
            start.wait_ready(process, url, "ours", timeout=1)

    def test_server_failure_shows_log_and_never_opens_browser(self):
        (self.root / ".yapling").mkdir()
        process = Mock()
        process.poll.return_value = 1
        with patch.object(start.subprocess, "Popen", return_value=process), patch.object(start, "stop_server"), \
                patch.object(start, "wait_ready", side_effect=start.StartError("startup failed")), \
                patch.object(start.webbrowser, "open") as browser, redirect_stderr(io.StringIO()) as error:
            with self.assertRaises(start.StartError):
                start.serve(self.root, Path(sys.executable), 5555, True)
        browser.assert_not_called()
        self.assertIn("Server log:", error.getvalue())

    @unittest.skipIf(os.name == "nt", "POSIX process group check")
    def test_stopping_owned_server_preserves_unrelated_process(self):
        owned = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        def cleanup(process):
            if process.poll() is None:
                process.kill()
            process.wait()
        self.addCleanup(cleanup, unrelated)
        self.addCleanup(cleanup, owned)
        start.stop_server(owned)
        self.assertIsNotNone(owned.poll())
        self.assertIsNone(unrelated.poll())


if __name__ == "__main__":
    unittest.main()
