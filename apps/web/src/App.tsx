import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { Assets, RadioCatalog, Variant, RunSnapshot } from './types';
import { Workbench } from './Workbench';
import { PaneDivider } from './Resizer';
import { closestIndex, formatValue } from './plots/TracePlot';
import { PlotDock } from './plots/PlotDock';
import { SpacecraftInspector } from './spacecraft/SpacecraftInspector';
import { advanceDisplayTime } from './graphics/displayInterpolation';
import type { DynamicsSession } from './systems/dynamicsTypes';
import type { PowerSession } from './systems/powerTypes';
import { useMission } from './mission/useMission';
import { MissionInspector } from './mission/MissionInspector';
import { MissionHardware } from './mission/MissionHardware';
import { missionDisplaySnapshot } from './mission/displaySnapshot';
import './systems/systems.css';
const DynamicsLab = lazy(() =>
  import('./systems/DynamicsLab').then((m) => ({ default: m.DynamicsLab })),
);
const PowerLab = lazy(() => import('./systems/PowerLab').then((m) => ({ default: m.PowerLab })));
const EarthView = lazy(() => import('./EarthView').then((m) => ({ default: m.EarthView })));
const AntennaLab = lazy(() => import('./AntennaLab').then((m) => ({ default: m.AntennaLab })));
type WorkspaceView = 'earth' | 'spacecraft' | 'antenna';
const workspaceViews: { id: WorkspaceView; label: string }[] = [
  { id: 'earth', label: 'Earth' },
  { id: 'spacecraft', label: 'Spacecraft' },
  { id: 'antenna', label: 'Antenna lab' },
];
const EMPTY: number[] = [];

export default function App() {
  const mission = useMission();
  const scenario = mission.config;
  const snapshot = useMemo(() => missionDisplaySnapshot(mission.snapshot), [mission.snapshot]);
  const run = mission.run,
    error = mission.error,
    busy = mission.busy,
    submitting = mission.submitting,
    dirty = mission.dirty;
  const [view, setView] = useState<WorkspaceView>('earth');
  const [antennaInspector, setAntennaInspector] = useState<HTMLDivElement | null>(null);
  const [antennaFollowsRun, setAntennaFollowsRun] = useState(false);
  const [previewVariant, setPreviewVariant] = useState<Variant | null>(null);
  const [cutaway, setCutaway] = useState(false);
  const [spacecraftSection, setSpacecraftSection] = useState<
    'geometry' | 'hardware' | 'power' | 'thermal' | 'gnc'
  >('geometry');
  const [dynamicsSession, setDynamicsSession] = useState<DynamicsSession>({
    config: null,
    result: null,
  });
  const [powerSession, setPowerSession] = useState<PowerSession>({ config: null, result: null });
  const [systemsInspector, setSystemsInspector] = useState<HTMLDivElement | null>(null);
  const [starTrackerVisible, setStarTrackerVisible] = useState(true);
  const [moduleVisibility, setModuleVisibility] = useState<Record<string, boolean>>({});
  const [availableModules, setAvailableModules] = useState<string[]>([]);
  const [followAttitude, setFollowAttitude] = useState(false);
  const [assets, setAssets] = useState<Assets>({ variants: {} });
  const [catalog, setCatalog] = useState<RadioCatalog>({ presets: [] });
  const [index, setIndex] = useState(0);
  const displayTime = useRef(0),
    displayReadout = useRef<HTMLSpanElement>(null),
    displayTick = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1000);
  const [panelWidth, setPanelWidth] = useState(() => readLayout().panelWidth);
  const [sceneFraction, setSceneFraction] = useState(() => readLayout().sceneFraction);
  const [layoutSize, setLayoutSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight - 62,
  });
  const workspaceRef = useRef<HTMLElement>(null),
    instrumentRef = useRef<HTMLDivElement>(null);
  const autoplayNext = useRef(false),
    completeId = useRef('');
  const compact = layoutSize.width <= 760;
  const panelMax = Math.max(240, Math.min(600, layoutSize.width * 0.45));
  const actualPanelWidth = Math.min(panelMax, Math.max(240, panelWidth));
  const flexibleHeight = Math.max(320, layoutSize.height - 161),
    sceneHeight = flexibleHeight * sceneFraction;
  const [inspector, setInspector] = useState(false);
  const [baseline, setBaseline] = useState<RunSnapshot | null>(null);
  const samples = snapshot?.run.result?.samples,
    times = samples?.time_s || EMPTY,
    time = times[index] ?? 0;
  const renderModules = useMemo(() => {
    const values = { ...moduleVisibility };
    if (spacecraftSection === 'hardware' && scenario) {
      for (const axis of ['X', 'Y', 'Z'])
        values[`SSI_TORQUER_${axis}`] = !!scenario.spacecraft.magnetorquer?.enabled;
      for (const axis of ['X', 'Y', 'Z'])
        values[`SSI_WHEEL_${axis}_OPTIONAL`] = scenario.spacecraft.wheels.some((w) => w.enabled);
    }
    return values;
  }, [moduleVisibility, spacecraftSection, scenario]);
  useEffect(() => {
    const host = workspaceRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() =>
      setLayoutSize({ width: host.clientWidth, height: host.clientHeight }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('ssi-workspace-layout', JSON.stringify({ panelWidth, sceneFraction }));
    } catch {}
  }, [panelWidth, sceneFraction]);
  const resetLayout = () => {
    setPanelWidth(310);
    setSceneFraction(0.56);
  };
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await api<Assets>('/api/assets', { signal: abort.signal });
        if (!abort.signal.aborted)
          setAssets((previous) =>
            JSON.stringify(previous) === JSON.stringify(data) ? previous : data,
          );
      } catch {
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    api<RadioCatalog>('/api/radio-profiles', { signal: abort.signal })
      .then(setCatalog)
      .catch(() => {});
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  const paintDisplayTime = useCallback(
    (value: number) => {
      displayTime.current = value;
      if (displayReadout.current) displayReadout.current.textContent = value.toFixed(1);
      if (displayTick.current)
        displayTick.current.style.left = `${(100 * value) / (times.at(-1) || 1)}%`;
    },
    [times],
  );
  useEffect(() => {
    if (!snapshot?.run.result || completeId.current === snapshot.run.run_id) return;
    completeId.current = snapshot.run.run_id;
    displayTime.current = times[0] ?? 0;
    setIndex(0);
    setPlaying(autoplayNext.current);
    autoplayNext.current = false;
  }, [snapshot, times]);
  useEffect(() => {
    if (!playing || times.length < 2) return;
    let animation = 0,
      previous = performance.now(),
      elapsed = displayTime.current;
    function tick(now: number) {
      elapsed = advanceDisplayTime(elapsed, (now - previous) / 1000, rate, times[times.length - 1]);
      previous = now;
      paintDisplayTime(elapsed);
      setIndex(closestIndex(times, elapsed));
      if (elapsed >= times[times.length - 1]) {
        setPlaying(false);
        return;
      }
      animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, rate, times, paintDisplayTime]);
  const scrub = useCallback(
    (value: number) => {
      setPlaying(false);
      const selected = closestIndex(times, value);
      paintDisplayTime(times[selected] ?? 0);
      setIndex(selected);
    },
    [times, paintDisplayTime],
  );
  const segments = useMemo(() => {
    if (!samples?.time_s.length) return [];
    const states =
      snapshot?.run.result?.events?.filter((event) => event.type === 'state' && event.mode) || [];
    const result: { start: number; end: number; mode: string }[] = [];
    for (const event of states) {
      const last = result.at(-1);
      if (last?.mode === event.mode) continue;
      if (last) last.end = event.time_s;
      result.push({ start: event.time_s, end: samples.time_s.at(-1)!, mode: event.mode! });
    }
    return result;
  }, [samples, snapshot]);
  const lastTime = times[times.length - 1] || 1;
  const selectedVariant = snapshot?.scenario.antenna_variant || scenario?.antenna_variant || 'v45';
  const modelVariant = previewVariant || selectedVariant;
  const cutawayAsset = assets.previews?.cutaway;
  const modelAsset = cutaway
    ? cutawayAsset || {
        revision: 'unavailable',
        url: '/api/assets/previews/cutaway.glb',
        available: false,
      }
    : assets.variants[modelVariant];
  const showTimeline =
    view === 'earth' ||
    (view === 'spacecraft'
      ? (spacecraftSection === 'geometry' || spacecraftSection === 'hardware') && followAttitude
      : antennaFollowsRun);
  const status = busy
    ? submitting
      ? 'Submitting'
      : run?.status || 'Running'
    : snapshot?.run.result?.summary.end_reason &&
        snapshot.run.result.summary.end_reason !== 'requested_duration'
      ? 'Stopped'
      : run?.status || 'Ready';
  const currentDirection = samples?.active_direction[index];
  const radioIdle = samples?.radio_active?.[index] === false;
  const visible = samples?.visible[index];
  const displayedId = snapshot?.run.run_id.slice(0, 8);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src="/brand/ssi-mark.svg" alt="" />
          <span className="brand-name">
            Stanford SSI Link Workspace<small>SATELLITE SYSTEMS</small>
          </span>
        </div>
        <div className="header-right">
          <span className="local-indicator" />
          LOCAL
          <span className="header-divider" />
          {view === 'earth'
            ? 'COUPLED MISSION'
            : view === 'spacecraft'
              ? spacecraftSection === 'geometry' || spacecraftSection === 'hardware'
                ? 'MODEL PREVIEW'
                : spacecraftSection === 'gnc'
                  ? 'DYNAMICS STUDY'
                  : 'PRESCRIBED STUDY'
              : 'ANTENNA REFERENCE'}
          {view === 'earth' && (
            <span className={`run-state ${busy ? 'working' : ''}`}>
              {busy && <span className="spinner" />}
              {status}
            </span>
          )}
        </div>
      </header>
      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          {!scenario ? (
            <button onClick={mission.reload}>Reconnect</button>
          ) : (
            <button onClick={mission.clearError}>Dismiss</button>
          )}
        </div>
      )}
      <main
        className="workspace"
        ref={workspaceRef}
        style={
          compact ? undefined : { gridTemplateColumns: `minmax(0,1fr) 7px ${actualPanelWidth}px` }
        }
      >
        <div
          className={`instrument ${view !== 'earth' ? 'inspection-mode' : ''}`}
          ref={instrumentRef}
          style={{
            gridTemplateRows:
              view === 'earth'
                ? compact
                  ? '420px 36px 360px 92px 32px'
                  : `minmax(160px,${sceneFraction}fr) 7px 36px minmax(160px,${1 - sceneFraction}fr) 91px 27px`
                : `${compact ? 'minmax(700px,auto)' : 'minmax(0,1fr)'} ${showTimeline ? '91px ' : ''}27px`,
          }}
        >
          <div className="visual-stage">
            <nav className="workspace-views" aria-label="Workspace views">
              {workspaceViews.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={view === item.id}
                  className={view === item.id ? 'active' : ''}
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                </button>
              ))}
              <button
                className="reset-layout"
                onClick={resetLayout}
                title="Restore default pane sizes"
              >
                Reset layout
              </button>
            </nav>
            <div className="active-view">
              <Suspense
                key={view}
                fallback={
                  <div className="view-loading">
                    <span className="spinner" />
                    Loading view
                  </div>
                }
              >
                {view === 'earth' ? (
                  <EarthView
                    snapshot={snapshot}
                    sampleIndex={index}
                    displayTime={displayTime}
                    asset={assets.variants[selectedVariant]}
                    variant={selectedVariant}
                  />
                ) : view === 'antenna' ? (
                  <AntennaLab
                    snapshot={snapshot}
                    sampleIndex={index}
                    inspectorTarget={antennaInspector}
                    assets={assets}
                    onFollowRunChange={setAntennaFollowsRun}
                    onUseProfile={(direction, profile, orientation) =>
                      mission.edit((draft) => {
                        draft[direction].spacecraft_antenna = 'spherical_harmonic';
                        draft[direction].spherical_harmonic_profile = profile;
                        draft[direction].antenna_orientation_deg = orientation;
                        draft[direction].frequency_hz = profile.frequency_hz;
                      })
                    }
                  />
                ) : spacecraftSection === 'gnc' ? (
                  <DynamicsLab
                    session={dynamicsSession}
                    onSession={setDynamicsSession}
                    inspectorTarget={systemsInspector}
                    asset={modelAsset}
                    variant={modelVariant}
                    cutaway={cutaway}
                    starTrackerVisible={starTrackerVisible}
                    moduleVisibility={renderModules}
                  />
                ) : spacecraftSection !== 'geometry' && spacecraftSection !== 'hardware' ? (
                  <PowerLab
                    session={powerSession}
                    onSession={setPowerSession}
                    inspectorTarget={systemsInspector}
                    asset={
                      spacecraftSection === 'thermal' && cutawayAsset?.available
                        ? cutawayAsset
                        : modelAsset
                    }
                    variant={modelVariant}
                    cutaway={
                      spacecraftSection === 'thermal' && cutawayAsset?.available ? true : cutaway
                    }
                    starTrackerVisible={starTrackerVisible}
                    moduleVisibility={renderModules}
                    section={spacecraftSection}
                  />
                ) : (
                  <Workbench
                    variant={modelVariant}
                    asset={modelAsset}
                    preview={cutaway ? 'cutaway' : 'exterior'}
                    starTrackerVisible={starTrackerVisible}
                    moduleVisibility={renderModules}
                    onAvailableModules={setAvailableModules}
                    quaternion={
                      followAttitude ? samples?.q_body_from_inertial_wxyz[index] : undefined
                    }
                    displayTime={followAttitude ? displayTime : undefined}
                    quaternionTimes={followAttitude ? times : undefined}
                    quaternionHistory={
                      followAttitude ? samples?.q_body_from_inertial_wxyz : undefined
                    }
                  />
                )}
              </Suspense>
            </div>
          </div>
          {!compact && view === 'earth' && (
            <PaneDivider
              orientation="horizontal"
              value={sceneHeight}
              min={160}
              max={Math.max(160, flexibleHeight - 160)}
              label="Resize main view and graphs"
              onChange={(pixels) =>
                setSceneFraction(Math.max(0.1, Math.min(0.9, pixels / flexibleHeight)))
              }
              onReset={() => setSceneFraction(0.56)}
            />
          )}
          {view === 'earth' && (
            <>
              <div className="sample-bar">
                <div>
                  <span className={`contact-dot ${visible ? 'visible' : ''}`} />
                  <strong>{samples ? (visible ? 'IN VIEW' : 'BELOW MASK') : 'NO RUN'}</strong>
                  <span
                    className={
                      radioIdle
                        ? undefined
                        : currentDirection === 'uplink'
                          ? 'uplink-color'
                          : 'downlink-color'
                    }
                  >
                    {radioIdle
                      ? 'RADIO IDLE'
                      : currentDirection === 'uplink'
                        ? 'UL'
                        : currentDirection === 'downlink'
                          ? 'DL'
                          : '—'}
                  </span>
                </div>
                <div>
                  <span>
                    EL <b>{formatValue(samples?.elevation_deg[index])}°</b>
                  </span>
                  <span>
                    RANGE{' '}
                    <b>
                      {formatValue(
                        samples?.range_m[index] == null ? null : samples.range_m[index]! / 1000,
                        0,
                      )}{' '}
                      km
                    </b>
                  </span>
                  <span>
                    UTC{' '}
                    <b>
                      {samples && snapshot ? formatUtc(snapshot.scenario.epoch_utc, time) : '—'}
                    </b>
                  </span>
                </div>
              </div>
            </>
          )}
          {view === 'earth' && (
            <PlotDock snapshot={snapshot} baseline={baseline} cursorTime={time} onScrub={scrub} />
          )}
          {showTimeline && (
            <>
              <section className="timeline" aria-label="Shared simulation timeline">
                <div className="timeline-top">
                  <div className="playback">
                    <button
                      className="play-button"
                      disabled={!samples}
                      onClick={() => {
                        if (!playing && displayTime.current >= times[times.length - 1]) {
                          paintDisplayTime(times[0] ?? 0);
                          setIndex(0);
                        }
                        setPlaying((value) => !value);
                      }}
                      aria-label={playing ? 'Pause playback' : 'Play playback'}
                    >
                      {playing ? 'Ⅱ' : '▶'}
                    </button>
                    <span className="time-readout">
                      T+ <span ref={displayReadout}>{displayTime.current.toFixed(1)}</span>
                      <small>s</small>
                    </span>
                    <label className="playback-speed">
                      <input
                        type="range"
                        aria-label="Playback speed"
                        aria-valuetext={`${formatSpeed(rate)} times real time`}
                        min={0}
                        max={1000}
                        step={1}
                        value={(1000 * Math.log(rate / 0.25)) / Math.log(4000)}
                        onChange={(event) =>
                          setRate(
                            Math.max(
                              0.25,
                              Math.min(1000, 0.25 * 4000 ** (Number(event.target.value) / 1000)),
                            ),
                          )
                        }
                      />
                      <output>{formatSpeed(rate)}×</output>
                    </label>
                  </div>
                  <span className="eyebrow">
                    {samples?.mode?.[index]?.replaceAll('_', ' ') || 'CONOPS'}
                  </span>
                  <div className="direction-key">
                    <span>SUN</span>
                    <span className="uplink-color">GS</span>
                    <span>IMG</span>
                  </div>
                </div>
                <div className="timeline-track">
                  <div className="operation-segments">
                    {segments.map((segment, i) => (
                      <span
                        key={i}
                        className={segment.mode}
                        title={`${segment.mode.replaceAll('_', ' ')} · ${segment.start}–${segment.end} s`}
                        style={{
                          left: `${(segment.start / lastTime) * 100}%`,
                          width: `${Math.max(0.1, ((segment.end - segment.start) / lastTime) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                  <input
                    type="range"
                    aria-label="Simulation sample"
                    min={0}
                    max={Math.max(times.length - 1, 1)}
                    step={1}
                    value={index}
                    disabled={!samples}
                    onChange={(event) => {
                      scrub(times[Number(event.target.value)] ?? 0);
                    }}
                  />
                  <span
                    ref={displayTick}
                    className="time-tick"
                    style={{ left: `${(displayTime.current / lastTime) * 100}%` }}
                  />
                </div>
                <div className="timeline-labels">
                  <span>0 s</span>
                  <span>{lastTime.toFixed(0)} s</span>
                </div>
              </section>
            </>
          )}
          <footer className="instrument-footer">
            <span>
              {view === 'spacecraft'
                ? spacecraftSection === 'geometry' || spacecraftSection === 'hardware'
                  ? `${cutaway ? 'LAYOUT STUDY' : 'MODEL'} ${modelAsset?.revision || '—'}`
                  : spacecraftSection === 'gnc'
                    ? 'GNC · INDEPENDENT DYNAMICS STUDY'
                    : `${spacecraftSection.toUpperCase()} · ${powerSession.result?.manifest.model_version || 'NOT RUN'}`
                : view === 'antenna'
                  ? 'ANTENNA REFERENCE'
                  : snapshot
                    ? `RUN ${displayedId} · ${times.length} SAMPLES · Δt ${snapshot.scenario.step_s} s`
                    : 'NO COMPUTED HISTORY'}
              {view === 'earth' && dirty ? ' · UNRUN EDITS' : ''}
            </span>
            <span>
              {view === 'earth'
                ? 'Ideal threshold capacity · no packet dynamics'
                : view === 'antenna'
                  ? 'Analytical patterns · nominal geometry'
                  : spacecraftSection === 'gnc'
                    ? 'Supplied target and magnetic field · illustrative actuators'
                    : spacecraftSection !== 'geometry' && spacecraftSection !== 'hardware'
                      ? 'Prescribed CONOPS · provisional thermal inputs'
                      : cutaway
                        ? 'Visual layout study'
                        : 'Concept geometry'}
            </span>
          </footer>
        </div>
        {!compact && (
          <PaneDivider
            orientation="vertical"
            reverse
            value={actualPanelWidth}
            min={240}
            max={panelMax}
            label="Resize inspector"
            onChange={setPanelWidth}
            onReset={() => setPanelWidth(310)}
          />
        )}
        <aside
          className={`controls ${view !== 'earth' ? 'contextual-controls' : ''}`}
          aria-label={
            view === 'earth'
              ? 'Scenario controls'
              : view === 'spacecraft'
                ? 'Spacecraft controls'
                : 'Antenna controls'
          }
        >
          {view === 'spacecraft' ? (
            <>
              <nav className="spacecraft-sections" aria-label="Spacecraft sections">
                {(['geometry', 'hardware', 'power', 'thermal', 'gnc'] as const).map((section) => (
                  <button
                    key={section}
                    aria-pressed={spacecraftSection === section}
                    onClick={() => {
                      setSpacecraftSection(section);
                      if (section === 'hardware' && cutawayAsset?.available) setCutaway(true);
                    }}
                  >
                    {section === 'geometry'
                      ? 'Geometry'
                      : section === 'hardware'
                        ? 'Hardware'
                        : section === 'power'
                          ? 'Power & avionics'
                          : section === 'thermal'
                            ? 'Thermal'
                            : 'GNC'}
                  </button>
                ))}
              </nav>
              {spacecraftSection === 'hardware' && scenario ? (
                <MissionHardware config={scenario} edit={mission.edit} />
              ) : spacecraftSection !== 'geometry' && spacecraftSection !== 'hardware' ? (
                <div ref={setSystemsInspector} />
              ) : (
                <SpacecraftInspector
                  variant={modelVariant}
                  asset={modelAsset}
                  cutaway={cutaway}
                  onCutaway={setCutaway}
                  cutawayAvailable={cutawayAsset?.available === true}
                  starTrackerVisible={starTrackerVisible}
                  onStarTrackerVisible={setStarTrackerVisible}
                  moduleVisibility={renderModules}
                  availableModules={availableModules}
                  onModuleVisibility={(groups, visible) =>
                    setModuleVisibility((current) => ({
                      ...current,
                      ...Object.fromEntries(groups.map((name) => [name, visible])),
                    }))
                  }
                  onVariant={setPreviewVariant}
                  followAttitude={followAttitude}
                  onFollowAttitude={setFollowAttitude}
                  hasRun={!!samples}
                  onApply={() => {
                    mission.edit((draft) => {
                      draft.antenna_variant = modelVariant;
                    });
                    setView('earth');
                  }}
                />
              )}
            </>
          ) : view === 'antenna' ? (
            <div className="antenna-inspector-host" ref={setAntennaInspector} />
          ) : (
            <MissionInspector
              mission={mission}
              catalog={catalog}
              onRun={() => {
                setPlaying(false);
                autoplayNext.current = true;
                void mission.start();
              }}
              onInspect={() => setInspector(true)}
              canPin={!!snapshot}
              hasBaseline={!!baseline}
              onPin={() => setBaseline(baseline ? null : snapshot)}
            />
          )}
        </aside>
      </main>
      {inspector && (
        <div className="modal-backdrop" onClick={() => setInspector(false)}>
          <section
            className="inspector"
            role="dialog"
            aria-modal="true"
            aria-label="Run provenance"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="inspector-heading">
              <h2>Inputs & provenance</h2>
              <button onClick={() => setInspector(false)} aria-label="Close inspector">
                Close ×
              </button>
            </div>
            <div className="inspector-body">
              <h3>Scenario {dirty ? '· unrun edits' : ''}</h3>
              <pre>{JSON.stringify(scenario, null, 2)}</pre>
              <h3>Displayed run manifest</h3>
              <pre>
                {snapshot
                  ? JSON.stringify(
                      {
                        run_id: snapshot.run.run_id,
                        scenario_hash: snapshot.run.scenario_hash,
                        ...snapshot.run.result?.manifest,
                      },
                      null,
                      2,
                    )
                  : 'No completed run'}
              </pre>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function formatUtc(epoch: string, elapsed: number) {
  const date = new Date(new Date(epoch).getTime() + elapsed * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(11, 19);
}
function readLayout() {
  try {
    const value = JSON.parse(localStorage.getItem('ssi-workspace-layout') || 'null');
    return {
      panelWidth: Number.isFinite(value?.panelWidth)
        ? Math.max(240, Math.min(600, value.panelWidth))
        : 310,
      sceneFraction: Number.isFinite(value?.sceneFraction)
        ? Math.max(0.1, Math.min(0.9, value.sceneFraction))
        : 0.56,
    };
  } catch {
    return { panelWidth: 310, sceneFraction: 0.56 };
  }
}
function formatSpeed(value: number) {
  return value < 10
    ? value.toFixed(value < 1 ? 2 : 1).replace(/\.?0+$/, '')
    : Math.round(value).toString();
}
