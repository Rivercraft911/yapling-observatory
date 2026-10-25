import { Field } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import { MissionModeLoads } from './MissionModeLoads';
import { MissionRadioPower } from './MissionRadioPower';
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
  return (
    <>
      <MissionRadioPower config={config} edit={edit} />
      <MissionModeLoads config={config} edit={edit} />
      <details className="mission-details">
        <summary>CONOPS</summary>
        <MissionConopsControls config={config} edit={edit} />
      </details>
      <MissionBatteryControls config={config} edit={edit} />
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
