import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';

export function MissionRadioSchedule({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const schedule = config.schedule;
  const tx = schedule.downlink_duration_s ?? schedule.slot_duration_s;
  const rx = schedule.uplink_duration_s ?? schedule.slot_duration_s;
  return (
    <fieldset>
      <legend>TX / RX CYCLE</legend>
      <Field
        label="TX window"
        unit="s"
        value={tx}
        min={1}
        max={3600}
        step={config.clocks.dynamics_step_s}
        onChange={(value) =>
          edit((draft) => {
            draft.schedule.downlink_duration_s = value;
            draft.schedule.uplink_duration_s = rx;
          })
        }
      />
      <Field
        label="RX window"
        unit="s"
        value={rx}
        min={1}
        max={3600}
        step={config.clocks.dynamics_step_s}
        onChange={(value) =>
          edit((draft) => {
            draft.schedule.uplink_duration_s = value;
            draft.schedule.downlink_duration_s = tx;
          })
        }
      />
      <Select
        label="First window"
        value={schedule.first_direction}
        options={[
          { value: 'downlink', label: 'TX · downlink' },
          { value: 'uplink', label: 'RX · uplink' },
        ]}
        onChange={(value) =>
          edit((draft) => {
            draft.schedule.first_direction = value as 'uplink' | 'downlink';
          })
        }
      />
    </fieldset>
  );
}
