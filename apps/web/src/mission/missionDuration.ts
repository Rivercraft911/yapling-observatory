import type { MissionConfig } from './missionTypes';

export function setMissionDuration(config: MissionConfig, durationSeconds: number) {
  config.duration_s = durationSeconds;
  const preferredOutput = durationSeconds > 7 * 86400 ? 180 : durationSeconds > 86400 ? 120 : 30;
  const thermalStep = config.clocks.thermal_step_s;
  const intervals = Math.round(durationSeconds / thermalStep);
  const desiredOutput = Math.max(
    config.clocks.output_step_s,
    preferredOutput,
    durationSeconds / 20000,
  );
  // Output boundaries must coincide with thermal states and the mission endpoint.
  if (
    !Number.isSafeInteger(intervals) ||
    intervals < 1 ||
    Math.abs(durationSeconds / thermalStep - intervals) > 1e-8
  )
    return;
  const minimum = Math.ceil(Math.min(desiredOutput, durationSeconds) / thermalStep);
  let stride = intervals;
  for (let divisor = 1; divisor * divisor <= intervals; divisor++) {
    if (intervals % divisor) continue;
    for (const candidate of [divisor, intervals / divisor]) {
      if (candidate >= minimum && candidate < stride) stride = candidate;
    }
  }
  config.clocks.output_step_s = stride * thermalStep;
}
