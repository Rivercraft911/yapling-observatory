import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { GroundTrackData } from './groundTrack';
import {
  FLAT_MAP_HEIGHT,
  FLAT_MAP_WIDTH,
  WORLD_MAP_VIEW,
  constrainFlatMapView,
  coverageBoundaryPath,
  defaultCoverageModes,
  displayGroundPointToMap,
  ecefToFlatMap,
  flatMapViewport,
  flatTrackPaths,
  geographicToMap,
  panFlatMapView,
  zoomFlatMapView,
} from './flatMapGeometry';
import type { FlatMapSize, FlatMapView, GroundCoverageResponse, MapPoint } from './flatMapGeometry';
import './flat-ground-track.css';

export interface FlatGroundTrackProps {
  track: GroundTrackData | null;
  currentPositionEcefM?: readonly number[] | null;
  station: { latitudeDeg: number; longitudeDeg: number; label?: string };
  coverage?: GroundCoverageResponse | null;
  coverageState?: 'loading' | 'ready' | 'unavailable';
  coverageError?: string;
  selectedModes?: readonly string[];
  onSelectedModesChange?: (ids: string[]) => void;
}
const MODE_COLORS = ['#f1b2aa', '#d98184', '#f0dfc7', '#b49c89', '#bc606b', '#c6c2bd'];
const longitudeTicks = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const latitudeTicks = [-60, -30, 0, 30, 60];
const directionName = { uplink: 'UPLINK', downlink: 'DOWNLINK' };
const modeStatus = { coverage: 'boundary', no_coverage: 'no coverage', unresolved: 'unresolved' };
const contourDetails = (contour: GroundCoverageResponse['contours'][number]) =>
  [
    `${contour.label}: ${modeStatus[contour.status]}; ${contour.limit.replaceAll('_', ' ')}.`,
    `Symbol rate: ${contour.symbol_rate_sps === null ? 'unresolved' : `${contour.symbol_rate_sps.toLocaleString('en-US')} symbols/s`}.`,
    `Threshold Es/N0: ${contour.threshold_esn0_db === null ? 'unresolved' : `${contour.threshold_esn0_db.toFixed(2)} dB`}.`,
    `Engineering reserve: ${contour.engineering_reserve_db === null ? 'included in threshold; separate amount unavailable' : `${contour.engineering_reserve_db.toFixed(2)} dB, included in threshold`}.`,
    `Threshold status: ${contour.threshold_status}. Source: ${contour.threshold_source}.`,
  ].join('\n');
const coordinateLabel = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(0)}°${value === 0 ? '' : value > 0 ? positive : negative}`;

export function FlatGroundTrack({
  track,
  currentPositionEcefM,
  station,
  coverage,
  coverageState,
  coverageError,
  selectedModes,
  onSelectedModesChange,
}: FlatGroundTrackProps) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; view: FlatMapView } | null>(null);
  const [size, setSize] = useState<FlatMapSize>({ width: 960, height: 540 });
  const [view, setView] = useState(WORLD_MAP_VIEW);
  const [localModes, setLocalModes] = useState<readonly string[] | null>(null);
  const [showModes, setShowModes] = useState(false);
  const [highlightedMode, setHighlightedMode] = useState<string | null>(null);
  const id = useId().replaceAll(':', '');
  const viewport = flatMapViewport(size, constrainFlatMapView(size, view));
  const units = viewport.unitsPerPixel;
  const stationPoint = geographicToMap({
    latitude_deg: station.latitudeDeg,
    longitude_deg: station.longitudeDeg,
  });
  const current = ecefToFlatMap(currentPositionEcefM);
  const paths = useMemo(() => flatTrackPaths(track), [track]);
  const contours = useMemo(() => {
    const modes = coverage?.contours ?? [];
    const preferred = defaultCoverageModes(modes);
    const order = [
      ...preferred,
      ...modes.map((mode) => mode.mode_id).filter((modeId) => !preferred.includes(modeId)),
    ];
    return modes.map((contour) => ({
      ...contour,
      path: coverageBoundaryPath(contour.boundary),
      color: MODE_COLORS[order.indexOf(contour.mode_id) % MODE_COLORS.length],
    }));
  }, [coverage]);
  const defaults = useMemo(() => defaultCoverageModes(contours), [contours]);
  const chosenModes = selectedModes ?? localModes ?? defaults;
  const shownContours = contours.filter((item) => chosenModes.includes(item.mode_id));
  const copies = view.zoom > 1.01 && viewport.width < FLAT_MAP_WIDTH ? [-1, 0, 1] : [0];
  const mapTitle = `Flat Earth ground track, ${station.label || 'Durand'} station. Drag to pan; scroll to zoom. Arrow keys pan; plus and minus zoom; Home shows the world.`;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) setSize({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setView((previous) => constrainFlatMapView(size, previous));
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setView((previous) =>
        zoomFlatMapView(size, previous, previous.zoom * Math.exp(-delta * 0.002), {
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        }),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [size]);

  const focusStation = () => {
    if (stationPoint) setView(constrainFlatMapView(size, { center: stationPoint, zoom: 5 }));
  };
  const zoom = (factor: number) =>
    setView((previous) => zoomFlatMapView(size, previous, previous.zoom * factor));
  const toggleMode = (modeId: string) => {
    const next = chosenModes.includes(modeId)
      ? chosenModes.filter((item) => item !== modeId)
      : [...chosenModes, modeId];
    if (onSelectedModesChange) onSelectedModesChange(next);
    if (selectedModes === undefined) setLocalModes(next);
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
    event.currentTarget.dataset.dragging = 'true';
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setView(
      panFlatMapView(size, active.view, {
        x: event.clientX - active.x,
        y: event.clientY - active.y,
      }),
    );
  };
  const pointerEnd = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const pan: Record<string, MapPoint> = {
      ArrowLeft: { x: 75, y: 0 },
      ArrowRight: { x: -75, y: 0 },
      ArrowUp: { x: 0, y: 75 },
      ArrowDown: { x: 0, y: -75 },
    };
    if (event.key in pan) setView((previous) => panFlatMapView(size, previous, pan[event.key]));
    else if (event.key === '+' || event.key === '=') zoom(1.5);
    else if (event.key === '-') zoom(1 / 1.5);
    else if (event.key === 'Home') setView(WORLD_MAP_VIEW);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="flat-ground-track" ref={host}>
      <svg
        className="flat-map-svg"
        ref={svg}
        role="application"
        aria-label={mapTitle}
        aria-describedby={`${id}-description`}
        tabIndex={0}
        viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
        onKeyDown={keyDown}
      >
        <title>{mapTitle}</title>
        <desc id={`${id}-description`}>
          Equirectangular map of returned radial ground-track samples. Lines stop at missing rows
          and split at the date line. Red and warm-white dots mark sampled uplink and downlink RF
          opportunities, without establishing receiver lock. Coverage boundaries use the numerical
          model's stated constant-gain, polarization and altitude assumptions.
        </desc>
        <defs>
          <clipPath id={`${id}-world`}>
            <rect width={FLAT_MAP_WIDTH} height={FLAT_MAP_HEIGHT} />
          </clipPath>
        </defs>
        {copies.map((copy) => (
          <g key={copy} transform={`translate(${copy * FLAT_MAP_WIDTH} 0)`}>
            <rect className="flat-map-ocean" width={FLAT_MAP_WIDTH} height={FLAT_MAP_HEIGHT} />
            <image
              className="flat-map-imagery"
              href="/earth/earth-day-4k.jpg"
              width={FLAT_MAP_WIDTH}
              height={FLAT_MAP_HEIGHT}
              preserveAspectRatio="none"
            />
            <g clipPath={`url(#${id}-world)`}>
              <g className="flat-map-grid">
                {longitudeTicks.map((longitude) => (
                  <path
                    key={longitude}
                    d={`M${(longitude + 180) * 4},0V${FLAT_MAP_HEIGHT}`}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {latitudeTicks.map((latitude) => (
                  <path
                    key={latitude}
                    d={`M0,${(90 - latitude) * 4}H${FLAT_MAP_WIDTH}`}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  className="flat-map-equator"
                  d={`M0,360H${FLAT_MAP_WIDTH}`}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
              <g className="flat-map-tick-labels" aria-hidden="true">
                {longitudeTicks
                  .filter((_, index) => view.zoom > 2 || index % 2 === 1)
                  .map((longitude) => (
                    <text
                      key={longitude}
                      x={(longitude + 180) * 4}
                      y={FLAT_MAP_HEIGHT - 8 * units}
                      fontSize={8 * units}
                      textAnchor="middle"
                    >
                      {coordinateLabel(longitude, 'E', 'W')}
                    </text>
                  ))}
                {latitudeTicks.map((latitude) => (
                  <text
                    key={latitude}
                    x={8 * units}
                    y={(90 - latitude) * 4 - 5 * units}
                    fontSize={8 * units}
                  >
                    {coordinateLabel(latitude, 'N', 'S')}
                  </text>
                ))}
              </g>
              <path className="flat-map-track" d={paths.orbit} vectorEffect="non-scaling-stroke" />
              <path
                className="flat-map-contact"
                d={paths.contact}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="flat-map-unknown"
                d={paths.unknown}
                vectorEffect="non-scaling-stroke"
              />
              {shownContours.map((contour) => (
                <path
                  key={contour.mode_id}
                  className={`flat-map-contour ${highlightedMode === contour.mode_id ? 'highlighted' : ''}`}
                  d={contour.path}
                  stroke={contour.color}
                  vectorEffect="non-scaling-stroke"
                  opacity={highlightedMode && highlightedMode !== contour.mode_id ? 0.2 : undefined}
                >
                  <title>{contourDetails(contour)}</title>
                </path>
              ))}
              <path
                className="flat-map-opportunity uplink"
                d={paths.uplink}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="flat-map-opportunity downlink"
                d={paths.downlink}
                vectorEffect="non-scaling-stroke"
              />
              {view.zoom >= 2.5 &&
                shownContours.map((contour, index) => {
                  const boundary = contour.boundary
                    .map(geographicToMap)
                    .filter((point): point is MapPoint => point !== null);
                  const point = boundary.length
                    ? boundary[Math.floor(boundary.length * ((0.08 + index * 0.055) % 0.4))]
                    : null;
                  return point ? (
                    <g
                      key={contour.mode_id}
                      transform={`translate(${point.x} ${point.y}) scale(${units})`}
                      className="flat-map-ring-label"
                      style={{ color: contour.color }}
                    >
                      <text x={7} y={-5}>
                        {contour.label}
                      </text>
                    </g>
                  ) : null;
                })}
              {view.zoom >= 2.5 &&
                track?.markers
                  .filter((marker) => marker.kind === 'aos' || marker.kind === 'los')
                  .map((marker) => {
                    const point = displayGroundPointToMap(marker.point.position);
                    return point ? (
                      <g
                        key={`${marker.contactId}-${marker.kind}`}
                        transform={`translate(${point.x} ${point.y}) scale(${units})`}
                        className="flat-map-pass-marker"
                      >
                        <circle r={3} />
                        <title>{`${marker.kind.toUpperCase()} sampled bracket ${marker.bracketStartS}–${marker.bracketEndS} s`}</title>
                      </g>
                    ) : null;
                  })}
              {stationPoint && (
                <g
                  transform={`translate(${stationPoint.x} ${stationPoint.y}) scale(${units})`}
                  className="flat-map-station"
                >
                  <path d="M-7,0H7M0,-7V7" />
                  <circle r={3} />
                  <text x={10} y={-8}>
                    {(station.label || 'DURAND').toUpperCase()}
                  </text>
                  <title>Scenario station. Durand antenna reference point is not surveyed.</title>
                </g>
              )}
              {current && (
                <g
                  transform={`translate(${current.x} ${current.y}) scale(${units})`}
                  className="flat-map-spacecraft"
                >
                  <circle className="flat-map-cursor-halo" r={9} />
                  <path d="M0,-5L5,0L0,5L-5,0Z" />
                  <text x={12} y={4}>
                    SC
                  </text>
                  <title>
                    Selected returned spacecraft sample, radially projected for display.
                  </title>
                </g>
              )}
            </g>
            <rect
              className="flat-map-frame"
              width={FLAT_MAP_WIDTH}
              height={FLAT_MAP_HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
      <div className="flat-map-navigation" aria-label="Map navigation">
        <button
          type="button"
          onClick={() => setView(WORLD_MAP_VIEW)}
          title="Show the full world (Home)"
        >
          World
        </button>
        <button
          type="button"
          onClick={focusStation}
          disabled={!stationPoint}
          title="Center and zoom on the scenario ground station"
        >
          {station.label || 'Durand'}
        </button>
        <span />
        <button
          type="button"
          className="flat-map-zoom-button"
          onClick={() => zoom(1 / 1.5)}
          disabled={view.zoom <= 1}
          aria-label="Zoom map out"
        >
          −
        </button>
        <button
          type="button"
          className="flat-map-zoom-button"
          onClick={() => zoom(1.5)}
          disabled={view.zoom >= 24}
          aria-label="Zoom map in"
        >
          +
        </button>
      </div>
      <div
        className="flat-map-coverage"
        aria-label="RF coverage contours"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setShowModes(false);
        }}
      >
        <div className="flat-map-coverage-heading">
          <span title={coverage?.assumptions.join('\n') || coverageError}>
            {coverageState === 'loading'
              ? 'COMPUTING CONTOURS'
              : coverage
                ? `${directionName[coverage.direction]} · ${(coverage.altitude_m / 1000).toFixed(0)} KM`
                : 'CONTOURS UNAVAILABLE'}
          </span>
          {contours.length > 0 && (
            <button
              type="button"
              aria-expanded={showModes}
              aria-controls={`${id}-modes`}
              onClick={() => setShowModes((previous) => !previous)}
            >
              MODCOD <span aria-hidden="true">{showModes ? '−' : '+'}</span>
            </button>
          )}
        </div>
        <div className="flat-map-selected-modes">
          {shownContours.map((contour) => (
            <button
              type="button"
              key={contour.mode_id}
              className={contour.status !== 'coverage' ? 'unavailable' : undefined}
              style={{ color: contour.color }}
              onMouseEnter={() => setHighlightedMode(contour.mode_id)}
              onMouseLeave={() => setHighlightedMode(null)}
              onFocus={() => setHighlightedMode(contour.mode_id)}
              onBlur={() => setHighlightedMode(null)}
              onClick={() => toggleMode(contour.mode_id)}
              title={`${contourDetails(contour)}\nClick to hide.`}
            >
              <i />
              {contour.label}
              {contour.status !== 'coverage' && (
                <small>{contour.status === 'unresolved' ? '?' : '∅'}</small>
              )}
            </button>
          ))}
          {coverage && !shownContours.length && (
            <span className="flat-map-no-modes">No MODCODs selected</span>
          )}
        </div>
        {showModes && (
          <div
            className="flat-map-mode-menu"
            id={`${id}-modes`}
            role="group"
            aria-label="Visible MODCOD boundaries"
          >
            {contours.map((contour) => (
              <button
                type="button"
                key={contour.mode_id}
                aria-pressed={chosenModes.includes(contour.mode_id)}
                onClick={() => toggleMode(contour.mode_id)}
                title={contourDetails(contour)}
              >
                <i style={{ background: contour.color }} />
                {contour.label}
                <span aria-hidden="true">{chosenModes.includes(contour.mode_id) ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flat-map-footnote">
        <span
          className="flat-map-projection"
          title="Equirectangular display. Ground-track latitude is mapped from the radial WGS84 intersection; no new orbit propagation or RF calculation occurs in this view."
        >
          EQUIRECTANGULAR
        </span>
        <span className="flat-map-sample-key">
          <i className="uplink" />
          UP
          <i className="downlink" />
          DOWN
        </span>
        {paths.thinned && (
          <span
            title={`Display selects ${paths.selectedSegmentCount} of ${paths.totalSegmentCount} segment pairs and ${paths.selectedRfSampleCount} of ${paths.totalRfSampleCount} RF samples. Skipped segments are never joined. Stored results are unchanged.`}
          >
            THINNED
          </span>
        )}
        <a
          href="https://www.solarsystemscope.com/textures/"
          target="_blank"
          rel="noreferrer"
          title="Earth imagery: Solar System Scope / INOVE, based on NASA Blue Marble. CC BY 4.0. Static visual composite."
        >
          Earth: Solar System Scope · CC BY 4.0
        </a>
      </div>
      {!track?.points.length && (
        <span className="flat-map-empty">No returned ground-track samples</span>
      )}
    </div>
  );
}
