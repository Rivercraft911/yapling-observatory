import { useState } from 'react';
import { Field, Select } from '../controls/RadioControls';
import { modeNames, type MissionConfig, type MissionMode } from './missionTypes';

export function MissionPowerControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const [mode, setMode] = useState<MissionMode>('sun_pointing');
  const power = config.power;
  return (
    <>
      <fieldset>
        <legend>POWER</legend>
        <Field
          label="TX input"
          unit="W"
          value={power.spacecraft_tx_electrical_w}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.power.spacecraft_tx_electrical_w = v;
            })
          }
        />
        <Field
          label="RX"
          unit="W"
          value={power.spacecraft_receive_w}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.power.spacecraft_receive_w = v;
            })
          }
        />
        <Field
          label="Radio idle"
          unit="W"
          value={power.radio_idle_w}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.power.radio_idle_w = v;
            })
          }
        />
        <Select
          label="Mode"
          value={mode}
          options={Object.entries(modeNames).map(([value, label]) => ({ value, label }))}
          onChange={(v) => setMode(v as MissionMode)}
        />
        {power.mode_loads
          .find((p) => p.mode === mode)
          ?.loads.map((load) => (
            <Field
              key={load.component_id}
              label={load.component_id}
              unit="W"
              value={load.electrical_w}
              min={0}
              max={100}
              step={0.1}
              onChange={(v) =>
                edit((d) => {
                  d.power.mode_loads
                    .find((p) => p.mode === mode)!
                    .loads.find((l) => l.component_id === load.component_id)!.electrical_w = v;
                })
              }
            />
          ))}
      </fieldset>
      <details className="mission-details">
        <summary>Battery</summary>
        <Field
          label="Initial energy"
          unit="%"
          value={power.battery.initial_energy_fraction * 100}
          min={0}
          max={100}
          step={5}
          onChange={(v) =>
            edit((d) => {
              d.power.battery.initial_energy_fraction = v / 100;
            })
          }
        />
        {power.battery.cells ? (
          <>
            <span className="eyebrow">
              {power.battery.cells.cell_model} · {power.battery.cells.series_count}S
              {power.battery.cells.parallel_count}P
            </span>
            <Field
              label="Cell capacity"
              unit="mAh"
              value={power.battery.cells.cell_capacity_mah}
              min={1}
              max={20000}
              step={50}
              onChange={(v) =>
                edit((d) => {
                  d.power.battery.cells!.cell_capacity_mah = v;
                })
              }
            />
          </>
        ) : (
          <Field
            label="Capacity"
            unit="Wh"
            value={power.battery.total_capacity_wh}
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
        <small>Energy storage model. Terminal voltage and cell current are unresolved.</small>
      </details>
      <details className="mission-details">
        <summary>Solar arrays</summary>
        {power.panels.map((panel, index) => (
          <fieldset key={panel.panel_id}>
            <legend>{panel.panel_id}</legend>
            <label className="spacecraft-follow">
              <input
                type="checkbox"
                checked={panel.enabled}
                onChange={(e) =>
                  edit((d) => {
                    d.power.panels[index].enabled = e.target.checked;
                  })
                }
              />
              Generating
            </label>
            <Field
              label="η"
              unit="%"
              value={panel.efficiency * 100}
              min={0}
              max={100}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.power.panels[index].efficiency = v / 100;
                })
              }
            />
            <small>{(panel.active_area_m2 * 1e4).toFixed(1)} cm² · covered footprint</small>
          </fieldset>
        ))}
      </details>
    </>
  );
}
