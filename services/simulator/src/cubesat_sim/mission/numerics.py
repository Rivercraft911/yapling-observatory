"""Recorded piecewise fixed steps; no adaptive accuracy or wall-speed policy."""
import math

from pydantic import BaseModel, ConfigDict, Field, model_validator

SUPPORTED_STEPS_S = (0.25, 0.5, 1.0, 2.0)


class NumericalStepIntent(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)
    command_id: str = Field(min_length=1, max_length=128, strict=True)
    dynamics_step_s: float = Field(strict=True)

    @model_validator(mode="after")
    def supported_step(self):
        if self.dynamics_step_s not in SUPPORTED_STEPS_S:
            raise ValueError("Numerical step must be 0.25, 0.5, 1 or 2 seconds")
        return self


class NumericalStepCommand(NumericalStepIntent):
    effective_time_s: float = Field(ge=0, strict=True)


def on_grid(time_s, step_s):
    return abs(time_s / step_s - round(time_s / step_s)) <= 1e-8


def step_at(config, time_s):
    step = config.clocks.dynamics_step_s
    for command in config.numerical_step_commands or ():
        if command.effective_time_s > time_s:
            break
        step = command.dynamics_step_s
    return step


def step_segments(config, end_s=None):
    end = config.duration_s if end_s is None else end_s
    start, step = 0.0, config.clocks.dynamics_step_s
    segments = []
    for command in config.numerical_step_commands or ():
        time = command.effective_time_s
        if time >= end:
            break
        if time > start:
            segments.append(dict(start_s=start, end_s=time, dynamics_step_s=step))
        start, step = time, command.dynamics_step_s
    if end > start:
        segments.append(dict(start_s=start, end_s=end, dynamics_step_s=step))
    return segments


def planned_dynamics_ticks(config, end_s=None):
    return sum(round((s["end_s"] - s["start_s"]) / s["dynamics_step_s"])
               for s in step_segments(config, end_s))


def validate_step_choice(config, step_s, effective_time_s):
    if step_s not in SUPPORTED_STEPS_S:
        raise ValueError("Numerical step must be 0.25, 0.5, 1 or 2 seconds")
    schedule = config.schedule
    slots = ((schedule.slot_duration_s,) if schedule.uplink_duration_s is None else
             (schedule.uplink_duration_s, schedule.downlink_duration_s))
    boundaries = (
        ("controller period", config.clocks.controller_period_s),
        ("thermal period", config.clocks.thermal_step_s),
        ("output period", config.clocks.output_step_s),
        ("mission horizon", config.duration_s),
        ("accepted change time", effective_time_s),
        *(("S-band slot", value) for value in slots),
        *(("CONOPS edge", value) for window in config.conops.windows
          for value in (window.start_s, window.end_s)),
    )
    for label, value in boundaries:
        if not on_grid(value, step_s):
            raise ValueError(f"{step_s:g} s does not divide the {label} ({value:g} s)")


def validate_numerical_timeline(config):
    commands = config.numerical_step_commands or ()
    if len({command.command_id for command in commands}) != len(commands):
        raise ValueError("Numerical step command IDs must be unique")
    previous = -1.0
    canonical = []
    for command in commands:
        time = command.effective_time_s
        if (time < previous or time >= config.duration_s
                or not on_grid(time, config.clocks.controller_period_s)):
            raise ValueError("Numerical changes must be ordered controller boundaries before the horizon")
        time = round(time / config.clocks.controller_period_s) * config.clocks.controller_period_s
        validate_step_choice(config, command.dynamics_step_s, time)
        canonical.append(command.model_copy(update=dict(effective_time_s=time)))
        previous = time
    if config.numerical_step_commands is not None:
        object.__setattr__(config, "numerical_step_commands", tuple(canonical))
    for segment in step_segments(config):
        if not on_grid(segment["end_s"] - segment["start_s"], segment["dynamics_step_s"]):
            raise ValueError("Numerical step segments must contain whole integration steps")
    ticks = planned_dynamics_ticks(config)
    extended = config.duration_s > 604800
    if ticks > (3_000_000 if extended else 1_000_000):
        raise ValueError("Recorded numerical steps exceed the dynamics tick budget")
    if ticks * config.clocks.orbit_substeps > (6_000_000 if extended else 2_000_000):
        raise ValueError("Recorded numerical steps exceed the orbit substep budget")
    if config.stop_time_s is not None and not on_grid(config.stop_time_s, step_at(config, config.stop_time_s)):
        raise ValueError("Stop time must lie on the recorded numerical grid")


def rejection_reason(error):
    details = getattr(error, "errors", None)
    return (details()[0]["msg"].removeprefix("Value error, ")
            if callable(details) else str(error))[:2000]


def numerical_step_options(config, time_s):
    boundary = math.ceil(time_s / config.clocks.controller_period_s) * config.clocks.controller_period_s
    options = []
    for step in SUPPORTED_STEPS_S:
        reason = None
        try:
            validate_step_choice(config, step, boundary)
            if boundary >= config.duration_s:
                raise ValueError("Mission horizon reached")
            existing = config.numerical_step_commands or ()
            identifiers = {command.command_id for command in existing}
            option_id = next(f"numerical-option-{i}" for i in range(129) if f"numerical-option-{i}" not in identifiers)
            command = NumericalStepCommand(command_id=option_id, effective_time_s=boundary, dynamics_step_s=step)
            commands = tuple(sorted((*existing, command), key=lambda item: item.effective_time_s))
            # Validation is pure and includes the complete remaining work budget.
            config.__class__.model_validate(config.model_dump(mode="json") | dict(
                numerical_step_commands=[c.model_dump(mode="json") for c in commands]
            ))
        except ValueError as error:
            reason = rejection_reason(error)
        options.append(dict(dynamics_step_s=step, allowed=reason is None, reason=reason))
    return options
