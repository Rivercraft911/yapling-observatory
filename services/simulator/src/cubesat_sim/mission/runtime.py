"""Optional I/O hooks around one continuous mission integrator.

Pacing and queue transport belong to callers. These hooks cannot replace state or inject computed telemetry.
Explicit numerical changes are bounded, recorded controller-boundary commands. Commands are validated intents;
the numerical driver stamps their accepted controller-boundary time.
"""

from dataclasses import dataclass
from typing import Protocol

from ..mission_models import PointingIntent
from .numerics import NumericalStepIntent


@dataclass(frozen=True)
class RuntimeDirective:
    commands: tuple[PointingIntent, ...] = ()
    stop: bool = False
    numerical_steps: tuple[NumericalStepIntent, ...] = ()

    def __post_init__(self):
        if type(self.stop) is not bool:
            raise ValueError("Runtime stop must be Boolean")
        object.__setattr__(self, "numerical_steps", tuple(
            intent if type(intent) is NumericalStepIntent else NumericalStepIntent.model_validate(intent)
            for intent in self.numerical_steps
        ))
        object.__setattr__(self, "commands", tuple(
            intent if isinstance(intent, PointingIntent) and type(intent) is PointingIntent
            else PointingIntent.model_validate(intent)
            for intent in self.commands
        ))


class MissionRuntime(Protocol):
    """Optional telemetry_period_s/on_telemetry add transient real-state rows.

    Their cadence is independent of archived output and never flushes thermal
    integration. A final flush can replace the same-time held telemetry row.
    The original on_sample callback receives only archived rows.
    """
    def before_step(self, time_s: float, controller_boundary: bool) -> RuntimeDirective | None:
        """Called before an unintegrated tick; stop wins over the same batch."""
        ...

    def on_command(self, command: dict) -> None:
        """Accepted command acknowledgment, copied and stamped by the core."""
        ...

    def on_sample(self, row: dict) -> None:
        """A copied physical sample row, separate from a completed Run result."""
        ...

    def on_numerical_step(self, command: dict) -> None:
        """Copied accepted numerical command, stamped by the core."""
        ...

    def on_numerical_step_rejected(self, error: dict) -> None:
        """Optional rejection callback; no configuration/state mutation occurred."""
        ...
