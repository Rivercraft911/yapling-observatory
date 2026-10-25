import { useState } from 'react';
import { Field } from '../controls/RadioControls';
import type { MissionConfig, MissionMode } from './missionTypes';

const modes: { mode: MissionMode; label: string }[] = [
  { mode: 'sun_pointing', label: 'Sun' },
  { mode: 'ground_tracking', label: 'Ground pass' },
  { mode: 'imaging', label: 'Imaging' },
  { mode: 'detumble', label: 'Detumble' },
];

export function MissionModeLoads({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const [mode, setMode] = useState<MissionMode>('sun_pointing');
  const profile = config.power.mode_loads.find((item) => item.mode === mode);
  return (
    <fieldset>
      <legend>
        AVIONICS LOADS <span>W electrical</span>
      </legend>
      <nav className="mission-mode-selector" aria-label="Mission load mode">
        {modes.map((choice) => (
          <button
            key={choice.mode}
            aria-pressed={mode === choice.mode}
            onClick={() => setMode(choice.mode)}
          >
            {choice.label}
          </button>
        ))}
      </nav>
      {profile?.loads.map((load) => (
        <Field
          key={load.component_id}
          label={load.component_id}
          unit="W"
          value={load.electrical_w}
          min={0}
          max={1000}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              const target = d.power.mode_loads
                .find((item) => item.mode === mode)
                ?.loads.find((item) => item.component_id === load.component_id);
              if (target) target.electrical_w = v;
            })
          }
        />
      ))}
      {!profile?.loads.length && (
        <small className="profile-evidence">No configured loads for this mode.</small>
      )}
    </fieldset>
  );
}
