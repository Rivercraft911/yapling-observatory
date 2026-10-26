import type { Direction, Radio, RunSnapshot, Variant } from '../types';

export interface RunProbe {
  spacecraft_position_m: number[];
  station_position_m: number[];
  q_body_from_inertial_wxyz: number[];
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finiteVector = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every(Number.isFinite);

/** Run references come from archived numerical inputs, never the editable scenario. */
export function runAntennaReference(snapshot: RunSnapshot | null, direction: Direction) {
  const result = snapshot?.run.result;
  if (!result) return { request: null, reason: 'Run a mission to inspect its antenna.' };
  const archived = object(result.manifest.scenario);
  const link = object(archived?.[direction]);
  const variant = archived?.antenna_variant;
  const power = object(archived?.power);
  const semantics = power?.analytical_efficiency_semantics;
  if (semantics != null && semantics !== 'pattern_times_additional_v1')
    return { request: null, reason: 'Archived antenna efficiency revision unavailable.' };
  const additional = power?.transmit_radiation_efficiency;
  if (
    semantics === 'pattern_times_additional_v1' &&
    (typeof additional !== 'number' ||
      !Number.isFinite(additional) ||
      additional < 0 ||
      additional > 1)
  )
    return { request: null, reason: 'Archived antenna efficiency unavailable.' };
  if (
    !link ||
    !['patch', 'wire', 'spherical_harmonic'].includes(String(link.spacecraft_antenna)) ||
    !['dipole', 'turnstile', 'v45'].includes(String(variant))
  )
    return { request: null, reason: 'Archived antenna inputs unavailable.' };
  return {
    request: {
      link: link as unknown as Radio,
      antenna_variant: variant as Variant,
      ...(semantics === 'pattern_times_additional_v1'
        ? {
            direction,
            analytical_efficiency_semantics: semantics,
            analytical_radiation_efficiency: additional as number,
          }
        : {}),
    },
    reason: null,
  };
}

/** Select already-returned common-frame geometry; rotation is performed by Python. */
export function runLineOfSight(snapshot: RunSnapshot | null, index: number) {
  const result = snapshot?.run.result;
  const frames = object(result?.manifest.frames);
  const supportedFrame =
    (frames?.inertial === 'FIXED_EPOCH_MEAN_EQUATOR_EQUINOX_APPROX' &&
      frames.quaternion === 'Hamilton scalarfirst q_B_from_I') ||
    (typeof frames?.inertial === 'string' &&
      frames.inertial.startsWith('ANALYTIC_INERTIAL:') &&
      frames.quaternion ===
        'scalar-first Hamilton q_body_from_inertial: q [0,v_I] conjugate(q) = [0,v_B]');
  const samples = result?.samples;
  if (!samples || !supportedFrame)
    return { probe: null, reason: 'Run LOS unavailable: undeclared or unsupported frames.' };
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= samples.time_s.length ||
    !Number.isFinite(samples.time_s[index])
  )
    return { probe: null, reason: 'Run LOS unavailable at this sample.' };
  const spacecraft = samples.satellite_position_m?.[index];
  const station = samples.station_position_m?.[index];
  const quaternion = samples.q_body_from_inertial_wxyz?.[index];
  if (
    !finiteVector(spacecraft, 3) ||
    !finiteVector(station, 3) ||
    !finiteVector(quaternion, 4) ||
    quaternion.every((value) => value === 0) ||
    spacecraft.every((value, axis) => value === station[axis])
  )
    return { probe: null, reason: 'Run LOS unavailable: incomplete sampled geometry.' };
  return {
    probe: {
      spacecraft_position_m: spacecraft,
      station_position_m: station,
      q_body_from_inertial_wxyz: quaternion,
    } satisfies RunProbe,
    reason: null,
  };
}

export function runGroundLinkLabel(
  snapshot: RunSnapshot | null,
  direction: Direction,
  index: number,
) {
  const samples = snapshot?.run.result?.samples;
  if (samples?.visible?.[index] === false) return 'Below station mask · geometric LOS';
  if (samples?.visible?.[index] !== true) return 'Ground visibility unavailable';
  if (samples.radio_active?.[index] === false) return 'Radio idle · geometric LOS';
  if (samples.active_direction?.[index] !== direction)
    return `${direction === 'uplink' ? 'UL' : 'DL'} not scheduled · geometric LOS`;
  return 'Ground visible · scheduled direction';
}
