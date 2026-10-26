"""The launcher must preserve an operator override and need no private tree."""
import importlib.util
from pathlib import Path

import pytest


def load_launcher():
    source = Path(__file__).resolve().parents[3] / "scripts" / "dev.py"
    spec = importlib.util.spec_from_file_location("dev_launcher", source)
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    return launcher


@pytest.mark.parametrize("override", [None, "/operator/models.json"])
def test_launcher_uses_bundled_models_unless_operator_selects_manifest(tmp_path, monkeypatch, override):
    launcher = load_launcher()
    python = tmp_path / ".venv" / ("Scripts/python.exe" if launcher.os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.touch()
    (tmp_path / "apps/web/node_modules/vite").mkdir(parents=True)
    monkeypatch.setattr(launcher, "__file__", str(tmp_path / "scripts/dev.py"))
    monkeypatch.setattr(launcher.shutil, "which", lambda _name: "/npm")
    monkeypatch.setattr(launcher.signal, "signal", lambda *_args: None)
    monkeypatch.setattr(launcher.os, "killpg", lambda *_args: None, raising=False)
    monkeypatch.setattr(launcher.sys, "argv", ["dev.py"])
    if override is None:
        monkeypatch.delenv("CUBESAT_MODEL_MANIFEST", raising=False)
    else:
        monkeypatch.setenv("CUBESAT_MODEL_MANIFEST", override)

    class FreePort:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def connect_ex(self, _address):
            return 1

    class Child:
        pid = 123

        def poll(self):
            return None

        def wait(self, **_kwargs):
            return 0

        def terminate(self):
            pass

    calls = []

    def start(command, **kwargs):
        calls.append((command, kwargs))
        return Child()

    def stop_after_launch(_seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(launcher.socket, "socket", lambda: FreePort())
    monkeypatch.setattr(launcher.subprocess, "Popen", start)
    monkeypatch.setattr(launcher.time, "sleep", stop_after_launch)
    assert launcher.main() == 0
    assert len(calls) == 2
    for _command, options in calls:
        assert options["env"].get("CUBESAT_MODEL_MANIFEST") == override
    assert calls[0][1]["cwd"] == tmp_path
