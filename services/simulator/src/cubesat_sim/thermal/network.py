"""Conservative lumped energy balance; implicit Euler with damped Newton solves.

NASA SmallSat Thermal Control (2026),7.1 Eq.1 supplies the external balance.
Pair exchange coefficients must come from a separately justified geometry/model.
"""

from collections.abc import Sequence
from dataclasses import dataclass
import math
from .models import ThermalNetwork, NodeForcing

SIGMA_W_M2_K4 = 5.670374419e-8


@dataclass(frozen=True)
class ThermalRates:
    net_heat_w: tuple[float, ...]
    absorbed_environment_w: tuple[float, ...]
    emitted_ir_w: tuple[float, ...]
    conductive_net_w: tuple[float, ...]
    mutual_radiation_net_w: tuple[float, ...]
    internal_heat_w: tuple[float, ...]


@dataclass(frozen=True)
class ThermalStep:
    temperatures_k: tuple[float, ...]
    absorbed_environment_j: float
    internal_heat_j: float
    emitted_ir_j: float
    thermal_storage_delta_j: float
    energy_residual_j: float
    substeps: int
    newton_iterations: int


def _inputs(network, temperatures_k, forcings):
    if len(temperatures_k) != len(network.nodes) or any(
        not math.isfinite(t) or t <= 0 for t in temperatures_k
    ):
        raise ValueError(
            "One finite positive Kelvin temperature is required per thermal node"
        )
    supplied = {forcing.node_id: forcing for forcing in forcings}
    ids = {node.node_id for node in network.nodes}
    if len(supplied) != len(forcings) or set(supplied) != ids:
        raise ValueError("Supply exactly one forcing record per thermal node")
    return tuple(supplied[node.node_id] for node in network.nodes)


def thermal_rates(network: ThermalNetwork, temperatures_k, forcings) -> ThermalRates:
    forces = _inputs(network, temperatures_k, forcings)
    index = {node.node_id: i for i, node in enumerate(network.nodes)}
    absorbed, emitted, internal = [], [], []
    for node, temperature, force in zip(network.nodes, temperatures_k, forces):
        absorbed.append(
            node.solar_absorptivity * (force.solar_incident_w + force.albedo_incident_w)
            + node.infrared_emissivity * force.earth_ir_incident_w
            + node.infrared_emissivity
            * SIGMA_W_M2_K4
            * node.radiating_area_m2
            * node.space_view_factor
            * network.space_temperature_k**4
        )
        emitted.append(
            node.infrared_emissivity
            * SIGMA_W_M2_K4
            * node.radiating_area_m2
            * temperature**4
        )
        internal.append(force.internal_heat_w)
    conduction = [0.0] * len(index)
    radiation = [0.0] * len(index)
    for link in network.conductive_links:
        i, j = index[link.first], index[link.second]
        transfer = link.conductance_w_k * (temperatures_k[j] - temperatures_k[i])
        conduction[i] += transfer
        conduction[j] -= transfer
    for link in network.radiative_links:
        i, j = index[link.first], index[link.second]
        transfer = link.exchange_coefficient_w_k4 * (
            temperatures_k[j] ** 4 - temperatures_k[i] ** 4
        )
        radiation[i] += transfer
        radiation[j] -= transfer
    net = tuple(
        a + q + c + r - e
        for a, q, c, r, e in zip(absorbed, internal, conduction, radiation, emitted)
    )
    if any(not math.isfinite(value) for value in (*net, *emitted)):
        raise ValueError(
            "Thermal power overflow: check capacities, forcing and temperatures"
        )
    return ThermalRates(
        net,
        tuple(absorbed),
        tuple(emitted),
        tuple(conduction),
        tuple(radiation),
        tuple(internal),
    )


def _solve_linear(matrix, rhs):
    rows = [list(row) + [value] for row, value in zip(matrix, rhs)]
    n = len(rows)
    for column in range(n):
        pivot = max(range(column, n), key=lambda row: abs(rows[row][column]))
        rows[column], rows[pivot] = rows[pivot], rows[column]
        if abs(rows[column][column]) < 1e-30:
            raise ValueError("Singular thermal Jacobian")
        for row in range(column + 1, n):
            ratio = rows[row][column] / rows[column][column]
            for k in range(column + 1, n + 1):
                rows[row][k] -= ratio * rows[column][k]
    result = [0.0] * n
    for row in range(n - 1, -1, -1):
        result[row] = (
            rows[row][n] - sum(rows[row][j] * result[j] for j in range(row + 1, n))
        ) / rows[row][row]
    return result


def _implicit_step(network, previous, forces, dt, tolerance_w):
    count = len(previous)
    index = {node.node_id: i for i, node in enumerate(network.nodes)}
    capacity = [node.heat_capacity_j_k for node in network.nodes]
    temperature = list(previous)

    def residual(values):
        rates = thermal_rates(network, values, forces)
        return [
            c * (new - old) / dt - q
            for c, new, old, q in zip(capacity, values, previous, rates.net_heat_w)
        ], rates

    for iteration in range(50):
        error, rates = residual(temperature)
        magnitude = max(abs(value) for value in error)
        # Resolving C*(Tnew-Told)/dt cannot beat floating-point Kelvin spacing.
        limits = [
            max(tolerance_w, 8 * math.ulp(value) * c / dt)
            for value, c in zip(temperature, capacity)
        ]
        if all(abs(value) <= limit for value, limit in zip(error, limits)):
            return tuple(temperature), rates, iteration
        jacobian = [[0.0] * count for _ in range(count)]
        for i, node in enumerate(network.nodes):
            jacobian[i][i] = (
                capacity[i] / dt
                + 4
                * node.infrared_emissivity
                * SIGMA_W_M2_K4
                * node.radiating_area_m2
                * temperature[i] ** 3
            )
        for link in network.conductive_links:
            i, j = index[link.first], index[link.second]
            for row, column in ((i, j), (j, i)):
                jacobian[row][row] += link.conductance_w_k
                jacobian[row][column] -= link.conductance_w_k
        for link in network.radiative_links:
            i, j = index[link.first], index[link.second]
            for row, column in ((i, j), (j, i)):
                jacobian[row][row] += (
                    4 * link.exchange_coefficient_w_k4 * temperature[row] ** 3
                )
                jacobian[row][column] -= (
                    4 * link.exchange_coefficient_w_k4 * temperature[column] ** 3
                )
        change = _solve_linear(jacobian, [-value for value in error])
        fraction = 1.0
        while fraction >= 2**-30:
            candidate = [
                value + fraction * delta for value, delta in zip(temperature, change)
            ]
            if min(candidate) > 0 and all(math.isfinite(value) for value in candidate):
                try:
                    trial, _ = residual(candidate)
                    if max(abs(value) for value in trial) < magnitude:
                        temperature = candidate
                        break
                except (OverflowError, ValueError):
                    pass
            fraction /= 2
        else:
            raise ValueError(
                "Thermal Newton solve stalled; reduce integration_step_s or check forcing"
            )
    raise ValueError("Thermal Newton iteration limit; reduce integration_step_s")


def advance_thermal(
    network: ThermalNetwork,
    temperatures_k: Sequence[float],
    forcings: Sequence[NodeForcing],
    duration_s: float,
    max_step_s: float = 1,
    tolerance_w: float = 1e-9,
) -> ThermalStep:
    forces = _inputs(network, temperatures_k, forcings)
    if (
        not all(math.isfinite(value) for value in (duration_s, max_step_s, tolerance_w))
        or duration_s < 0
        or max_step_s <= 0
        or tolerance_w <= 0
    ):
        raise ValueError(
            "Finite nonnegative duration and positive thermal step/tolerance required"
        )
    count = max(1, math.ceil(duration_s / max_step_s))
    if count > 100000:
        raise ValueError("Thermal call exceeds 100000 substeps")
    temperature = tuple(temperatures_k)
    absorbed = internal = emitted = 0.0
    iterations = 0
    if duration_s:
        dt = duration_s / count
        for _ in range(count):
            temperature, rates, used = _implicit_step(
                network, temperature, forces, dt, tolerance_w
            )
            absorbed += sum(rates.absorbed_environment_w) * dt
            internal += sum(rates.internal_heat_w) * dt
            emitted += sum(rates.emitted_ir_w) * dt
            iterations += used
    storage = sum(
        node.heat_capacity_j_k * (new - old)
        for node, new, old in zip(network.nodes, temperature, temperatures_k)
    )
    return ThermalStep(
        temperature,
        absorbed,
        internal,
        emitted,
        storage,
        absorbed + internal - emitted - storage,
        count if duration_s else 0,
        iterations,
    )
