"""Explicit provisional mission presets; SSO is a starting estimate, not a constraint."""

from dataclasses import replace
import json
from pathlib import Path
from ..models import default_scenario
from ..power.study import default_study_config, stage_templates
from ..power.profiles import PLANNING_TRANSMITTER
from ..orbit.elements import (
    OrbitElements,
    first_order_sso_inclination_deg,
    raan_from_ltan_deg,
    ltan_from_raan_hours,
)
from ..orbit.gravity import (
    GravityPotential,
    EGM2008_MU_M3_S2,
    EGM2008_REFERENCE_RADIUS_M,
    EGM2008_J2,
)
from ..attitude.kinematics import boresight_reference
from ..mission_models import MissionScenario
from ..attitude.study import default_attitude_study
from .ephemeris import mean_sun_ra_deg, sun_direction_inertial


def orbit_preset(
    epoch_utc="2026-10-25T00:00:00Z",
    ltan_hours=18.0,
    semi_major_axis_m=6928137.0,
    eccentricity=0.0,
):
    gravity = GravityPotential(EGM2008_MU_M3_S2, EGM2008_REFERENCE_RADIUS_M, EGM2008_J2)
    inclination = first_order_sso_inclination_deg(
        semi_major_axis_m, eccentricity, 360 / 365.2422, gravity
    )
    if inclination is None:
        raise ValueError("No first-order SSO inclination exists for these inputs")
    return dict(
        elements=dict(
            semi_major_axis_m=semi_major_axis_m,
            eccentricity=eccentricity,
            inclination_deg=inclination,
            raan_deg=raan_from_ltan_deg(ltan_hours, mean_sun_ra_deg(epoch_utc)),
            argument_of_periapsis_deg=0.0,
            true_anomaly_deg=0.0,
            epoch_utc=epoch_utc,
        ),
        preset="first_order_mean_J2_terminator_estimate",
        ltan_hours_at_epoch=ltan_hours,
    )


def orbit_with_ltan(elements: OrbitElements, ltan_hours):
    return replace(
        elements,
        raan_deg=raan_from_ltan_deg(ltan_hours, mean_sun_ra_deg(elements.epoch_utc)),
    )


def orbit_metadata(elements: OrbitElements):
    return dict(
        ltan_hours=ltan_from_raan_hours(
            elements.raan_deg, mean_sun_ra_deg(elements.epoch_utc)
        ),
        solar_time_convention="local_mean_solar_time_at_ascending_node",
        element_kind="osculating_initial",
        epoch_utc=elements.epoch_utc,
    )


def default_mission_scenario():
    legacy = default_scenario()
    example = default_study_config()
    geometry = json.loads(Path(__file__).with_name("solar_geometry.json").read_text())
    panels = []
    surfaces = []
    for array in geometry["arrays"]:
        normal = tuple(array["normal_body"])
        area = array["covered_cell_area_m2"]
        panels.append(
            dict(
                panel_id=array["id"],
                thermal_node_id="panel",
                active_area_m2=area,
                normal_body=normal,
                solar_absorptivity=0.9,
                efficiency=0.29,
            )
        )
        sides = (
            (("_front", 1), ("_rear", -1))
            if array["kind"] != "fixed"
            else (("_front", 1),)
        )
        surfaces.extend(
            [
                dict(
                    surface_id=array["id"] + suffix,
                    thermal_node_id="panel",
                    area_m2=area,
                    normal_body=tuple(sign * v for v in normal),
                )
                for suffix, sign in sides
            ]
        )
    for i, normal in enumerate(
        ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
    ):
        surfaces.append(
            dict(
                surface_id="uncovered_bus_" + str(i),
                thermal_node_id="bus",
                area_m2=0.04 / 6,
                normal_body=normal,
            )
        )
    thermal = example.thermal.model_dump(mode="json")
    thermal["nodes"][0]["radiating_area_m2"] = sum(
        s["area_m2"] for s in surfaces if s["thermal_node_id"] == "panel"
    )
    profiles = []
    for mode, preset in stage_templates().items():
        profiles.append(
            dict(
                mode=mode,
                loads=[
                    l
                    for l in preset["loads"]
                    if l["component_id"] not in ("radio", "magnetorquers")
                ],
            )
        )
    tx = PLANNING_TRANSMITTER
    epoch = "2026-10-25T00:00:00Z"
    return MissionScenario.model_validate(
        dict(
            orbit=orbit_preset(epoch),
            uplink=legacy.uplink.model_dump(mode="json"),
            downlink=legacy.downlink.model_dump(mode="json")
            | dict(tx_power_w=tx.pa_output_w, tx_feed_loss_db=tx.feed_loss_db),
            spacecraft=dict(
                **actuator_presets()["wheels_and_magnetic"],
                initial_q_body_from_inertial_wxyz=boresight_reference(
                    (1, 0, 0, 0), (0, 1, 0), sun_direction_inertial(epoch)
                ),
            ),
            power=dict(
                panels=panels,
                battery=example.battery.model_dump(mode="json"),
                thermal=thermal,
                surfaces=surfaces,
                mode_loads=profiles,
                spacecraft_tx_electrical_w=tx.electrical_w,
                transmit_radiation_efficiency=tx.radiation_efficiency,
            ),
            provenance=[
                example.provenance[0],
                example.provenance[1],
                "PV29% is userproposed and relative to coveredfootprint here. Thermalcapacities,externaloptics,contacts,EPS efficiency/powerlimits,uncoveredbusarea .04m2, initialconditions andmodeprofiles are provisional examples,not flightproperties.",
                tx.source
                + " Ground-uplink transmitter watts do not heat the spacecraft.",
                "Storagechain loss is assigned tobus,not fabricatedcellI2R/entropic heat. Batterytemperature is a lumpedconduction prediction with no cell-loss or temperature-dependent capacity physics.",
                "Sun,hard spherical eclipse,anduniformEarth albedo/IR use the shared propagatedorbit/attitude. No cloudshader,geographicweather or selfshadow. Exterior bodycellfronts only; deployablepetal fronts+backs use the same provisional nodeoptics.",
                *[
                    f"{e.path}: {e.status}; {e.source}; {e.conditions}"
                    for e in legacy.provenance
                    if e.path.startswith(
                        ("uplink", "downlink", "station", "schedule", "antenna_variant")
                    )
                    and e.path
                    not in {"downlink.tx_power_w", "downlink.tx_feed_loss_db"}
                ],
                "Provisional18cell covered-footprint geometry from conceptv03, source recordSHA256 bdf89fe69fd1a63378394387393dba70d9e1cf52295ccb0f0f14071751326af5. This is not manufacturer active area.29% is an assumed efficiency relative to COVERED footprint; no hidden packing factor.",
                "All array faces are modeled at fixed exported5/8deg cant. No selfshadow, deployment dynamics, rearPVgeneration or temperature-dependent efficiency.",
                "Initial mass1.5kg and locked diagonal inertia.002kgm2 remain independent provisional inputs. Removing actuators does not subtract guessed mass/inertia.",
                "Bundled wheel-assisted PD uses three provisional example wheels plus an enabled total-norm0.2Am2 MTQ. Magnetic wheel unloading is optional and disabled by default; when enabled with wheel PD, its zero aggregate absolute-rotor-momentum reference is projected perpendicular to B and compensated by the wheels. This does not guarantee individual desaturation or pointing. Quadratic MTQ electrical coefficient is0.75W atfullnorm,not selectedcoil/drive evidence.",
                "Earth optical albedo.3 and outgoingIR237W/m2 are uniform global example constants, not local weather. Thermal surface optics/capacities/contacts remain provisional.",
            ],
        )
    )


def actuator_presets():
    wheels = [
        dict(enabled=True, spec=wheel.__dict__)
        for wheel in default_attitude_study().body.wheels
    ]
    return {
        "magnetic_only": dict(
            wheels=[],
            magnetorquer=dict(
                enabled=True,
                spec=dict(max_dipole_am2=0.2),
                full_axis_power_w=[0.75, 0.75, 0.75],
                power_model="quadratic_dipole_example",
                thermal_node_id="bus",
            ),
        ),
        "wheels_and_magnetic": dict(
            wheels=wheels,
            magnetorquer=dict(
                enabled=True,
                spec=dict(max_dipole_am2=0.2),
                full_axis_power_w=[0.75, 0.75, 0.75],
                power_model="quadratic_dipole_example",
                thermal_node_id="bus",
            ),
        ),
    }
