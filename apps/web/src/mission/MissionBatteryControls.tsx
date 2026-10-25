import { useEffect, useState } from 'react';
import { api, cloneScenario } from '../api';
import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import type { BatteryElectricalConfig } from '../systems/powerTypes';

type BatteryTemplate = {
  electrical: BatteryElectricalConfig;
  metadata: { label?: string; limits?: string[]; [key: string]: unknown };
};

export function MissionBatteryControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const battery = config.power.battery;
  const electrical = battery.electrical;
  const [template, setTemplate] = useState<BatteryTemplate | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    api<BatteryTemplate>('/api/mission/battery-electrical-default', { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setTemplate(value);
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);
  const compatible = battery.cells?.cell_model === 'NCR18650GA';
  return (
    <details className="mission-details">
      <summary>Battery</summary>
      <Select
        label="Electrical model"
        value={electrical ? 'ncr18650ga_linghu2019_rint' : 'energy_only'}
        options={[
          { value: 'energy_only', label: 'Energy storage only' },
          {
            value: 'ncr18650ga_linghu2019_rint',
            label: template?.metadata.label || 'NCR18650GA · 25°C DC reference',
            disabled: !compatible || (!template && !electrical),
          },
        ]}
        onChange={(value) =>
          edit((d) => {
            if (value === 'energy_only') delete d.power.battery.electrical;
            else if (template) d.power.battery.electrical = cloneScenario(template.electrical);
          })
        }
      />
      {electrical ? (
        <>
          <Field
            label="Initial charge"
            unit="% SOC"
            value={electrical.initial_soc * 100}
            min={0}
            max={100}
            step={5}
            onChange={(v) =>
              edit((d) => {
                d.power.battery.electrical!.initial_soc = v / 100;
              })
            }
          />
          <Field
            label="Resistance scale"
            unit="×"
            value={electrical.resistance_scale}
            min={0.1}
            max={100}
            step={0.1}
            onChange={(v) =>
              edit((d) => {
                d.power.battery.electrical!.resistance_scale = v;
              })
            }
          />
        </>
      ) : (
        <Field
          label="Initial energy"
          unit="%"
          value={battery.initial_energy_fraction * 100}
          min={0}
          max={100}
          step={5}
          onChange={(v) =>
            edit((d) => {
              d.power.battery.initial_energy_fraction = v / 100;
            })
          }
        />
      )}
      {battery.cells ? (
        <>
          <span className="eyebrow">
            {battery.cells.cell_model} · {battery.cells.series_count}S{battery.cells.parallel_count}
            P
          </span>
          <Field
            label="Cell capacity"
            unit="mAh"
            value={battery.cells.cell_capacity_mah}
            min={1}
            max={20000}
            step={50}
            onChange={(v) =>
              edit((d) => {
                d.power.battery.cells!.cell_capacity_mah = v;
              })
            }
          />
          <Field
            label="Series cells"
            unit="S"
            value={battery.cells.series_count}
            min={1}
            max={1000}
            step={1}
            onChange={(v) => {
              if (Number.isInteger(v))
                edit((d) => {
                  d.power.battery.cells!.series_count = v;
                });
            }}
          />
          <Field
            label="Parallel cells"
            unit="P"
            value={battery.cells.parallel_count}
            min={1}
            max={1000}
            step={1}
            onChange={(v) => {
              if (Number.isInteger(v))
                edit((d) => {
                  d.power.battery.cells!.parallel_count = v;
                });
            }}
          />
        </>
      ) : (
        <Field
          label="Capacity"
          unit="Wh"
          value={battery.total_capacity_wh}
          min={0.1}
          max={10000}
          step={1}
          onChange={(v) =>
            edit((d) => {
              d.power.battery.total_capacity_wh = v;
            })
          }
        />
      )}
      <Field
        label="Bus charge cap"
        unit="W"
        value={battery.max_charge_bus_w}
        min={0}
        max={10000}
        step={0.5}
        onChange={(v) =>
          edit((d) => {
            d.power.battery.max_charge_bus_w = v;
          })
        }
      />
      <Field
        label="Bus discharge cap"
        unit="W"
        value={battery.max_discharge_bus_w}
        min={0}
        max={10000}
        step={0.5}
        onChange={(v) =>
          edit((d) => {
            d.power.battery.max_discharge_bus_w = v;
          })
        }
      />
      {electrical ? (
        <>
          <details className="mission-details">
            <summary>Cell operating limits</summary>
            <Field
              label="Cell minimum voltage"
              unit="V"
              value={electrical.cell_min_voltage_v}
              min={2.5}
              max={Math.min(4.178, electrical.cell_max_voltage_v - 0.001)}
              step={0.05}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.cell_min_voltage_v = v;
                })
              }
            />
            <Field
              label="Cell maximum voltage"
              unit="V"
              value={electrical.cell_max_voltage_v}
              min={Math.max(3, electrical.cell_min_voltage_v + 0.001)}
              max={4.2}
              step={0.05}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.cell_max_voltage_v = v;
                })
              }
            />
            <Field
              label="Cell charge limit"
              unit="A"
              value={electrical.cell_max_charge_current_a}
              min={0}
              max={1.675}
              step={0.1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.cell_max_charge_current_a = v;
                })
              }
            />
            <Field
              label="Cell discharge limit"
              unit="A"
              value={electrical.cell_max_discharge_current_a}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.cell_max_discharge_current_a = v;
                })
              }
            />
            <Field
              label="Charge minimum T"
              unit="°C"
              value={electrical.charge_temperature_min_k - 273.15}
              min={10}
              max={electrical.charge_temperature_max_k - 273.15}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.charge_temperature_min_k = v + 273.15;
                })
              }
            />
            <Field
              label="Charge maximum T"
              unit="°C"
              value={electrical.charge_temperature_max_k - 273.15}
              min={electrical.charge_temperature_min_k - 273.15}
              max={45}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.charge_temperature_max_k = v + 273.15;
                })
              }
            />
            <Field
              label="Discharge minimum T"
              unit="°C"
              value={electrical.discharge_temperature_min_k - 273.15}
              min={-20}
              max={electrical.discharge_temperature_max_k - 273.15}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.discharge_temperature_min_k = v + 273.15;
                })
              }
            />
            <Field
              label="Discharge maximum T"
              unit="°C"
              value={electrical.discharge_temperature_max_k - 273.15}
              min={electrical.discharge_temperature_min_k - 273.15}
              max={60}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.electrical!.discharge_temperature_max_k = v + 273.15;
                })
              }
            />
          </details>
          <details className="mission-details">
            <summary>Battery model limits & evidence</summary>
            <small>
              25°C DC reference. Identical, balanced cells; static OCV and resistance. No dynamic
              polarization or calibrated temperature dependence.
            </small>
            {template?.metadata.limits?.map((limit, index) => (
              <small key={index}>{limit}</small>
            ))}
            {template && (
              <pre className="mission-model-metadata">
                {JSON.stringify(template.metadata, null, 2)}
              </pre>
            )}
          </details>
        </>
      ) : (
        <small>V/I require an electrical model.</small>
      )}
    </details>
  );
}
