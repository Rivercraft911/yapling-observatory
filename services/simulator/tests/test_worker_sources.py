"""Frozen worker imports, bundled data, edit races and guarded source identity."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pydantic
import pytest

from cubesat_sim import worker_sources
from cubesat_sim.live_mission_jobs import LiveMissionJobManager
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import _source_hashes, run_mission
from cubesat_sim.mission_jobs import MissionJobManager
from cubesat_sim.mission_models import MissionScenario
from cubesat_sim.models import canonical_json


def mission():
    values = default_mission_scenario().model_dump(mode="json")
    values["duration_s"] = 30
    values["name"] = "Unicode transport: Δοκιμή 衛星"
    return MissionScenario.model_validate(values)


async def until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Worker did not reach the expected state")
        await asyncio.sleep(.02)


def test_actual_import_uses_snapshot_data_and_preserves_dependency_paths(tmp_path, monkeypatch):
    dependency = tmp_path / "relative-dependencies"
    dependency.mkdir()
    (dependency / "snapshot_dependency.py").write_text("VALUE = 'retained dependency path'\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PYTHONPATH", "relative-dependencies")
    directory = tmp_path / "job"
    directory.mkdir()
    options = worker_sources.frozen_worker_options(directory)
    code = """
import json
import os
from pathlib import Path
import cubesat_sim
import pydantic
import snapshot_dependency
from cubesat_sim.mission.defaults import default_mission_scenario
from cubesat_sim.mission.driver import _source_hashes
from cubesat_sim.geomagnetism.igrf14 import model_metadata
from cubesat_sim.power.battery_electrical import electrical_model_metadata
print(json.dumps(dict(package=str(Path(cubesat_sim.__file__).resolve()),
    dependency=snapshot_dependency.VALUE, pydantic=pydantic.__version__,
    hashes=_source_hashes(), panels=len(default_mission_scenario().power.panels),
    magnetic=model_metadata(), battery=electrical_model_metadata())))
"""
    child = subprocess.run([sys.executable, "-c", code], **options,
                           capture_output=True, text=True, check=True)
    result = json.loads(child.stdout)
    assert Path(result["package"]) == directory / "worker-source/cubesat_sim/__init__.py"
    assert result["dependency"] == "retained dependency path"
    assert result["pydantic"] == pydantic.__version__
    assert result["hashes"] == _source_hashes()
    assert result["panels"] == len(default_mission_scenario().power.panels)
    from cubesat_sim.geomagnetism.igrf14 import model_metadata
    from cubesat_sim.power.battery_electrical import electrical_model_metadata
    assert result["magnetic"] == model_metadata()
    assert result["battery"] == electrical_model_metadata()
    assert not list((directory / "worker-source").rglob("*.pyc"))


def test_source_edit_during_staging_rejects_and_removes_partial_snapshot(tmp_path, monkeypatch):
    package = tmp_path / "editable-package"
    package.mkdir()
    (package / "__init__.py").write_text("VALUE = 1\n")
    monkeypatch.setattr(worker_sources, "PACKAGE", package)
    original = worker_sources._source_bytes
    calls = []

    def edit_after_read(source):
        result = original(source)
        if source == package:
            calls.append(source)
            if len(calls) == 1:
                (package / "__init__.py").write_text("VALUE = 2\n")
        return result

    monkeypatch.setattr(worker_sources, "_source_bytes", edit_after_read)
    directory = tmp_path / "job"
    directory.mkdir()
    with pytest.raises(ValueError, match="sources changed"):
        worker_sources.frozen_worker_options(directory)
    assert list(directory.iterdir()) == []


def test_copy_is_limited_to_package_python_data_and_rejects_symlinks(tmp_path, monkeypatch):
    package = tmp_path / "editable-package"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "runtime.json").write_text('{"value": 1}')
    (package / "coefficients.txt").write_text("1 2 3\n")
    (package / "notes.md").write_text("Not a runtime asset")
    (package / ".env").write_text("NOT_A_REAL_SECRET=example")
    monkeypatch.setattr(worker_sources, "PACKAGE", package)
    directory = tmp_path / "job"
    directory.mkdir()
    options = worker_sources.frozen_worker_options(directory)
    copied = Path(options["cwd"]) / "cubesat_sim"
    assert {path.name for path in copied.iterdir()} == {
        "__init__.py", "runtime.json", "coefficients.txt"
    }
    external = tmp_path / "outside.json"
    external.write_text('{"private": "not copied"}')
    try:
        (package / "external.json").symlink_to(external)
    except OSError:
        if os.name == "nt":
            pytest.skip("Creating symlinks requires additional Windows privileges")
        raise
    other = tmp_path / "other-job"
    other.mkdir()
    with pytest.raises(ValueError, match="symlinks"):
        worker_sources.frozen_worker_options(other)
    assert list(other.iterdir()) == []


def test_actual_batch_worker_retains_complete_numerical_byte_parity():
    async def execute():
        scenario = mission()
        expected = run_mission(scenario)
        manager = MissionJobManager(timeout_s=10)
        try:
            job = manager.create(scenario)
            await asyncio.wait_for(job.task, 15)
            assert job.status == "complete", job.error
            assert canonical_json(job.result) == canonical_json(expected)
            assert job.process is None
        finally:
            await manager.close()
    asyncio.run(execute())


@pytest.mark.parametrize("change_frozen_copy", [False, True])
def test_new_live_worker_survives_editable_source_changes_but_guards_its_copy(
    tmp_path, monkeypatch, change_frozen_copy,
):
    seed = tmp_path / "seed"
    seed.mkdir()
    options = worker_sources.frozen_worker_options(seed)
    editable_package = Path(options["cwd"]) / "cubesat_sim"
    monkeypatch.setattr(worker_sources, "PACKAGE", editable_package)
    expected_hashes = _source_hashes()

    async def execute():
        manager = LiveMissionJobManager()
        job = manager.create(mission(), speed=1)
        manager.control(job, paused=True)
        try:
            await until(lambda: job.status == "paused")
            frozen_package = job.base / "worker-source/cubesat_sim"
            assert frozen_package != editable_package
            changed = (frozen_package if change_frozen_copy else editable_package) / "mission/driver.py"
            changed.write_bytes(changed.read_bytes() + b"\n# Source edit after the paused worker captured its starting identity.\n")
            manager.control(job, paused=False, speed=1000)
            await asyncio.wait_for(job.task, 10)
            if change_frozen_copy:
                assert job.status == "failed"
                assert "source" in job.error.lower() and "changed" in job.error.lower()
                assert job.final_snapshot is None and job.archive is None
            else:
                assert job.status == "complete", job.error
                result = job.final_snapshot["run"]["result"]
                assert result["manifest"]["source_code_hashes"] == expected_hashes
                assert canonical_json(result) == canonical_json(run_mission(job.scenario))
            assert job.base is None and job.process is None
        finally:
            await manager.close()
    asyncio.run(execute())
