import type { RunSnapshot } from '../types';
import type { MissionSnapshot } from './missionTypes';

export function missionDisplaySnapshot(snapshot: MissionSnapshot | null): RunSnapshot | null {
  if (!snapshot) return null;
  const input = snapshot.scenario;
  return {
    run: snapshot.run,
    scenario: {
      name: input.name,
      epoch_utc: input.orbit.elements.epoch_utc,
      duration_s: input.duration_s,
      step_s: input.clocks.output_step_s,
      station: input.station,
      antenna_variant: input.antenna_variant,
      uplink: input.uplink,
      downlink: input.downlink,
      schedule: input.schedule,
      provenance: input.provenance,
    },
  };
}
