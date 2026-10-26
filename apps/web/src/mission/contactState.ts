import type { Direction, Samples } from '../types';

export type ContactVisibility = 'visible' | 'below-mask' | 'unknown';
export type ContactState =
  | 'uplink'
  | 'downlink'
  | 'below-threshold'
  | 'rf-unresolved'
  | 'radio-idle'
  | 'radio-unknown'
  | 'below-mask'
  | 'geometry-unavailable';
export type ContactMarginSource = 'selected-mode' | 'reference-profile' | 'unavailable';

export interface ContactSampleState {
  visibility: ContactVisibility;
  state: ContactState;
  direction: Direction | null;
  marginDb: number | null;
  marginSource: ContactMarginSource;
}

/** Returned threshold opportunity only; this does not establish lock or frame delivery. */
export function contactStateAtSample(samples: Samples, index: number): ContactSampleState {
  const direction = samples.active_direction?.[index];
  const knownDirection = direction === 'uplink' || direction === 'downlink' ? direction : null;
  const elevation = samples.elevation_deg?.[index];
  const visibility =
    samples.visible?.[index] === false
      ? 'below-mask'
      : samples.visible?.[index] === true &&
          typeof elevation === 'number' &&
          Number.isFinite(elevation) &&
          elevation >= 0
        ? 'visible'
        : 'unknown';
  const receiver = knownDirection ? samples.radio_delivery?.[knownDirection] : undefined;
  const marginSource: ContactMarginSource =
    receiver && 'selected_margin_db' in receiver
      ? 'selected-mode'
      : samples.radio_delivery !== undefined || !knownDirection
        ? 'unavailable'
        : 'reference-profile';
  const rawMargin =
    marginSource === 'selected-mode'
      ? receiver?.selected_margin_db?.[index]
      : marginSource === 'reference-profile' && knownDirection
        ? samples[knownDirection]?.margin_db?.[index]
        : null;
  const marginDb = typeof rawMargin === 'number' && Number.isFinite(rawMargin) ? rawMargin : null;
  const state: ContactState =
    visibility === 'below-mask'
      ? 'below-mask'
      : visibility === 'unknown'
        ? 'geometry-unavailable'
        : samples.radio_active?.[index] === false
          ? 'radio-idle'
          : samples.radio_active?.[index] !== true || !knownDirection
            ? 'radio-unknown'
            : marginDb === null
              ? 'rf-unresolved'
              : marginDb < 0
                ? 'below-threshold'
                : knownDirection;
  return { visibility, state, direction: knownDirection, marginDb, marginSource };
}
