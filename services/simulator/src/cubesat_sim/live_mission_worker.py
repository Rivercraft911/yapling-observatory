"""Wall pacing and bounded file transport around one continuous mission integrator."""
import json
import math
import os
from pathlib import Path
import sys
import time

from .mission_models import MissionScenario, PointingIntent, mission_execution_limits
from .mission.driver import run_mission
from .mission.runtime import RuntimeDirective
from .mission.numerics import NumericalStepIntent

MAX_JOURNAL_BYTES = 64 * 1024 * 1024


def atomic_json(path, value):
    temporary = path.with_suffix('.partial')
    temporary.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')))
    os.replace(temporary, path)


class FileRuntime:
    def __init__(self, control_path, progress_path, journal_path, cpu_limit_s, dynamics_step_s=1):
        self.control_path = control_path
        self.progress_path = progress_path
        self.latest_path = journal_path.with_name('latest-telemetry.json')
        self.telemetry_period_s = max(dynamics_step_s, math.ceil(1 / dynamics_step_s) * dynamics_step_s)
        self.last_control_stamp = None
        self.latest_row = None
        self.last_telemetry_publish = float("-inf")
        self.journal = journal_path.open('wb')
        self.cpu_limit_s = cpu_limit_s
        self.started = self.last_wall = time.monotonic()
        self.started_cpu = time.process_time()
        self.last_read = self.last_publish = 0.0
        self.speed = 1.0
        self.paused = False
        self.lease_expired = False
        self.lease_until = self.started
        self.resume_generation = -1
        self.stop = False
        self.commands = []
        self.numerical_steps = []
        self.issued_numerical = set()
        self.issued = set()
        self.sequence = 0
        self.computed_time_s = 0.0
        self.budget_s = 0.0
        self.refresh(force=True)

    def refresh(self, force=False):
        now = time.monotonic()
        if not self.paused and not self.lease_expired:
            self.budget_s += max(0.0, min(now, self.lease_until) - self.last_wall) * self.speed
        self.last_wall = now
        if force or now - self.last_read >= 0.03:
            stamp = self.control_path.stat().st_mtime_ns
            if force or stamp != self.last_control_stamp:
                control = json.loads(self.control_path.read_text())
                self.last_control_stamp = stamp
                if control['speed'] != self.speed or control['paused'] != self.paused:
                    self.budget_s = self.computed_time_s
                self.speed = control['speed']
                self.paused = control['paused']
                self.stop = control['stop']
                self.lease_until = control['lease_until']
                self.commands = control['commands']
                self.numerical_steps = control.get('numerical_steps', [])
                if control['resume_generation'] > self.resume_generation:
                    self.resume_generation = control['resume_generation']
                    self.lease_expired = False
            self.last_read = now
        if now >= self.lease_until:
            if not self.lease_expired:
                self.budget_s = self.computed_time_s
            self.lease_expired = True
        if time.process_time() - self.started_cpu > self.cpu_limit_s:
            raise ValueError('LIVE numerical CPU budget exceeded')

    def publish(self, state=None, force=False):
        now = time.monotonic()
        if not force and now - self.last_publish < 0.1:
            return
        atomic_json(self.progress_path, dict(
            state=state or ('paused' if self.paused or self.lease_expired else 'running'),
            computed_time_s=self.computed_time_s,
            speed=self.speed,
            paused=self.paused or self.lease_expired,
            lease_expired=self.lease_expired,
            worker_elapsed_s=now - self.started,
            cpu_elapsed_s=time.process_time() - self.started_cpu,
            latest_sequence=self.sequence,
        ))
        self.last_publish = now

    def before_step(self, time_s, controller_boundary):
        self.computed_time_s = time_s
        while True:
            self.refresh()
            if self.stop:
                self.publish('stopping', force=True)
                return RuntimeDirective(stop=True)
            self.publish()
            if not self.paused and not self.lease_expired and time_s <= self.budget_s:
                break
            time.sleep(0.05)
        if controller_boundary:
            pending = tuple(PointingIntent.model_validate(value) for value in self.commands
                            if value['command_id'] not in self.issued)
            self.issued.update(command.command_id for command in pending)
            numerical = tuple(NumericalStepIntent.model_validate(value) for value in self.numerical_steps
                              if value['command_id'] not in self.issued_numerical)
            self.issued_numerical.update(command.command_id for command in numerical)
            if pending or numerical:
                return RuntimeDirective(commands=pending, numerical_steps=numerical)
        return None

    def emit(self, kind, value):
        self.sequence += 1
        line = (json.dumps(dict(sequence=self.sequence, kind=kind, value=value),
                           allow_nan=False, separators=(',', ':')) + '\n').encode()
        if len(line) > 1024 * 1024 or self.journal.tell() + len(line) > MAX_JOURNAL_BYTES:
            raise ValueError('LIVE telemetry exceeds the bounded 64 MiB journal')
        self.journal.write(line)
        self.journal.flush()

    def on_command(self, command):
        self.emit('command', command)

    def on_numerical_step(self, command):
        self.emit('numerical_step', command)
        self.publish(force=True)

    def on_numerical_step_rejected(self, error):
        self.emit('numerical_step_rejection', error)
        self.publish(force=True)

    def on_telemetry(self, row):
        self.computed_time_s = row['time_s']
        self.latest_row = row
        self.write_latest(row)

    def write_latest(self, row, force=False):
        now = time.monotonic()
        if not force and now - self.last_telemetry_publish < 0.15:
            return
        encoded = json.dumps(row, allow_nan=False, separators=(',', ':')).encode()
        if len(encoded) > 1024 * 1024:
            raise ValueError('LIVE latest telemetry exceeds 1 MiB')
        temporary = self.latest_path.with_suffix('.partial')
        temporary.write_bytes(encoded)
        os.replace(temporary, self.latest_path)
        self.last_telemetry_publish = now

    def on_sample(self, row):
        self.on_telemetry(row)
        self.computed_time_s = row['time_s']
        self.emit('sample', row)
        self.publish()

    def close(self):
        self.journal.close()


def main():
    source, destination, progress_path, control_path, journal_path = map(Path, sys.argv[1:6])
    config = MissionScenario.model_validate_json(source.read_text())
    limits = mission_execution_limits(config)
    runtime = FileRuntime(control_path, progress_path, journal_path, limits['worker_wall_limit_s'],
                          config.clocks.dynamics_step_s)
    try:
        result = run_mission(config, runtime=runtime)
        if runtime.latest_row is not None:
            runtime.write_latest(runtime.latest_row, force=True)
        encoded = json.dumps(result, allow_nan=False, separators=(',', ':')).encode()
        if len(encoded) > MAX_JOURNAL_BYTES:
            raise ValueError('LIVE result exceeds the bounded 64 MiB result size')
        temporary = destination.with_suffix('.partial')
        temporary.write_bytes(encoded)
        os.replace(temporary, destination)
        runtime.publish('finished', force=True)
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
