import type { GroundTrackData } from './groundTrack';
import { projectGroundTrackPosition } from './groundTrack';
import { WGS84_B_OVER_A } from './geodesy';

export const FLAT_MAP_WIDTH = 1440;
export const FLAT_MAP_HEIGHT = 720;
export interface MapPoint {
  x: number;
  y: number;
}
export interface GeographicPoint {
  latitude_deg: number;
  longitude_deg: number;
}
export interface GroundCoverageContour {
  mode_id: string;
  label: string;
  modulation: string;
  code_rate: string;
  symbol_rate_sps: number | null;
  threshold_esn0_db: number | null;
  threshold_status: string;
  threshold_source: string;
  engineering_reserve_db: number | null;
  threshold_includes_reserve: boolean;
  status: 'coverage' | 'no_coverage' | 'unresolved';
  limit: string;
  max_slant_range_m: number | null;
  boundary: GeographicPoint[];
}
export interface GroundCoverageResponse {
  schema_version: string;
  model: string;
  scenario_sha256: string;
  display_projection: 'radial_wgs84_surface_geodetic';
  direction: 'uplink' | 'downlink';
  altitude_m: number;
  altitude_source: 'explicit_geodetic_height' | 'nominal_orbit_planning_height';
  station: GeographicPoint & { height_m: number; minimum_elevation_deg: number };
  mode_source: 'configured_receiver' | 'ideal_normal_psk_catalogue';
  assumptions: string[];
  rf: {
    frequency_hz: number;
    tx_power_w: number;
    tx_feed_loss_db: number;
    ground_gain_dbi: number;
    spacecraft_gain_dbi: number | null;
    extra_path_loss_db: number;
    polarization_loss_db: number;
    noise_density_dbw_hz: number;
  };
  contours: GroundCoverageContour[];
}
export interface FlatMapView {
  center: MapPoint;
  zoom: number;
}
export interface FlatMapSize {
  width: number;
  height: number;
}
export interface FlatMapViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  unitsPerPixel: number;
}
export const WORLD_MAP_VIEW: FlatMapView = {
  center: { x: FLAT_MAP_WIDTH / 2, y: FLAT_MAP_HEIGHT / 2 },
  zoom: 1,
};
const DEGREES = 180 / Math.PI;
const wrapX = (x: number) => ((x % FLAT_MAP_WIDTH) + FLAT_MAP_WIDTH) % FLAT_MAP_WIDTH;

/** Equirectangular cartography only. No returned orbit or RF state is changed. */
export function geographicToMap(point: GeographicPoint | null | undefined): MapPoint | null {
  if (
    !point ||
    !Number.isFinite(point.longitude_deg) ||
    !Number.isFinite(point.latitude_deg) ||
    Math.abs(point.latitude_deg) > 90
  )
    return null;
  let longitude = ((((point.longitude_deg + 180) % 360) + 360) % 360) - 180;
  if (longitude === -180 && point.longitude_deg > 0) longitude = 180;
  return { x: ((longitude + 180) / 360) * FLAT_MAP_WIDTH, y: (90 - point.latitude_deg) * 4 };
}

/** Normal latitude of the existing radial ellipsoid display point, not a new nadir model. */
export function displayGroundPointToMap(position: readonly number[] | null | undefined) {
  if (position?.length !== 3 || !position.every(Number.isFinite)) return null;
  const [x, y, z] = position;
  if (Math.hypot(x, y, z) < 1e-12) return null;
  return geographicToMap({
    longitude_deg: Math.atan2(-z, x) * DEGREES,
    latitude_deg: Math.atan2(y, Math.hypot(x, z) * WGS84_B_OVER_A ** 2) * DEGREES,
  });
}

export function ecefToFlatMap(position: readonly number[] | null | undefined) {
  return displayGroundPointToMap(projectGroundTrackPosition(position));
}

const validMapPoint = (point: MapPoint | null): point is MapPoint =>
  point !== null &&
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  point.x >= 0 &&
  point.x <= FLAT_MAP_WIDTH &&
  point.y >= 0 &&
  point.y <= FLAT_MAP_HEIGHT;
const samePoint = (a: MapPoint, b: MapPoint) => a.x === b.x && a.y === b.y;

/** Splits display lines at the map seam. Crossing latitude is a drawing interpolation only. */
export function splitMapSegment(a: MapPoint, b: MapPoint): MapPoint[][] {
  if (!validMapPoint(a) || !validMapPoint(b) || samePoint(a, b)) return [];
  const dx = b.x - a.x;
  if (Math.abs(dx) <= FLAT_MAP_WIDTH / 2) return [[a, b]];
  const unwrappedX = b.x + (dx < 0 ? FLAT_MAP_WIDTH : -FLAT_MAP_WIDTH);
  if (Math.abs(unwrappedX - a.x) < 1e-10)
    return a.y === b.y
      ? []
      : [
          [
            { x: 0, y: a.y },
            { x: 0, y: b.y },
          ],
          [
            { x: FLAT_MAP_WIDTH, y: a.y },
            { x: FLAT_MAP_WIDTH, y: b.y },
          ],
        ];
  const edge = dx < 0 ? FLAT_MAP_WIDTH : 0;
  const fraction = (edge - a.x) / (unwrappedX - a.x);
  const y = a.y + fraction * (b.y - a.y);
  return [
    [a, { x: edge, y }],
    [{ x: FLAT_MAP_WIDTH - edge, y }, b],
  ].filter(([start, end]) => !samePoint(start, end));
}

export function splitMapPolyline(points: readonly (MapPoint | null)[], closed = false) {
  const input = [...points];
  if (
    closed &&
    input.length >= 3 &&
    input.every(validMapPoint) &&
    !samePoint(input[0]!, input[input.length - 1]!)
  )
    input.push(input[0]);
  const paths: MapPoint[][] = [];
  let previous: MapPoint | null = null;
  let current: MapPoint[] = [];
  const finish = () => {
    if (current.length > 1) paths.push(current);
    current = [];
  };
  for (const point of input) {
    if (!validMapPoint(point)) {
      finish();
      previous = null;
      continue;
    }
    if (previous) {
      const parts = splitMapSegment(previous, point);
      for (let index = 0; index < parts.length; index++) {
        const [start, end] = parts[index];
        if (!current.length) current.push(start);
        else if (!samePoint(current[current.length - 1], start)) {
          finish();
          current.push(start);
        }
        current.push(end);
        if (index < parts.length - 1) finish();
      }
    }
    previous = point;
  }
  finish();
  return paths;
}

const coordinate = (value: number) => Number(value.toFixed(3));
export function mapPolylinePath(points: readonly MapPoint[]) {
  return points
    .map((point, index) => `${index ? 'L' : 'M'}${coordinate(point.x)},${coordinate(point.y)}`)
    .join('');
}
export function coverageBoundaryPath(boundary: readonly GeographicPoint[]) {
  return splitMapPolyline(boundary.map(geographicToMap), true).map(mapPolylinePath).join('');
}

export const MAX_FLAT_TRACK_SEGMENTS = 12000;
export const MAX_FLAT_RF_SAMPLES_PER_DIRECTION = 2000;
function selectDisplayRows<T>(rows: readonly T[], maximum: number): readonly T[] {
  if (rows.length <= maximum) return rows;
  return Array.from(
    { length: maximum },
    (_, index) => rows[Math.floor((index * (rows.length - 1)) / (maximum - 1))],
  );
}

export function flatTrackPaths(track: GroundTrackData | null) {
  const orbit: string[] = [],
    contact: string[] = [],
    unknown: string[] = [],
    uplink: string[] = [],
    downlink: string[] = [];
  const buckets = new Map<string, NonNullable<GroundTrackData>['segments']>();
  for (const segment of track?.segments ?? []) {
    const key = `${segment.visibility}:${segment.state}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(segment);
  }
  const maximumPerState = Math.floor(MAX_FLAT_TRACK_SEGMENTS / Math.max(1, buckets.size));
  const segments = [...buckets.values()].flatMap((rows) => [
    ...selectDisplayRows(rows, maximumPerState),
  ]);
  const rfRows = {
    uplink: (track?.points ?? []).filter((point) => point.state === 'uplink'),
    downlink: (track?.points ?? []).filter((point) => point.state === 'downlink'),
  };
  let renderedSegmentCount = 0;
  for (const segment of segments) {
    if (
      segment.end.index !== segment.start.index + 1 ||
      !Number.isFinite(segment.start.timeS) ||
      !(segment.end.timeS > segment.start.timeS)
    )
      continue;
    const a = displayGroundPointToMap(segment.start.position);
    const b = displayGroundPointToMap(segment.end.position);
    if (!a || !b) continue;
    const d = splitMapSegment(a, b).map(mapPolylinePath).join('');
    orbit.push(d);
    renderedSegmentCount++;
    if (segment.visibility === 'visible') contact.push(d);
    if (segment.visibility === 'unknown') unknown.push(d);
  }
  const rfPoints = [
    ...selectDisplayRows(rfRows.uplink, MAX_FLAT_RF_SAMPLES_PER_DIRECTION),
    ...selectDisplayRows(rfRows.downlink, MAX_FLAT_RF_SAMPLES_PER_DIRECTION),
  ];
  for (const point of rfPoints) {
    const mapped = displayGroundPointToMap(point.position);
    if (!mapped) continue;
    (point.state === 'uplink' ? uplink : downlink).push(
      `M${coordinate(mapped.x)},${coordinate(mapped.y)}v0.001`,
    );
  }
  return {
    orbit: orbit.join(''),
    contact: contact.join(''),
    unknown: unknown.join(''),
    uplink: uplink.join(''),
    downlink: downlink.join(''),
    totalSegmentCount: track?.segments.length ?? 0,
    selectedSegmentCount: segments.length,
    renderedSegmentCount,
    totalRfSampleCount: rfRows.uplink.length + rfRows.downlink.length,
    selectedRfSampleCount: rfPoints.length,
    thinned:
      segments.length < (track?.segments.length ?? 0) ||
      rfPoints.length < rfRows.uplink.length + rfRows.downlink.length,
  };
}

export function flatMapViewport(size: FlatMapSize, view: FlatMapView): FlatMapViewport {
  const widthPx = Math.max(1, size.width),
    heightPx = Math.max(1, size.height);
  const unitsPerPixel = Math.max(FLAT_MAP_WIDTH / widthPx, FLAT_MAP_HEIGHT / heightPx) / view.zoom;
  const width = widthPx * unitsPerPixel,
    height = heightPx * unitsPerPixel;
  return {
    x: view.center.x - width / 2,
    y: view.center.y - height / 2,
    width,
    height,
    unitsPerPixel,
  };
}
export function constrainFlatMapView(size: FlatMapSize, view: FlatMapView): FlatMapView {
  const zoom = Math.max(1, Math.min(24, Number.isFinite(view.zoom) ? view.zoom : 1));
  const { width, height } = flatMapViewport(size, { ...WORLD_MAP_VIEW, zoom });
  return {
    zoom,
    center: {
      x: width >= FLAT_MAP_WIDTH ? FLAT_MAP_WIDTH / 2 : wrapX(view.center.x),
      y:
        height >= FLAT_MAP_HEIGHT
          ? FLAT_MAP_HEIGHT / 2
          : Math.max(height / 2, Math.min(FLAT_MAP_HEIGHT - height / 2, view.center.y)),
    },
  };
}
export function zoomFlatMapView(
  size: FlatMapSize,
  view: FlatMapView,
  nextZoom: number,
  anchor = { x: 0.5, y: 0.5 },
) {
  const before = flatMapViewport(size, view);
  const next = constrainFlatMapView(size, { ...view, zoom: nextZoom });
  const after = flatMapViewport(size, next);
  return constrainFlatMapView(size, {
    ...next,
    center: {
      x: view.center.x + (anchor.x - 0.5) * (before.width - after.width),
      y: view.center.y + (anchor.y - 0.5) * (before.height - after.height),
    },
  });
}
export function panFlatMapView(size: FlatMapSize, view: FlatMapView, delta: MapPoint) {
  const { unitsPerPixel } = flatMapViewport(size, view);
  return constrainFlatMapView(size, {
    ...view,
    center: {
      x: view.center.x - delta.x * unitsPerPixel,
      y: view.center.y - delta.y * unitsPerPixel,
    },
  });
}

export function defaultCoverageModes(contours: readonly GroundCoverageContour[]) {
  const requested = [
    ['QPSK', '1/2'],
    ['8PSK', '2/3'],
    ['8PSK', '8/9'],
    ['8PSK', '9/10'],
  ] as const;
  const selected = requested.flatMap(([modulation, codeRate]) => {
    const mode = contours.find(
      (item) => item.modulation === modulation && item.code_rate.replaceAll(' ', '') === codeRate,
    );
    return mode ? [mode.mode_id] : [];
  });
  return selected.length ? selected : contours.slice(0, 4).map((item) => item.mode_id);
}
