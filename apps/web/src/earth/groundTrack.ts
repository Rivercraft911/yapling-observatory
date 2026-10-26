import type { Direction, Samples } from '../types';
import {
  contactStateAtSample,
  type ContactMarginSource,
  type ContactState,
  type ContactVisibility,
} from '../mission/contactState';
import { ecefToDisplay, WGS84_B_OVER_A, type Vec3 } from './geodesy';

export interface GroundTrackPoint {
  index: number;
  timeS: number;
  position: Vec3;
  direction: Direction | null;
  visibility: ContactVisibility;
  state: ContactState;
  marginDb: number | null;
  marginSource: ContactMarginSource;
  elevationDeg: number | null;
  rangeM: number | null;
}

export interface GroundTrackSegment {
  start: GroundTrackPoint;
  end: GroundTrackPoint;
  state: ContactState | 'transition';
  visibility: ContactVisibility;
}

export interface GroundTrackContact {
  id: number;
  start: GroundTrackPoint;
  end: GroundTrackPoint;
  startClipped: boolean;
  endClipped: boolean;
}

export interface GroundTrackMarker {
  kind: 'aos' | 'los' | 'closest' | 'highest';
  point: GroundTrackPoint;
  contactId: number;
  bracketStartS?: number;
  bracketEndS?: number;
}

export interface GroundTrackOptions {
  cursorTimeS: number;
  windowSeconds?: number;
  availableThroughTimeS?: number;
  /** Explicit display continuity bound. No cadence is inferred from mixed live/archive rows. */
  maxGapS?: number;
  maxMarkers?: number;
}

export interface GroundTrackData {
  projection: 'radial-wgs84-display';
  points: GroundTrackPoint[];
  segments: GroundTrackSegment[];
  contacts: GroundTrackContact[];
  candidateMarkers: GroundTrackMarker[];
  markers: GroundTrackMarker[];
  windowStartS: number;
  windowEndS: number;
  omittedMarkerCount: number;
}

/** Radial ellipsoid intersection for drawing, not a geodetic nadir or an RF calculation. */
export function projectGroundTrackPosition(
  positionEcefM: readonly number[] | null | undefined,
): Vec3 | null {
  if (positionEcefM?.length !== 3 || !positionEcefM.every(Number.isFinite)) return null;
  const position = ecefToDisplay(positionEcefM);
  const radius = Math.hypot(position[0], position[1] / WGS84_B_OVER_A, position[2]);
  if (radius < 1 - 1e-12 || !Number.isFinite(radius)) return null;
  return [position[0] / radius, position[1] / radius, position[2] / radius];
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function contiguous(a: GroundTrackPoint, b: GroundTrackPoint, maxGapS: number) {
  return b.index === a.index + 1 && b.timeS > a.timeS && b.timeS - a.timeS <= maxGapS;
}

export function groundTrackWindowBounds(
  times: readonly number[],
  cursorTimeS: number,
  requestedWindowSeconds = 10800,
  requestedAvailableThroughTimeS?: number,
) {
  cursorTimeS = Number.isFinite(cursorTimeS) ? cursorTimeS : 0;
  const windowSeconds =
    requestedWindowSeconds === Infinity
      ? Infinity
      : Number.isFinite(requestedWindowSeconds) && requestedWindowSeconds > 0
        ? requestedWindowSeconds
        : 10800;
  let firstTimeS = Infinity,
    lastTimeS = -Infinity;
  for (const timeS of times) {
    if (!Number.isFinite(timeS)) continue;
    firstTimeS = Math.min(firstTimeS, timeS);
    lastTimeS = Math.max(lastTimeS, timeS);
  }
  if (!Number.isFinite(firstTimeS)) firstTimeS = lastTimeS = cursorTimeS;
  const availableThroughTimeS = Number.isFinite(requestedAvailableThroughTimeS)
    ? Math.min(lastTimeS, requestedAvailableThroughTimeS!)
    : lastTimeS;
  const windowStartS = Math.max(firstTimeS, cursorTimeS - windowSeconds / 2);
  const windowEndS = Math.min(availableThroughTimeS, cursorTimeS + windowSeconds / 2);
  let startIndex = -1,
    endIndex = -1;
  times.forEach((timeS, index) => {
    if (!Number.isFinite(timeS) || timeS < windowStartS || timeS > windowEndS) return;
    if (startIndex < 0) startIndex = index;
    endIndex = index;
  });
  return { startIndex, endIndex, windowStartS, windowEndS, availableThroughTimeS };
}

export function selectGroundTrackMarkers(
  candidateMarkers: readonly GroundTrackMarker[],
  cursorTimeS: number,
  requestedMaxMarkers = 64,
) {
  cursorTimeS = Number.isFinite(cursorTimeS) ? cursorTimeS : 0;
  const maxMarkers = Number.isFinite(requestedMaxMarkers)
    ? Math.max(0, Math.floor(requestedMaxMarkers))
    : 64;
  const markers = [...candidateMarkers]
    .sort(
      (a, b) =>
        Math.abs(a.point.timeS - cursorTimeS) - Math.abs(b.point.timeS - cursorTimeS) ||
        a.point.index - b.point.index ||
        a.kind.localeCompare(b.kind),
    )
    .slice(0, maxMarkers)
    .sort((a, b) => a.point.index - b.point.index || a.kind.localeCompare(b.kind));
  return { markers, omittedMarkerCount: candidateMarkers.length - markers.length };
}

/** Selects returned samples only. Window clipping never creates contact transitions. */
export function buildGroundTrack(samples: Samples, options: GroundTrackOptions): GroundTrackData {
  const { windowStartS, windowEndS, availableThroughTimeS } = groundTrackWindowBounds(
    samples.time_s,
    options.cursorTimeS,
    options.windowSeconds,
    options.availableThroughTimeS,
  );
  const maxGapS =
    Number.isFinite(options.maxGapS) && (options.maxGapS ?? 0) > 0 ? options.maxGapS! : Infinity;
  const allPoints: (GroundTrackPoint | null)[] = samples.time_s.map((timeS, index) => {
    if (!Number.isFinite(timeS) || timeS > availableThroughTimeS) return null;
    const positionEcefM = samples.satellite_position_ecef_m[index];
    const position = positionEcefM && projectGroundTrackPosition(positionEcefM);
    if (!position) return null;
    return {
      index,
      timeS,
      position,
      ...contactStateAtSample(samples, index),
      elevationDeg: finiteOrNull(samples.elevation_deg?.[index]),
      rangeM: finiteOrNull(samples.range_m?.[index]),
    };
  });
  const inWindow = (point: GroundTrackPoint) =>
    point.timeS >= windowStartS && point.timeS <= windowEndS;
  const points = allPoints.filter(
    (point): point is GroundTrackPoint => point !== null && inWindow(point),
  );
  const segments: GroundTrackSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1],
      end = points[i];
    if (!contiguous(start, end, maxGapS)) continue;
    const visibility =
      start.visibility === 'unknown' || end.visibility === 'unknown'
        ? 'unknown'
        : start.visibility === 'below-mask' || end.visibility === 'below-mask'
          ? 'below-mask'
          : 'visible';
    const state =
      visibility === 'unknown'
        ? 'geometry-unavailable'
        : visibility === 'below-mask'
          ? 'below-mask'
          : start.state === end.state
            ? start.state
            : 'transition';
    segments.push({ start, end, state, visibility });
  }

  const contacts: GroundTrackContact[] = [];
  const allMarkers: GroundTrackMarker[] = [];
  let contactId = 0;
  for (let i = 0; i < allPoints.length; i++) {
    const start = allPoints[i];
    if (start?.visibility !== 'visible') continue;
    const firstIndex = i;
    let end = start;
    let closest = start.rangeM === null ? null : start;
    let highest = start;
    while (i + 1 < allPoints.length) {
      const next = allPoints[i + 1];
      if (!next || next.visibility !== 'visible' || !contiguous(end, next, maxGapS)) break;
      end = next;
      if (next.rangeM !== null && (closest === null || next.rangeM < closest.rangeM!))
        closest = next;
      if (next.elevationDeg! > highest.elevationDeg!) highest = next;
      i++;
    }
    const previous = allPoints[firstIndex - 1];
    const next = allPoints[i + 1];
    const startBounded =
      previous?.visibility === 'below-mask' && contiguous(previous, start, maxGapS);
    const endBounded = next?.visibility === 'below-mask' && contiguous(end, next, maxGapS);
    const visiblePoints = allPoints
      .slice(firstIndex, i + 1)
      .filter((point): point is GroundTrackPoint => point !== null && inWindow(point));
    const id = contactId++;
    if (!visiblePoints.length) continue;
    contacts.push({
      id,
      start: visiblePoints[0],
      end: visiblePoints[visiblePoints.length - 1],
      startClipped: !startBounded || !inWindow(start) || !inWindow(previous!),
      endClipped: !endBounded || !inWindow(end) || !inWindow(next!),
    });
    if (startBounded && inWindow(previous!) && inWindow(start))
      allMarkers.push({
        kind: 'aos',
        point: start,
        contactId: id,
        bracketStartS: previous!.timeS,
        bracketEndS: start.timeS,
      });
    if (endBounded && inWindow(end) && inWindow(next!))
      allMarkers.push({
        kind: 'los',
        point: end,
        contactId: id,
        bracketStartS: end.timeS,
        bracketEndS: next!.timeS,
      });
    if (closest && inWindow(closest))
      allMarkers.push({ kind: 'closest', point: closest, contactId: id });
    if (inWindow(highest)) allMarkers.push({ kind: 'highest', point: highest, contactId: id });
  }
  const { markers, omittedMarkerCount } = selectGroundTrackMarkers(
    allMarkers,
    options.cursorTimeS,
    options.maxMarkers,
  );
  return {
    projection: 'radial-wgs84-display',
    points,
    segments,
    contacts,
    candidateMarkers: allMarkers,
    markers,
    windowStartS,
    windowEndS,
    omittedMarkerCount,
  };
}
