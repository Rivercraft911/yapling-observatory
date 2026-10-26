"""Manufacturer mechanical references and explicit preliminary wheel assumptions.

The reference catalogue does not supply a calibrated motor or loss curve. The
mission example uses a published RW1 rotor and an assumed torque envelope and
power allowance; none of these choices changes the standalone attitude example.
"""

from dataclasses import asdict, dataclass
import math

from .actuators import WheelSpec


@dataclass(frozen=True)
class WheelSource:
    title: str
    url: str
    revision: str
    locator: str
    sha256: str
    retrieved_utc_date: str = "2026-10-26"

    def __post_init__(self):
        if len(self.sha256) != 64 or any(
            c not in "0123456789abcdef" for c in self.sha256
        ):
            raise ValueError(
                "Wheel source SHA-256 must contain 64 lowercase hexadecimal characters"
            )


@dataclass(frozen=True)
class WheelReference:
    profile_id: str
    label: str
    spin_inertia_kg_m2: float
    inertia_status: str
    nominal_speed_rpm: float
    published_max_speed_rpm: float
    rated_momentum_nms: float
    reference_torque_nm: float
    torque_condition: str
    wheel_mass_kg: float
    mass_status: str
    dimensions_m: tuple[float, float, float]
    motor_supply_range_v: tuple[float, float]
    nominal_running_power_w: float
    peak_running_power_w: float
    power_scope: str
    sources: tuple[WheelSource, ...]
    limits: tuple[str, ...]

    def __post_init__(self):
        positive = (
            self.spin_inertia_kg_m2,
            self.nominal_speed_rpm,
            self.published_max_speed_rpm,
            self.rated_momentum_nms,
            self.reference_torque_nm,
            self.wheel_mass_kg,
            self.nominal_running_power_w,
            self.peak_running_power_w,
            *self.dimensions_m,
            *self.motor_supply_range_v,
        )
        if not all(math.isfinite(v) and v > 0 for v in positive):
            raise ValueError(
                "Wheel reference dimensions and ratings must be finite and positive"
            )
        if len(self.dimensions_m) != 3 or len(self.motor_supply_range_v) != 2:
            raise ValueError(
                "Wheel dimensions and supply range need three and two values"
            )
        if self.nominal_speed_rpm > self.published_max_speed_rpm:
            raise ValueError("Nominal wheel speed cannot exceed the published maximum")
        if self.motor_supply_range_v[0] > self.motor_supply_range_v[1]:
            raise ValueError("Wheel supply range must be ordered")
        if self.nominal_running_power_w > self.peak_running_power_w:
            raise ValueError("Nominal wheel power cannot exceed peak power")
        if abs(self.derived_nominal_momentum_nms / self.rated_momentum_nms - 1) > 0.01:
            raise ValueError(
                "Rotor inertia and nominal momentum disagree beyond source rounding"
            )
        if not self.sources or not self.limits:
            raise ValueError(
                "A wheel reference needs source evidence and applicability limits"
            )

    @property
    def derived_nominal_momentum_nms(self):
        return self.spin_inertia_kg_m2 * self.nominal_speed_rpm * 2 * math.pi / 60

    def record(self):
        return asdict(self) | {
            "derived_nominal_momentum_nms": self.derived_nominal_momentum_nms,
        }


_ASTROFEIN_WEB = WheelSource(
    "Astrofein RW1 manufacturer specification",
    "https://www.astrofein.com/reaktionsraeder/reaktionsrad-rw1/",
    "Undated product page, retrieved 26 October 2026 UTC",
    "RW1 table, Type A; power footnotes 1 and 2",
    "62aa7f25b7676bdcc3a48eb5f489c52d648091a0ed17a0b618bb95060b678eee",
)
_ASTROFEIN_FAMILY = WheelSource(
    "ASTROFEIN Reaction Wheel Family",
    "https://www.astrofein.com/wp-content/uploads/2023/04/ASTROFEIN-Reaction-Wheel-Family_20230425.pdf",
    "25 April 2023 filename; copyright 2023",
    "Page 1, CubeSat Line, RW1 Type A column",
    "201f3fc9cb4f88284d5fc7514e69057327e95fcf1dc925a2820e873ca811ea59",
)
_CUBESPACE_FLYER = WheelSource(
    "CubeSpace Reaction Wheels manufacturer flyer",
    "https://www.cubespace.co.za/uploads/a1f56e73-2f1b-46b7-9618-f3b62da35d33.pdf",
    "Undated two-page flyer, retrieved 26 October 2026 UTC",
    "Page 2, CW0017 column; page 1 platform statement",
    "ee61282695b2db57303aa8445db0024f050d7f3e6a7bb8b0b096dd185debb24b",
)

RW1_TYPE_A = WheelReference(
    profile_id="astrofein-rw1-type-a-reference-2026-10-26",
    label="Astrofein RW1 Type A mechanical reference",
    spin_inertia_kg_m2=694.5e-9,
    inertia_status="manufacturer_published_rotating_inertia",
    nominal_speed_rpm=8000.0,
    published_max_speed_rpm=16380.0,
    rated_momentum_nms=5.8e-4,
    reference_torque_nm=23e-6,
    torque_condition="Nominal torque, maximum commandable; no full torque-speed curve published here",
    wheel_mass_kg=0.024,
    mass_status="manufacturer_published_upper_bound_including_40_cm_cable",
    dimensions_m=(0.021, 0.021, 0.012),
    motor_supply_range_v=(5.0, 5.0),
    nominal_running_power_w=0.275,
    peak_running_power_w=0.375,
    power_scope="Strict upper limits per wheel, excluding shared WDE; about 25 degrees C in vacuum, based on one operating RW1",
    sources=(_ASTROFEIN_WEB, _ASTROFEIN_FAMILY),
    limits=(
        "Separate wheel drive electronics are required; published WDE mass is at most 45 g.",
        "Shared WDE standby limits are below 0.25, 0.35 and 0.50 W for one-, three- and four-wheel controllers respectively.",
        "The approximately 16380 rpm maximum is distinct from the 8000 rpm nominal operating reference.",
        "Published inertia predicts 0.581823 mN m s at 8000 rpm; the stated momentum is rounded to 0.58 mN m s.",
        "A compact wheel envelope does not establish spacecraft fit, harness clearance, lifetime or pointing performance.",
        "Motor torque constant, winding resistance, drive efficiency, friction and four-quadrant torque-speed behavior remain uncalibrated.",
    ),
)

CW0017 = WheelReference(
    profile_id="cubespace-cw0017-reference-2026-10-26",
    label="CubeSpace CW0017 mechanical reference",
    spin_inertia_kg_m2=1.77e-3 / (8000 * 2 * math.pi / 60),
    inertia_status="derived_from_published_rated_momentum_and_speed",
    nominal_speed_rpm=8000.0,
    published_max_speed_rpm=10000.0,
    rated_momentum_nms=1.77e-3,
    reference_torque_nm=0.23e-3,
    torque_condition="Published torque at rated momentum (8000 rpm), not a complete torque-speed envelope",
    wheel_mass_kg=0.060,
    mass_status="manufacturer_published_mass",
    dimensions_m=(0.028, 0.028, 0.026),
    motor_supply_range_v=(6.4, 16.8),
    nominal_running_power_w=0.300,
    peak_running_power_w=0.850,
    power_scope="Published at rated momentum; includes digital power. Peak is at nominal torque and excludes startup inrush",
    sources=(_CUBESPACE_FLYER,),
    limits=(
        "The manufacturer describes this wheel range as starting at 3U suitability; dimensions alone do not establish a 1U installation.",
        "Rotor inertia is inferred from H = J omega; it is not a published inertia measurement.",
        "Rated momentum at 8000 rpm is distinct from the 10000 rpm maximum-speed condition.",
        "Motor torque constant, winding resistance, efficiency, friction and the complete torque-speed curve are unknown.",
        "Earlier product revisions may use a different speed at rated momentum; this profile uses only the hashed flyer.",
    ),
)

_REFERENCES = (RW1_TYPE_A, CW0017)


def wheel_reference(profile_id: str) -> WheelReference:
    for reference in _REFERENCES:
        if reference.profile_id == profile_id:
            return reference
    raise ValueError(f"Unknown wheel reference: {profile_id}")


def wheel_profiles():
    """Return independent JSON-safe records without fabricating electrical fits."""
    return [reference.record() for reference in _REFERENCES]


@dataclass(frozen=True)
class WheelElectricalAssumptions:
    motor_torque_constant_nm_a: float
    winding_resistance_ohm: float
    non_ohmic_drive_efficiency: float
    idle_power_w: float
    max_bus_power_w: float | None
    regenerative_efficiency: float = 0.0
    viscous_friction_nm_s: float = 0.0


def wheel_spec_from_reference(
    profile_id: str,
    axis_body,
    *,
    operational_speed_rpm: float,
    constant_torque_until_rpm: float,
    electrical: WheelElectricalAssumptions,
) -> WheelSpec:
    """Map source mechanics using caller-supplied envelope and electrical choices."""
    reference = wheel_reference(profile_id)
    if operational_speed_rpm > reference.published_max_speed_rpm:
        raise ValueError("Operational speed exceeds the published wheel maximum")
    return WheelSpec(
        axis_body=axis_body,
        spin_inertia_kg_m2=reference.spin_inertia_kg_m2,
        max_speed_rpm=operational_speed_rpm,
        max_motor_torque_nm=reference.reference_torque_nm,
        constant_torque_until_rpm=constant_torque_until_rpm,
        **asdict(electrical),
    )


def _planning_power_allowance(powered_axis_count: int):
    if type(powered_axis_count) is not int or not 1 <= powered_axis_count <= 3:
        raise ValueError("The RW1 example supports one to three powered axes")
    # Retain the entire three-axis controller allowance when axes are disabled.
    share = 0.350 / powered_axis_count
    return (
        math.ceil((0.275 + share) * 100 - 1e-12) / 100,
        math.ceil((0.375 + share) * 100 - 1e-12) / 100,
    )


def mission_wheel_example(axis_body, *, powered_axis_count: int = 3) -> WheelSpec:
    """Editable RW1 mechanics with a conservative running-power allowance.

    Rebuild all powered axes when their count changes so that the shared WDE
    allowance remains included. This is not a calibrated idle or motor-loss fit.
    """
    floor, cap = _planning_power_allowance(powered_axis_count)
    return wheel_spec_from_reference(
        RW1_TYPE_A.profile_id,
        axis_body,
        operational_speed_rpm=8000.0,
        constant_torque_until_rpm=0.0,
        electrical=WheelElectricalAssumptions(
            motor_torque_constant_nm_a=0.005,
            winding_resistance_ohm=8.0,
            non_ohmic_drive_efficiency=0.8,
            idle_power_w=floor,
            max_bus_power_w=cap,
        ),
    )


def wheel_example_metadata(*, powered_axis_count: int = 3):
    """Describe the exact example parameters and separate evidence from choices."""
    parameters = asdict(
        mission_wheel_example((1.0, 0.0, 0.0), powered_axis_count=powered_axis_count)
    )
    parameters.pop("axis_body")
    return {
        "profile_id": RW1_TYPE_A.profile_id,
        "label": "RW1 Type A reference with assumed envelope and power allowance",
        "status": "editable_preliminary_planning_example",
        "reference": RW1_TYPE_A.record(),
        "sources": [asdict(source) for source in RW1_TYPE_A.sources],
        "powered_axis_count": powered_axis_count,
        "model_parameters": parameters,
        "power_allowance": {
            "status": "assumed_budget_from_manufacturer_upper_limits",
            "shared_wde_allowance_w": 0.350,
            "per_wheel_nominal_running_upper_w": 0.275,
            "per_wheel_peak_running_upper_w": 0.375,
            "rounding_w": 0.010,
            "rule": "Per axis: round upward to 0.01 W after adding 0.350 W / powered_axis_count to each per-wheel bound",
        },
        "assumptions": [
            "8000 rpm is the chosen operational cap; the higher published maximum is not used as routine available capacity.",
            "Motoring torque falls linearly from 23 microN m at rest to zero at the operational cap; braking retains the command limit. This is an assumed envelope, not a measured curve or guaranteed lower bound.",
            "The model idle_power_w field carries a conservative running-power allowance, not measured idle demand. It may overestimate low-speed and stationary consumption.",
            "The three-axis shared WDE allowance is split across powered axes. Rebuild or reapply this example when their count changes; do not retain one third when only one axis is powered.",
            "The nominal and peak per-wheel source limits are summed across axes as a planning assumption; source power conditions are about 25 degrees C in vacuum with one RW1 operating.",
            "Torque constant 0.005 N m/A, resistance 8 ohm and efficiency 0.8 are retained provisional drive parameters, not identified RW1 properties.",
            "Zero viscous friction and zero regenerative efficiency are assumptions. No bearing loss, startup inrush or temperature-dependent drive calibration is supplied.",
            "The power allowance already includes the shared WDE budget; do not add that controller again as a separate load.",
        ],
        "unknowns": [
            "Motor and controller loss maps versus torque, speed, bus voltage and temperature",
            "Rotor friction, startup/inrush, deadband, torque ripple and vibration",
            "As-built alignment, body inertia, installation, lifetime and controller tuning",
        ],
        "limits": list(RW1_TYPE_A.limits),
    }
