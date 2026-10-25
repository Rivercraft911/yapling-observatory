import { Field, Select } from '../controls/RadioControls';
import { modeNames, type MissionConfig, type MissionMode } from './missionTypes';

export function MissionConopsControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  return (
    <>
      <fieldset>
        <legend>OPERATIONS</legend>
        <Select
          label="Between passes"
          value={config.conops.default_mode}
          options={[
            { value: 'sun_pointing', label: 'Sun pointing' },
            { value: 'detumble', label: 'Detumble' },
          ]}
          onChange={(v) =>
            edit((d) => {
              d.conops.default_mode = v as 'sun_pointing' | 'detumble';
            })
          }
        />
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={config.conops.auto_ground_tracking}
            onChange={(e) =>
              edit((d) => {
                d.conops.auto_ground_tracking = e.target.checked;
              })
            }
          />
          Track ground passes
        </label>
      </fieldset>
      {config.conops.windows.map((window, index) => (
        <fieldset key={window.window_id}>
          <legend>
            WINDOW {index + 1}
            <button
              className="text-button"
              aria-label={`Remove window ${index + 1}`}
              onClick={() =>
                edit((d) => {
                  d.conops.windows.splice(index, 1);
                })
              }
            >
              ×
            </button>
          </legend>
          <Select
            label="Mode"
            value={window.mode}
            options={Object.entries(modeNames).map(([value, label]) => ({ value, label }))}
            onChange={(v) =>
              edit((d) => {
                d.conops.windows[index].mode = v as MissionMode;
              })
            }
          />
          <Field
            label="Start"
            unit="s"
            value={window.start_s}
            min={0}
            max={config.duration_s}
            step={30}
            onChange={(v) =>
              edit((d) => {
                d.conops.windows[index].start_s = v;
              })
            }
          />
          <Field
            label="End"
            unit="s"
            value={window.end_s}
            min={0}
            max={config.duration_s}
            step={30}
            onChange={(v) =>
              edit((d) => {
                d.conops.windows[index].end_s = v;
              })
            }
          />
          {(window.mode === 'imaging' || window.mode === 'ground_tracking') && (
            <>
              <Field
                label="φ target"
                unit="deg"
                value={window.target_latitude_deg ?? config.station.latitude_deg}
                min={-90}
                max={90}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    const w = d.conops.windows[index];
                    w.target_latitude_deg = v;
                    w.target_longitude_deg ??= d.station.longitude_deg;
                  })
                }
              />
              <Field
                label="λ target"
                unit="deg"
                value={window.target_longitude_deg ?? config.station.longitude_deg}
                min={-180}
                max={180}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    const w = d.conops.windows[index];
                    w.target_longitude_deg = v;
                    w.target_latitude_deg ??= d.station.latitude_deg;
                  })
                }
              />
            </>
          )}
        </fieldset>
      ))}
      <button
        className="apply-assembly"
        onClick={() =>
          edit((d) => {
            const start = d.conops.windows.at(-1)?.end_s || 0;
            d.conops.windows.push({
              window_id: `manual-${Date.now()}`,
              mode: 'imaging',
              start_s: start,
              end_s: Math.min(d.duration_s, start + 300),
              target_latitude_deg: d.station.latitude_deg,
              target_longitude_deg: d.station.longitude_deg,
            });
          })
        }
        disabled={(config.conops.windows.at(-1)?.end_s || 0) >= config.duration_s}
      >
        + Target window
      </button>
    </>
  );
}
