"""Cancellable isolated mission workers with bounded retention and progress."""

import asyncio
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import uuid
from .mission_models import MissionScenario, mission_execution_limits
from .worker_sources import frozen_worker_options

MAX_RESULT_BYTES = 64 * 1024 * 1024


@dataclass
class MissionJob:
    scenario: MissionScenario
    run_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = "queued"
    result: dict | None = None
    error: str | None = None
    progress: dict | None = None
    created_at: float = field(default_factory=time.time)
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = None

    def record(self):
        identity, digest = self.scenario.identity()
        return dict(
            run_id=self.run_id,
            status=self.status,
            scenario_id=identity,
            scenario_hash=digest,
            result=self.result,
            error=self.error,
            progress=self.progress,
        )


class MissionJobManager:
    def __init__(self, *, timeout_s=None, max_active=2, max_retained=8):
        self.timeout_s = timeout_s
        self.max_active = max_active
        self.max_retained = max_retained
        self.jobs = {}
        self.slot = asyncio.Semaphore(1)

    def create(self, scenario):
        limits = mission_execution_limits(scenario)
        if limits["estimated_work_units"] > limits["maximum_work_units"]:
            raise ValueError("Mission exceeds the reference work-unit budget")
        active = sum(job.status in ("queued", "running") for job in self.jobs.values())
        if active >= self.max_active:
            raise ValueError("Mission queue full")
        while len(self.jobs) >= self.max_retained:
            finished = next(
                (
                    key
                    for key, job in self.jobs.items()
                    if job.status not in ("queued", "running")
                ),
                None,
            )
            if finished is None:
                raise ValueError("Mission retention full")
            del self.jobs[finished]
        job = MissionJob(scenario)
        job.progress = dict(state="queued", execution_limits=limits)
        self.jobs[job.run_id] = job
        job.task = asyncio.create_task(self._execute(job))
        return job

    def get(self, run_id):
        return self.jobs.get(run_id)

    async def _stop_process(self, job):
        if job.process and job.process.returncode is None:
            try:
                os.killpg(job.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(job.process.wait(), 2.0)
            except TimeoutError:
                try:
                    os.killpg(job.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await job.process.wait()

    async def cancel(self, run_id):
        job = self.get(run_id)
        if job and job.status in ("queued", "running"):
            job.status = "cancelled"
            if job.task:
                job.task.cancel()
            await self._stop_process(job)
            if job.task:
                try:
                    await job.task
                except asyncio.CancelledError:
                    pass
        return job

    async def _execute(self, job):
        try:
            async with self.slot:
                if job.status == "cancelled":
                    return
                job.status = "running"
                with tempfile.TemporaryDirectory(prefix="ssi-mission-") as directory:
                    base = Path(directory)
                    source = base / "scenario.json"
                    destination = base / "result.json"
                    progress_path = base / "progress.json"
                    source.write_text(job.scenario.model_dump_json())
                    worker_options = frozen_worker_options(base)
                    job.process = await asyncio.create_subprocess_exec(
                        sys.executable,
                        "-m",
                        "cubesat_sim.mission_worker",
                        str(source),
                        str(destination),
                        str(progress_path),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                        start_new_session=True,
                        **worker_options,
                    )
                    communicate = asyncio.create_task(job.process.communicate())
                    limits = mission_execution_limits(job.scenario)
                    timeout_s = (self.timeout_s if self.timeout_s is not None
                                 else limits["worker_wall_limit_s"])
                    deadline = time.monotonic() + timeout_s
                    try:
                        while not communicate.done():
                            if time.monotonic() >= deadline:
                                raise TimeoutError(
                                    "Mission exceeded worker time budget"
                                )
                            if progress_path.exists():
                                try:
                                    job.progress = json.loads(progress_path.read_text()) | dict(execution_limits=limits)
                                except (OSError, json.JSONDecodeError):
                                    pass
                            await asyncio.wait({communicate}, timeout=0.15)
                        _, stderr = await communicate
                    finally:
                        if not communicate.done():
                            await self._stop_process(job)
                            await communicate
                    if job.status == "cancelled":
                        return
                    if job.process.returncode != 0:
                        raise ValueError(stderr.decode(errors="replace")[-3000:])
                    if destination.stat().st_size > MAX_RESULT_BYTES:
                        raise ValueError(
                            "Mission result exceeds 64 MiB; choose an explicitly coarser output clock or a narrower telemetry configuration"
                        )
                    result = json.loads(destination.read_text())
                    if (
                        result["manifest"]["scenario_hash"]
                        != job.scenario.identity()[1]
                    ):
                        raise ValueError("Worker input identity mismatch")
                    job.result = result
                    if progress_path.exists():
                        job.progress = json.loads(progress_path.read_text()) | dict(execution_limits=limits)
                    job.status = "complete"
        except asyncio.CancelledError:
            await self._stop_process(job)
            job.status = "cancelled"
        except Exception as error:
            await self._stop_process(job)
            if job.status != "cancelled":
                job.status = "failed"
                job.error = str(error)
        finally:
            job.process = None

    async def close(self):
        for key in tuple(self.jobs):
            await self.cancel(key)
