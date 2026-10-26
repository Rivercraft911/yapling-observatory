import { useEffect, useRef, useState } from 'react';
import type { AssetInfo, RunSnapshot, Scenario, Variant } from './types';
import type { MissionConfig } from './mission/missionTypes';
import { GroundTrackWorkspace } from './earth/GroundTrackWorkspace';
import { EarthScene } from './earth/EarthScene';
import type { EarthCameraMode } from './earth/EarthScene';
import type { FollowStatus } from './earth/SpacecraftFollow';
import type { DisplayTimeSource } from './graphics/displayInterpolation';
import './earth.css';
import { linkDisplayState } from './mission/linkDisplay';

export interface EarthViewProps {
  snapshot: RunSnapshot | null;
  sampleIndex: number;
  coverageScenario?: MissionConfig | Scenario | null;
  displayTime?: DisplayTimeSource;
  asset?: AssetInfo;
  variant?: Variant;
  onGroundTarget?: (positionEcefM: number[]) => void;
}
export function EarthView({
  snapshot,
  sampleIndex,
  coverageScenario = null,
  displayTime,
  asset,
  variant,
  onGroundTarget,
}: EarthViewProps) {
  const host = useRef<HTMLDivElement>(null),
    station = useRef<HTMLDivElement>(null),
    satellite = useRef<HTMLDivElement>(null),
    sun = useRef<HTMLDivElement>(null),
    target = useRef<HTMLDivElement>(null);
  const scene = useRef<EarthScene | null>(null);
  const displayClock = useRef(displayTime);
  displayClock.current = displayTime;
  const history = useRef(snapshot);
  history.current = snapshot;
  const selected = useRef(sampleIndex);
  selected.current = sampleIndex;
  const selectedVariant = variant || snapshot?.scenario.antenna_variant || 'dipole';
  const currentAsset = useRef(asset);
  currentAsset.current = asset;
  const currentVariant = useRef(selectedVariant);
  currentVariant.current = selectedVariant;
  const [cameraMode, setCameraMode] = useState<EarthCameraMode>('earth');
  const [earthLock, setEarthLock] = useState(false);
  const [pickingTarget, setPickingTarget] = useState(false);
  const [groundTrack, setGroundTrack] = useState(false);
  const [trackWindow, setTrackWindow] = useState(10800);
  const targetCallback = useRef(onGroundTarget);
  targetCallback.current = onGroundTarget;
  const [thermalView, setThermalView] = useState(false);
  const mode = useRef(cameraMode);
  mode.current = cameraMode;
  const [followStatus, setFollowStatus] = useState<FollowStatus>({
    state: 'unavailable',
    revision: 'Revision unverified',
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!host.current || !station.current || !satellite.current || !sun.current || !target.current)
      return;
    setLoading(true);
    setError('');
    let view: EarthScene;
    try {
      view = new EarthScene(
        host.current,
        {
          station: station.current,
          satellite: satellite.current,
          sun: sun.current,
          target: target.current,
        },
        (failure) => {
          setLoading(false);
          setError(failure || '');
        },
        setFollowStatus,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Earth renderer unavailable');
      setLoading(false);
      return;
    }
    scene.current = view;
    view.setHistory(history.current);
    view.updateSample(selected.current);
    view.setDisplayTimeSource(displayClock.current);
    view.setAsset(currentVariant.current, currentAsset.current);
    view.setCameraMode(mode.current);
    return () => {
      scene.current = null;
      view.dispose();
    };
  }, [retry]);
  useEffect(() => {
    if (!groundTrack) {
      scene.current?.setHistory(snapshot);
      scene.current?.updateSample(sampleIndex);
    }
  }, [snapshot, sampleIndex, groundTrack]);
  useEffect(() => {
    scene.current?.setDisplayTimeSource(displayTime);
  }, [displayTime]);
  useEffect(() => {
    scene.current?.setAsset(selectedVariant, asset);
  }, [selectedVariant, asset?.url, asset?.revision, asset?.sha256, asset?.available]);
  useEffect(() => {
    scene.current?.setCameraMode(cameraMode);
  }, [cameraMode]);
  useEffect(() => {
    scene.current?.setThermalView(thermalView);
  }, [thermalView, retry]);
  useEffect(() => {
    scene.current?.setFollowEarthLock(earthLock);
  }, [earthLock, retry]);
  useEffect(() => {
    scene.current?.setRenderingVisible(!groundTrack);
  }, [groundTrack, retry]);
  useEffect(() => {
    scene.current?.setGroundTargetPicker(
      pickingTarget && onGroundTarget && cameraMode === 'earth' && !groundTrack
        ? (position) => {
            setPickingTarget(false);
            targetCallback.current?.(position);
          }
        : null,
    );
  }, [pickingTarget, !!onGroundTarget, cameraMode, groundTrack, retry]);
  const samples = snapshot?.run.result?.samples;
  const state = linkDisplayState(samples, sampleIndex);
  const time = samples?.time_s[sampleIndex] ?? 0;
  const date = snapshot
    ? new Date(new Date(snapshot.scenario.epoch_utc).getTime() + time * 1000)
    : null;
  const iso = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  const utc = iso?.slice(11, 19) ?? '—';
  const follow = cameraMode === 'spacecraft';
  const followError =
    follow && followStatus.state === 'unavailable'
      ? followStatus.error || 'Spacecraft model unavailable; position marker shown.'
      : '';
  const pending = loading
    ? 'Loading imagery'
    : follow && followStatus.state === 'loading'
      ? 'Loading spacecraft'
      : '';
  return (
    <section className="earth-view" data-flat={groundTrack} aria-label="Earth and pass view">
      <div className="earth-render-host" ref={host} />
      {groundTrack && snapshot && (
        <GroundTrackWorkspace
          snapshot={snapshot}
          scenario={coverageScenario}
          sampleIndex={sampleIndex}
          windowSeconds={trackWindow}
        />
      )}
      <div className="earth-title">
        <span>
          {follow
            ? 'SPACECRAFT / EARTH'
            : groundTrack
              ? 'EARTH / GROUND TRACK'
              : 'EARTH / PASS ARC'}
        </span>
        <strong>
          {utc}
          <small>UTC</small>
        </strong>
        {iso && <small className="earth-utc-date">{iso.slice(0, 10)}</small>}
        {follow && <small className="earth-follow-revision">{followStatus.revision}</small>}
      </div>
      <div
        className={`earth-link-state ${state === 'RF OPPORTUNITY' ? 'positive' : ''}`}
        title="Uses returned geometry, radio activity and selected-mode margin. Runs without receiver histories use reference-profile margin. Receiver histories without selected-mode margins stay unresolved. RF opportunity does not establish receiver lock or delivered frames."
      >
        <i />
        {state}
      </div>
      <div
        className="earth-locator earth-station-label"
        ref={station}
        hidden
        title="Scenario station: approximate Stanford campus coordinates. The Durand antenna reference point has not been surveyed."
      >
        DURAND<small>scenario station</small>
      </div>
      <div
        className="earth-locator earth-satellite-label"
        ref={satellite}
        hidden
        title="Locator marker is exaggerated. Position is the selected returned ECEF sample."
      >
        SC
      </div>
      <div
        className="earth-locator earth-target-label"
        ref={target}
        hidden
        title="Active Earth pointing target returned by guidance. The amber line marks the requested pointing direction, not the achieved attitude or a radio link."
      >
        TARGET
      </div>
      <div
        className="earth-sun-cue"
        ref={sun}
        hidden
        title="Sun direction used by the displayed Earth and spacecraft lighting. The disk has a fixed 1 AU angular size; the glow is illustrative. Behind Earth describes this camera's view, not the spacecraft's computed eclipse state."
      >
        <i aria-hidden="true" />
        <span>
          SUN
          <small />
        </span>
      </div>
      {!groundTrack && pending && !error && (
        <div className="earth-message">
          <span className="spinner" />
          {pending}
        </div>
      )}
      {!groundTrack && (error || followError) && (
        <div className="earth-message error">
          <span>{error || followError}</span>
          {error ? (
            <button onClick={() => setRetry((n) => n + 1)}>Retry imagery</button>
          ) : (
            <button onClick={() => setCameraMode('earth')}>Earth view</button>
          )}
        </div>
      )}
      {follow && thermalView && (
        <div className="earth-thermal-scale">
          <span>0 °C</span>
          <i />
          <span>80 °C</span>
          <small>gray = unmapped</small>
        </div>
      )}
      <div className="earth-footer">
        <div className="earth-view-tools">
          <div className="earth-camera-modes" aria-label="Camera mode">
            <button
              className={!follow && !groundTrack ? 'active' : ''}
              aria-pressed={!follow && !groundTrack}
              onClick={() => {
                setGroundTrack(false);
                setCameraMode('earth');
              }}
            >
              Earth
            </button>
            <button
              className={!follow && groundTrack ? 'active' : ''}
              aria-pressed={!follow && groundTrack}
              disabled={!samples}
              title="Flat world map with returned ground tracks and conditional MODCOD coverage around Durand."
              onClick={() => {
                setGroundTrack(true);
                setPickingTarget(false);
                setCameraMode('earth');
              }}
            >
              Ground track
            </button>
            <button
              className={follow ? 'active' : ''}
              aria-pressed={follow}
              onClick={() => {
                setGroundTrack(false);
                setCameraMode('spacecraft');
              }}
              disabled={!samples}
              title="Keep the real-size spacecraft centered while orbiting or zooming. Earth and spacecraft use the same Run sample."
            >
              Follow spacecraft
            </button>
          </div>
          {!follow && groundTrack && (
            <select
              className="earth-track-window"
              aria-label="Ground-track window"
              title="Time span centered on the displayed time and limited to returned samples. Live has no predicted future track."
              value={Number.isFinite(trackWindow) ? String(trackWindow) : 'all'}
              onChange={(event) =>
                setTrackWindow(event.target.value === 'all' ? Infinity : Number(event.target.value))
              }
            >
              <option value="10800">3 h</option>
              <option value="86400">24 h</option>
              <option value="all">All</option>
            </select>
          )}
          {follow ? (
            <>
              <button onClick={() => scene.current?.resetFollow()} disabled={!samples}>
                Frame SC
              </button>
              <button
                className={earthLock ? 'active' : ''}
                aria-pressed={earthLock}
                disabled={!samples}
                title="Keep this camera angle relative to Earth as the spacecraft moves. Drag or zoom to adjust."
                onClick={() => setEarthLock(!earthLock)}
              >
                Earth lock
              </button>
            </>
          ) : !groundTrack ? (
            <>
              <button onClick={() => scene.current?.fitPass()} disabled={!samples}>
                Fit pass
              </button>
              <button onClick={() => scene.current?.focusStation()} disabled={!samples}>
                Station
              </button>
              <button onClick={() => scene.current?.globe()}>Globe</button>
              {onGroundTarget && (
                <button
                  aria-pressed={pickingTarget}
                  title="Select an approximate surface location. This commands the pointing target; the radio ground station stays unchanged."
                  onClick={() => setPickingTarget(!pickingTarget)}
                >
                  {pickingTarget ? 'Cancel target pick' : 'Pick target'}
                </button>
              )}
            </>
          ) : null}
        </div>
        {follow && samples?.thermal && (
          <button
            aria-pressed={thermalView}
            onClick={() => setThermalView(!thermalView)}
            title="Computed lumped temperatures: 0–80 °C. Unmapped hardware stays gray."
          >
            {thermalView ? 'Materials' : 'Temperature'}
          </button>
        )}
        <div className="earth-credit" hidden={groundTrack}>
          <a
            href="/earth/NOTICE.txt"
            target="_blank"
            rel="noreferrer"
            title="Earth imagery sources, transformations and license terms."
          >
            Imagery · SSS / NASA ↗
          </a>
          <span title="Returned mission positions and attitudes. Camera changes never affect numerical results. Static clouds do not supply RF weather losses.">
            ECEF · static cloud composite
          </span>
        </div>
      </div>
    </section>
  );
}
export default EarthView;
