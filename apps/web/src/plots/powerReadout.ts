import type { RunSnapshot } from '../types';

export function finiteValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function powerReadout(snapshot: RunSnapshot | null, index: number) {
  const result = snapshot?.run.result;
  const power = result?.samples.power;
  const energy = result?.summary.energy_j as Record<string, unknown> | undefined;
  return {
    solar: finiteValue(power?.potential_bus_w?.[index]),
    draw: finiteValue(power?.requested_load_w?.[index]),
    net: finiteValue(power?.net_bus_w?.[index]),
    soc: finiteValue(power?.battery_soc?.[index]),
    usedSolarJ: finiteValue(energy?.generated_bus_j),
    loadJ: finiteValue(energy?.requested_load_j),
    storedDeltaJ: finiteValue(energy?.chemical_storage_delta_j),
  };
}
