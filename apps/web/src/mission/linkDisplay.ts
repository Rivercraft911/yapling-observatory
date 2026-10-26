import type { Direction, Samples } from '../types';

export function visibleLinkMargins(samples: Samples, direction: Direction) {
  return samples[direction].margin_db.map((value, index) =>
    samples.visible?.[index] === true ? value : null,
  );
}

export function linkDisplayState(samples: Samples | undefined, index: number) {
  if (!samples) return 'NO RUN';
  if (samples.visible?.[index] === false) return 'BELOW MASK';
  if (samples.visible?.[index] !== true) return 'GEOMETRY UNAVAILABLE';
  if (samples.radio_active?.[index] === false) return 'RADIO IDLE';
  const direction = samples.active_direction[index];
  const margin = direction ? samples[direction]?.margin_db[index] : null;
  if (margin == null) return 'RF UNRESOLVED';
  return margin < 0 ? 'BELOW THRESHOLD' : 'IDEAL LINK';
}
