import { useEffect, useRef, useState } from 'react';
import type { AssetInfo, RunSnapshot, Variant } from './types';
import { EarthScene } from './earth/EarthScene';
import type { EarthCameraMode } from './earth/EarthScene';
import type { FollowStatus } from './earth/SpacecraftFollow';
import type { DisplayTimeSource } from './graphics/displayInterpolation';
import './earth.css';

export interface EarthViewProps {
  snapshot: RunSnapshot | null;
  sampleIndex: number;
  displayTime?: DisplayTimeSource;
  asset?: AssetInfo;
  variant?: Variant;
}
export function EarthView({ snapshot, sampleIndex, displayTime, asset, variant }: EarthViewProps) {
  const host = useRef<HTMLDivElement>(null),
    station = useRef<HTMLDivElement>(null),
    satellite = useRef<HTMLDivElement>(null);
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
    if (!host.current || !station.current || !satellite.current) return;
    setLoading(true);
    setError('');
    let view: EarthScene;
    try {
      view = new EarthScene(
        host.current,
        { station: station.current, satellite: satellite.current },
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
    scene.current?.setHistory(snapshot);
    scene.current?.updateSample(sampleIndex);
  }, [snapshot, sampleIndex]);
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
  const samples = snapshot?.run.result?.samples;
  const direction = samples?.active_direction[sampleIndex];
  const visible = samples?.visible[sampleIndex];
  const margin = direction ? samples?.[direction].margin_db[sampleIndex] : null;
  const state = !samples
    ? 'NO RUN'
    : samples.radio_active?.[sampleIndex] === false
      ? 'RADIO IDLE'
      : !visible
        ? 'BELOW MASK'
        : margin == null
          ? 'RF UNRESOLVED'
          : margin < 0
            ? 'BELOW THRESHOLD'
            : 'IDEAL LINK';
  const time = samples?.time_s[sampleIndex] ?? 0;
  const date = snapshot
    ? new Date(new Date(snapshot.scenario.epoch_utc).getTime() + time * 1000)
    : null;
  const utc = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(11, 19) : '—';
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
    <section className="earth-view" aria-label="Earth and pass view">
      <div className="earth-render-host" ref={host} />
      <div className="earth-title">
        <span>{follow ? 'SPACECRAFT / EARTH' : 'EARTH / PASS ARC'}</span>
        <strong>
          {utc}
          <small>UTC</small>
        </strong>
        {follow && <small className="earth-follow-revision">{followStatus.revision}</small>}
      </div>
      <div
        className={`earth-link-state ${visible && margin != null && margin >= 0 ? 'positive' : ''}`}
        title="Uses the selected Run sample and ideal threshold model. Above-mask geometry and receiver margin are separate conditions."
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
      {pending && !error && (
        <div className="earth-message">
          <span className="spinner" />
          {pending}
        </div>
      )}
      {(error || followError) && (
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
            <button className={!follow ? 'active' : ''} onClick={() => setCameraMode('earth')}>
              Earth
            </button>
            <button
              className={follow ? 'active' : ''}
              onClick={() => setCameraMode('spacecraft')}
              disabled={!samples}
              title="Keep the real-size spacecraft centered while orbiting or zooming. Earth and spacecraft use the same Run sample."
            >
              Follow spacecraft
            </button>
          </div>
          {follow ? (
            <button onClick={() => scene.current?.resetFollow()} disabled={!samples}>
              Frame SC
            </button>
          ) : (
            <>
              <button onClick={() => scene.current?.fitPass()} disabled={!samples}>
                Fit pass
              </button>
              <button onClick={() => scene.current?.focusStation()} disabled={!samples}>
                Station
              </button>
              <button onClick={() => scene.current?.globe()}>Globe</button>
            </>
          )}
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
        <div className="earth-credit">
          <a
            href="/earth/NOTICE.txt"
            target="_blank"
            rel="noreferrer"
            title="Static Solar System Scope / NASA-derived imagery, CC BY 4.0. Includes sources, transformations and license."
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
