import { Field } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import { MissionModeLoads } from './MissionModeLoads';
import { MissionRadioPower } from './MissionRadioPower';
import { MissionUhfControls } from './MissionUhfControls';
import { MissionConopsControls } from './MissionConopsControls';
import { MissionBatteryControls } from './MissionBatteryControls';

export function MissionPowerControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const power = config.power;
  const commonEfficiency =
    power.panels.length &&
    power.panels.every((panel) => panel.efficiency === power.panels[0].efficiency)
      ? power.panels[0].efficiency * 100
      : null;
  return (
    <>
      <fieldset>
        <legend>SOLAR ARRAYS</legend>
        <Field
          label="Cell efficiency · all arrays"
          unit="%"
          value={commonEfficiency}
          min={0}
          max={Math.min(1, ...power.panels.map((panel) => panel.solar_absorptivity)) * 100}
          step={0.1}
          onChange={(value) =>
            edit((draft) => {
              for (const panel of draft.power.panels) panel.efficiency = value / 100;
            })
          }
        />
      </fieldset>
      <MissionRadioPower config={config} edit={edit} />
      <details className="mission-details">
        <summary>UHF beacon</summary>
        <MissionUhfControls config={config} edit={edit} />
      </details>
      <MissionModeLoads config={config} edit={edit} />
      <details className="mission-details">
        <summary>CONOPS</summary>
        <MissionConopsControls config={config} edit={edit} />
      </details>
      <MissionBatteryControls config={config} edit={edit} />
      <details className="mission-details">
        <summary>Individual arrays</summary>
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
