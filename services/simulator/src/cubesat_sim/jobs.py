"""Bounded local jobs with owned, killable CPU worker processes."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
import tempfile
from uuid import uuid4

from .models import Scenario
from .worker_process import create_owned_process, terminate_owned

TERMINAL = {"complete", "failed", "cancelled"}


@dataclass
class Job:
    run_id: str
    scenario: Scenario
    status: str = "queued"
    result: dict | None = None
    error: str | None = None
    created_at_utc: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    task: asyncio.Task | None = None
    process: asyncio.subprocess.Process | None = None
    directory: str | None = None

    def public(self):
        scenario_id, scenario_hash = self.scenario.identity()
        return dict(run_id=self.run_id, status=self.status, scenario_id=scenario_id,
                    scenario_hash=scenario_hash, created_at_utc=self.created_at_utc,
                    result=self.result if self.status == "complete" else None, error=self.error)


class JobManager:
    def __init__(self, max_active=4, max_retained=16, timeout_s=60):
        self.jobs = {}
        self.semaphore = asyncio.Semaphore(1)
        self.max_active = max_active
        self.max_retained = max_retained
        self.timeout_s = timeout_s

    def submit(self, scenario):
        if sum(job.status not in TERMINAL for job in self.jobs.values()) >= self.max_active:
            raise OverflowError("Local job queue is full (maximum 4 active/queued jobs)")
        if len(self.jobs) >= self.max_retained:
            oldest = next((key for key, job in self.jobs.items() if job.status in TERMINAL), None)
            if oldest is None:
                raise OverflowError("Local job retention limit reached")
            del self.jobs[oldest]
        job = Job("run_"+uuid4().hex, scenario)
        self.jobs[job.run_id] = job
        job.task = asyncio.create_task(self._execute(job))
        return job

    async def _execute(self, job):
        try:
            async with self.semaphore:
                if job.status != "queued":
                    return
                job.status = "running"
                job.directory = tempfile.mkdtemp(prefix="cubesat-run-")
                directory = Path(job.directory)
                scenario_path, result_path = directory/"scenario.json", directory/"result.json"
                scenario_path.write_text(job.scenario.model_dump_json(), encoding="utf-8")
                job.process = await create_owned_process(
                    sys.executable, "-m", "cubesat_sim.worker", str(scenario_path), str(result_path),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                )
                try:
                    _, stderr = await asyncio.wait_for(job.process.communicate(), timeout=self.timeout_s)
                except asyncio.TimeoutError:
                    await terminate_owned(job.process)
                    job.error = "Worker exceeded the local 60-second time budget"
                    job.status = "failed"
                    return
                if job.status != "running":
                    return
                if job.process.returncode != 0:
                    job.status = "failed"
                    # Do not return machine paths or arbitrary unbounded worker output.
                    job.error = "Numerical worker failed: "+stderr.decode(errors="replace").strip().splitlines()[-1][:500] if stderr else "Numerical worker failed"
                    return
                result = json.loads(result_path.read_text(encoding="utf-8"))
                if result.get("manifest", {}).get("scenario_hash") != job.scenario.identity()[1]:
                    raise ValueError("Worker result scenario identity mismatch")
                job.result = result
                job.status = "complete"
        except asyncio.CancelledError:
            if job.process is not None:
                await terminate_owned(job.process)
            job.result = None
            job.status = "cancelled"
        except Exception as exc:
            job.result = None
            job.status = "failed"
            job.error = type(exc).__name__+": local run could not be completed"
        finally:
            if job.process is not None and job.process.returncode is None:
                await terminate_owned(job.process)
            if job.directory:
                shutil.rmtree(job.directory, ignore_errors=True)

    async def cancel(self, run_id):
        job = self.jobs[run_id]
        if job.status in TERMINAL:
            return job
        job.status = "cancelling"
        job.task.cancel()
        try:
            await job.task
        except asyncio.CancelledError:
            pass
        # Covers cancellation before the task body first starts.
        job.status = "cancelled"
        job.result = None
        if job.process is not None:
            await terminate_owned(job.process)
        if job.directory:
            shutil.rmtree(job.directory, ignore_errors=True)
        return job

    async def close(self):
        for run_id in list(self.jobs):
            if self.jobs[run_id].status not in TERMINAL:
                await self.cancel(run_id)
