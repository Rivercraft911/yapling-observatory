import type { Direction, Samples } from '../types';
import { contactStateAtSample } from './contactState.ts';

export function visibleLinkMargins(samples: Samples, direction: Direction) {
  return samples[direction].margin_db.map((value, index) =>
    samples.visible?.[index] === true ? value : null,
  );
}

export function linkDisplayState(samples: Samples | undefined, index: number) {
  if (!samples) return 'NO RUN';
  const { state } = contactStateAtSample(samples, index);
  switch (state) {
    case 'uplink':
    case 'downlink':
      return 'RF OPPORTUNITY';
    case 'below-mask':
      return 'BELOW MASK';
    case 'geometry-unavailable':
      return 'GEOMETRY UNAVAILABLE';
    case 'radio-idle':
      return 'RADIO IDLE';
    case 'radio-unknown':
      return 'RADIO UNRESOLVED';
    case 'below-threshold':
      return 'BELOW THRESHOLD';
    default:
      return 'RF UNRESOLVED';
  }
}
