"""Bounded owned LIVE sessions; provisional rows never masquerade as Run results."""
import asyncio
from collections import deque
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import uuid

from .mission_archive import export_archive
from .mission_models import MissionScenario, PointingIntent, mission_execution_limits

MAX_BYTES = 64 * 1024 * 1024
ACTIVE = {'starting', 'running', 'paused', 'stopping'}


@dataclass
class LiveSession:
    scenario: MissionScenario
    speed: float
    live_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = 'starting'
    paused: bool = False
    stop: bool = False
    resume_generation: int = 0
    lease_until: float = 0
    intents: dict = field(default_factory=dict)
    accepted: dict = field(default_factory=dict)
    events: deque = field(default_factory=lambda: deque(maxlen=2048))
    latest_sequence: int = 0
    sample_count: int = 0
    last_sample_time_s: float | None = None
    latest_telemetry: dict | None = None
    latest_telemetry_stamp: int | None = None
    progress: dict = field(default_factory=dict)
    final_snapshot: dict | None = None
    archive: bytes | None = None
    error: str | None = None
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = None
    directory: object | None = None
    base: Path | None = None
    journal_offset: int = 0


class LiveMissionJobManager:
    def __init__(self, *, lease_s=30, max_retained=4, heartbeat_timeout_s=15):
        self.lease_s = lease_s
        self.max_retained = max_retained
        self.heartbeat_timeout_s = heartbeat_timeout_s
        self.sessions = {}

    def _write_control(self, job):
        if job.base is None:
            return
        value = dict(speed=job.speed, paused=job.paused, stop=job.stop,
                     resume_generation=job.resume_generation, lease_until=job.lease_until,
                     commands=[intent.model_dump(mode='json') for intent in job.intents.values()])
        path = job.base / 'control.json'
        temporary = path.with_suffix('.partial')
        temporary.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')))
        os.replace(temporary, path)

    def create(self, scenario, speed=1):
        if any(job.status in ACTIVE for job in self.sessions.values()):
            raise ValueError('One LIVE session may be active at a time')
        limits = mission_execution_limits(scenario)
        if limits['estimated_work_units'] > limits['maximum_work_units']:
            raise ValueError('Mission exceeds the numerical work budget')
        if not 1 <= speed <= 1000:
            raise ValueError('LIVE speed must lie between 1 and 1000')
        while len(self.sessions) >= self.max_retained:
            key = next((key for key, job in self.sessions.items() if job.status not in ACTIVE), None)
            if key is None:
                raise ValueError('LIVE retention is full')
            del self.sessions[key]
        job = LiveSession(scenario, speed)
        job.directory = tempfile.TemporaryDirectory(prefix='ssi-live-')
        job.base = Path(job.directory.name)
        (job.base / 'scenario.json').write_text(scenario.model_dump_json())
        job.lease_until = time.monotonic() + self.lease_s
        self._write_control(job)
        self.sessions[job.live_id] = job
        job.task = asyncio.create_task(self._execute(job))
        return job

    def get(self, live_id):
        return self.sessions.get(live_id)

    def record(self, job, after_sequence=0, *, renew=True):
        if after_sequence < 0 or after_sequence > job.latest_sequence:
            raise ValueError('after_sequence must identify an already returned LIVE event')
        if renew and job.status in ACTIVE:
            job.lease_until = time.monotonic() + self.lease_s
            self._write_control(job)
        first = job.events[0]['sequence'] if job.events else job.latest_sequence + 1
        selected = [event for event in job.events if event['sequence'] > after_sequence][:512]
        next_sequence = selected[-1]['sequence'] if selected else after_sequence
        identity, digest = job.scenario.identity()
        terminal = job.status not in ACTIVE
        return dict(
            live_id=job.live_id, status=job.status,
            initial_scenario=job.scenario.model_dump(mode='json'),
            initial_scenario_id=identity, initial_scenario_hash=digest,
            computed_time_s=job.progress.get('computed_time_s', 0),
            last_sample_time_s=job.last_sample_time_s, sample_count=job.sample_count,
            latest_telemetry=job.latest_telemetry,
            requested_duration_s=job.scenario.duration_s,
            speed=job.speed, paused=job.paused or job.progress.get('paused', False),
            lease_expired=job.progress.get('lease_expired', False),
            pending_commands=0 if terminal else len(set(job.intents) - set(job.accepted)),
            unapplied_command_ids=sorted(set(job.intents) - set(job.accepted)) if terminal else [],
            next_sequence=next_sequence, latest_sequence=job.latest_sequence,
            first_sequence=first, gap=after_sequence < first - 1,
            samples=[dict(sequence=e['sequence'], row=e['value']) for e in selected if e['kind'] == 'sample'],
            command_acks=[dict(sequence=e['sequence'], command=e['value']) for e in selected if e['kind'] == 'command'],
            final_snapshot=job.final_snapshot, error=job.error,
        )

    def control(self, job, *, speed=None, paused=None, stop=None):
        if job.status not in ACTIVE:
            raise ValueError('LIVE session is no longer active')
        if speed is not None:
            if not 1 <= speed <= 1000:
                raise ValueError('LIVE speed must lie between 1 and 1000')
            job.speed = speed
        if paused is not None:
            job.paused = paused
            if not paused:
                job.resume_generation += 1
        if stop:
            job.stop = True
            job.status = 'stopping'
        job.lease_until = time.monotonic() + self.lease_s
        self._write_control(job)

    def command(self, job, intent):
        if job.status not in ACTIVE or job.stop:
            raise ValueError('LIVE session is not accepting commands')
        intent = intent if type(intent) is PointingIntent else PointingIntent.model_validate(intent)
        existing = job.intents.get(intent.command_id)
        if existing:
            if existing != intent:
                raise ValueError('command_id already identifies a different intent')
            return
        archived = job.scenario.pointing_commands or ()
        if intent.command_id in {command.command_id for command in archived}:
            raise ValueError('command_id already exists in the initial timeline')
        if len(job.intents) + len(archived) >= 128:
            raise ValueError('LIVE command timeline is limited to 128 commands')
        job.intents[intent.command_id] = intent
        self._write_control(job)

    def _drain(self, job):
        path = job.base / 'telemetry.jsonl'
        if not path.exists():
            return
        if path.stat().st_size > MAX_BYTES:
            raise ValueError('LIVE journal exceeds 64 MiB')
        with path.open('rb') as stream:
            stream.seek(job.journal_offset)
            read = 0
            while read < 2 * 1024 * 1024:
                line = stream.readline(1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 1024 * 1024:
                    raise ValueError('LIVE journal event exceeds 1 MiB')
                if not line.endswith(b'\n'):
                    break
                event = json.loads(line)
                if event['sequence'] != job.latest_sequence + 1 or event['kind'] not in ('sample', 'command'):
                    raise ValueError('LIVE journal sequence is invalid')
                job.events.append(event)
                job.latest_sequence = event['sequence']
                if event['kind'] == 'sample':
                    job.sample_count += 1
                    job.last_sample_time_s = event['value']['time_s']
                else:
                    job.accepted[event['value']['command_id']] = event['value']
                read += len(line)
                job.journal_offset = stream.tell()

    def _read_latest(self, job):
        path = job.base / 'latest-telemetry.json'
        if not path.exists():
            return
        stat = path.stat()
        if stat.st_size > 1024 * 1024:
            raise ValueError('LIVE latest telemetry exceeds 1 MiB')
        if stat.st_mtime_ns != job.latest_telemetry_stamp:
            job.latest_telemetry = json.loads(path.read_text())
            job.latest_telemetry_stamp = stat.st_mtime_ns

    async def _stop_process(self, job):
        if job.process and job.process.returncode is None:
            try:
                os.killpg(job.process.pid, signal.SIGTERM)
            except PermissionError:
                try:
                    job.process.terminate()
                except ProcessLookupError:
                    pass
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(job.process.wait(), 2)
            except TimeoutError:
                try:
                    os.killpg(job.process.pid, signal.SIGKILL)
                except PermissionError:
                    try:
                        job.process.kill()
                    except ProcessLookupError:
                        pass
                except ProcessLookupError:
                    pass
                await job.process.wait()

    async def cancel(self, live_id):
        job = self.get(live_id)
        if job and job.status in ACTIVE:
            job.status = 'cancelled'
            if job.task:
                job.task.cancel()
            if job.task:
                try:
                    await job.task
                except asyncio.CancelledError:
                    pass
            if job.directory:
                job.directory.cleanup()
                job.directory = None
                job.base = None
        return job

    def _finalize(self, job, result):
        final_scenario = MissionScenario.model_validate(result['manifest']['scenario'])
        before, after = job.scenario.model_dump(mode='json'), final_scenario.model_dump(mode='json')
        for key in ('pointing_commands', 'stop_time_s'):
            before.pop(key, None)
            after.pop(key, None)
        if before != after:
            raise ValueError('LIVE worker changed an immutable scenario input')
        identity, digest = final_scenario.identity()
        if (result['manifest']['scenario_id'], result['manifest']['scenario_hash']) != (identity, digest):
            raise ValueError('LIVE final input identity mismatch')
        run = dict(run_id=uuid.uuid4().hex, status='complete', scenario_id=identity,
                   scenario_hash=digest, result=result, error=None, progress=None)
        snapshot = dict(scenario=final_scenario.model_dump(mode='json'), run=run)
        encoded = export_archive(snapshot)
        return snapshot, encoded

    async def _execute(self, job):
        communication = None
        try:
            base = job.base
            spawning = asyncio.create_task(asyncio.create_subprocess_exec(
                sys.executable, '-m', 'cubesat_sim.live_mission_worker',
                str(base / 'scenario.json'), str(base / 'result.json'),
                str(base / 'progress.json'), str(base / 'control.json'), str(base / 'telemetry.jsonl'),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            ))
            try:
                job.process = await asyncio.shield(spawning)
            except asyncio.CancelledError:
                job.process = await spawning
                raise
            communication = asyncio.create_task(job.process.communicate())
            last_heartbeat = time.monotonic()
            last_stamp = None
            while not communication.done():
                self._drain(job)
                self._read_latest(job)
                path = base / 'progress.json'
                if path.exists():
                    stamp = path.stat().st_mtime_ns
                    if stamp != last_stamp:
                        job.progress = json.loads(path.read_text())
                        last_stamp = stamp
                        last_heartbeat = time.monotonic()
                        if not job.stop:
                            job.status = 'paused' if job.progress['paused'] else 'running'
                if time.monotonic() - last_heartbeat > self.heartbeat_timeout_s:
                    raise ValueError('LIVE worker stopped reporting progress')
                await asyncio.wait({communication}, timeout=0.05)
            _, stderr = await communication
            if job.status == 'cancelled':
                return
            while (base / 'telemetry.jsonl').exists() and job.journal_offset < (base / 'telemetry.jsonl').stat().st_size:
                before = job.journal_offset
                self._drain(job)
                if before == job.journal_offset:
                    raise ValueError('LIVE journal has an incomplete final event')
                await asyncio.sleep(0)
            if job.process.returncode:
                raise ValueError(stderr.decode(errors='replace')[-3000:])
            destination = base / 'result.json'
            if destination.stat().st_size > MAX_BYTES:
                raise ValueError('LIVE result exceeds 64 MiB')
            self._read_latest(job)
            result = await asyncio.to_thread(lambda: json.loads(destination.read_text()))
            job.final_snapshot, job.archive = await asyncio.to_thread(self._finalize, job, result)
            if (base / 'progress.json').exists():
                job.progress = json.loads((base / 'progress.json').read_text())
            job.status = 'complete'
        except asyncio.CancelledError:
            job.status = 'cancelled'
        except Exception as error:
            if job.status != 'cancelled':
                job.status = 'failed'
                job.error = str(error)[-3000:]
        finally:
            await self._stop_process(job)
            if communication and not communication.done():
                await communication
            job.process = None
            if job.directory:
                job.directory.cleanup()
                job.directory = None
                job.base = None

    async def close(self):
        for live_id in tuple(self.sessions):
            await self.cancel(live_id)
