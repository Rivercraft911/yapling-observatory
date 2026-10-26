"""Owned subprocess startup races and platform-specific termination paths."""
import asyncio
import os
import signal
import sys
from types import SimpleNamespace

import pytest

from cubesat_sim import mission_jobs, worker_process
from cubesat_sim.mission.defaults import default_mission_scenario


async def until(predicate, timeout=5):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.005)


def test_windows_cleanup_never_uses_posix_signals(monkeypatch):
    class Process:
        returncode = None
        calls = []

        def terminate(self):
            self.calls.append("terminate")

        def kill(self):
            self.calls.append("kill")
            self.returncode = 1

        async def wait(self):
            if self.returncode is None:
                await asyncio.Event().wait()
            return self.returncode

    monkeypatch.setattr(worker_process, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(worker_process, "signal", SimpleNamespace(SIGTERM=15))
    assert worker_process.owned_process_options() == {}
    process = Process()
    asyncio.run(worker_process.terminate_owned(process, timeout_s=.01))
    assert process.calls == ["terminate", "kill"] and process.returncode == 1


def test_cancel_during_actual_spawn_cleans_unassigned_child(monkeypatch):
    async def exercise():
        created, release = asyncio.Event(), asyncio.Event()
        children = []
        original = asyncio.create_subprocess_exec

        async def delayed(*command, **options):
            child = await original(*command, **options)
            children.append(child)
            created.set()
            await release.wait()
            return child

        monkeypatch.setattr(worker_process.asyncio, "create_subprocess_exec", delayed)
        task = asyncio.create_task(worker_process.create_owned_process(
            sys.executable, "-c", "import time; time.sleep(60)",
        ))
        await asyncio.wait_for(created.wait(), 5)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert len(children) == 1 and children[0].returncode is not None
    asyncio.run(exercise())


@pytest.mark.skipif(os.name != "posix", reason="POSIX-only process-group and ignored-SIGTERM behavior")
def test_posix_group_force_stop_reaps_a_stubborn_actual_worker(tmp_path):
    async def exercise():
        ready = tmp_path / "ready"
        process = await worker_process.create_owned_process(
            sys.executable, "-c",
            "import signal,time,sys; from pathlib import Path; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "Path(sys.argv[1]).write_text('ready'); time.sleep(60)", str(ready),
        )
        try:
            await until(ready.exists)
            assert os.getpgid(process.pid) == process.pid
            await worker_process.terminate_owned(process, timeout_s=.02)
            assert process.returncode == -signal.SIGKILL
        finally:
            await worker_process.terminate_owned(process)
    asyncio.run(exercise())


@pytest.mark.parametrize("operation", ["cancel", "close", "timeout"])
def test_batch_mission_actual_worker_cleanup(operation, monkeypatch):
    async def exercise():
        manager = mission_jobs.MissionJobManager(timeout_s=.001 if operation == "timeout" else 10)
        scenario = default_mission_scenario().model_copy(update={"duration_s": 300, "name": "Unicode transport: Δοκιμή 衛星"})
        processes = []
        original = worker_process.create_owned_process

        async def capture(*command, **options):
            process = await original(*command, **options)
            processes.append(process)
            return process

        monkeypatch.setattr(mission_jobs, "create_owned_process", capture)
        job = manager.create(scenario)
        try:
            if operation == "timeout":
                await asyncio.wait_for(job.task, 10)
                assert job.status == "failed" and "time budget" in job.error
            else:
                await until(lambda: job.process is not None)
                if operation == "cancel":
                    await manager.cancel(job.run_id)
                else:
                    await manager.close()
                assert job.status == "cancelled"
            assert processes and all(process.returncode is not None for process in processes)
            assert job.process is None and job.result is None
        finally:
            await manager.close()
    asyncio.run(exercise())
