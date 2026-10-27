import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { Assets, RadioCatalog, Variant, RunSnapshot } from './types';
import { PaneDivider } from './Resizer';
import { MusicControl } from './audio/MusicControl';
import { closestIndex, formatValue } from './plots/TracePlot';
import { PlotDock } from './plots/PlotDock';
import { clampTimeRange, sampleTimeDomain, type TimeRange } from './plots/timeWindow';
import { SpacecraftInspector } from './spacecraft/SpacecraftInspector';
import { advanceDisplayTime } from './graphics/displayInterpolation';
import type { DynamicsSession } from './systems/dynamicsTypes';
import type { PowerSession } from './systems/powerTypes';
import { useLiveMission } from './live/useLiveMission';
import { useMission } from './mission/useMission';
import { MissionInspector } from './mission/MissionInspector';
import { MissionHardware } from './mission/MissionHardware';
import { MissionGncControls } from './mission/MissionGncControls';
import { MissionPowerControls } from './mission/MissionPowerControls';
import { MissionThermalControls } from './mission/MissionThermalControls';
import { MissionArchiveControls } from './mission/MissionArchiveControls';
import { ResultsWorkspace } from './mission/ResultsWorkspace';
import { setMissionDuration } from './mission/missionDuration';
import { Field } from './controls/RadioControls';
import { missionDisplaySnapshot } from './mission/displaySnapshot';
import './systems/systems.css';
const LiveWorkspace = lazy(() =>
  import('./live/LiveWorkspace').then((m) => ({ default: m.LiveWorkspace })),
);
const Workbench = lazy(() => import('./Workbench').then((m) => ({ default: m.Workbench })));
const DynamicsLab = lazy(() =>
  import('./systems/DynamicsLab').then((m) => ({ default: m.DynamicsLab })),
);
const PowerLab = lazy(() => import('./systems/PowerLab').then((m) => ({ default: m.PowerLab })));
const EarthView = lazy(() => import('./EarthView').then((m) => ({ default: m.EarthView })));
const AntennaLab = lazy(() => import('./AntennaLab').then((m) => ({ default: m.AntennaLab })));
type WorkspaceView = 'live' | 'earth' | 'spacecraft' | 'antenna' | 'results';
const workspaceViews: { id: WorkspaceView; label: string }[] = [
  { id: 'earth', label: 'Earth' },
  { id: 'spacecraft', label: 'Spacecraft' },
  { id: 'antenna', label: 'Antenna lab' },
  { id: 'results', label: 'Results' },
];
const EMPTY: number[] = [];

export default function App() {
  const mission = useMission();
  const live = useLiveMission();
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
  const [thermalNodeId, setThermalNodeId] = useState('bus');
  const [spacecraftSection, setSpacecraftSection] = useState<
    'geometry' | 'hardware' | 'power' | 'thermal' | 'gnc'
  >('geometry');
  const [independentStudy, setIndependentStudy] = useState<'gnc' | 'power' | 'thermal' | null>(
    null,
  );
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
  const presentationId = mission.snapshot?.presentation_id || snapshot?.run.run_id || '';
  const [plotWindow, setPlotWindow] = useState<{ identity: string; range: TimeRange | null }>({
    identity: '',
    range: null,
  });
  const timeRange = plotWindow.identity === presentationId ? plotWindow.range : null;
  const changeTimeRange = useCallback(
    (range: TimeRange | null) => setPlotWindow({ identity: presentationId, range }),
    [presentationId],
  );
  const timeDomain = useMemo(() => sampleTimeDomain(times), [times]);
  const renderModules = useMemo(() => {
    const values = { ...moduleVisibility };
    if (!independentStudy && spacecraftSection !== 'geometry' && scenario) {
      for (const axis of ['X', 'Y', 'Z'])
        values[`SSI_TORQUER_${axis}`] = !!scenario.spacecraft.magnetorquer?.enabled;
      for (const axis of ['X', 'Y', 'Z'])
        values[`SSI_WHEEL_${axis}_OPTIONAL`] = scenario.spacecraft.wheels.some((w) => w.enabled);
    }
    return values;
  }, [moduleVisibility, spacecraftSection, independentStudy, scenario]);
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
    const presentationId = mission.snapshot?.presentation_id || snapshot?.run.run_id;
    if (!snapshot?.run.result || !presentationId || completeId.current === presentationId) return;
    completeId.current = presentationId;
    displayTime.current = times[0] ?? 0;
    setIndex(0);
    setPlaying(!mission.snapshot?.imported && autoplayNext.current);
    autoplayNext.current = false;
  }, [snapshot, times, mission.snapshot?.presentation_id, mission.snapshot?.imported]);
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
  const focusRange = useCallback(
    (start: number, end: number) => {
      if (!timeDomain || !Number.isFinite(start) || !Number.isFinite(end)) return;
      const padding = Math.max(timeDomain.minimumSpan, (end - start) * 0.1);
      changeTimeRange(clampTimeRange([start - padding, end + padding], timeDomain));
      scrub(start);
    },
    [timeDomain, changeTimeRange, scrub],
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
  const followsMission = followAttitude;
  const changeCutaway = (enabled: boolean) => {
    setCutaway(enabled);
    if (enabled) setFollowAttitude(false);
  };
  const missionTemperatures = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(samples?.thermal?.node_temperature_k || {}).map(([node, values]) => [
          node,
          values[index],
        ]),
      ),
    [samples, index],
  );
  const startMission = () => {
    setPlaying(false);
    autoplayNext.current = true;
    void mission.start();
  };
  const showTimeline =
    view === 'earth' ||
    view === 'results' ||
    (view === 'spacecraft'
      ? !independentStudy && (spacecraftSection !== 'geometry' || followsMission)
      : view === 'antenna' && antennaFollowsRun);
  const stopped =
    !!snapshot?.run.result?.summary.end_reason &&
    snapshot.run.result.summary.end_reason !== 'requested_duration';
  const status = mission.importing
    ? 'Opening'
    : busy
      ? submitting
        ? 'Submitting'
        : run?.status || 'Running'
      : mission.snapshot?.imported
        ? stopped
          ? 'Imported · stopped'
          : 'Imported'
        : stopped
          ? 'Stopped'
          : run?.status || 'Ready';
  const currentDirection = samples?.active_direction[index];
  const radioIdle = samples?.radio_active?.[index] === false;
  const receiver = currentDirection ? samples?.radio_delivery?.[currentDirection] : undefined;
  const receiverMode = currentDirection
    ? mission.snapshot?.scenario.radio_delivery?.[currentDirection].modes.find(
        (mode) => mode.mode_id === receiver?.mode_id[index],
      )
    : undefined;
  const visible = samples?.visible[index];
  const displayedId = snapshot?.run.run_id.slice(0, 8);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src="/brand/ssi-mark.svg" alt="" />
          <span className="brand-name">
            Yapling Observatory<small>Stanford SSI - A Rivercraft Slop Production</small>
          </span>
        </div>
        <div className="header-right">
          <MusicControl />
          <span className="local-indicator" />
          LOCAL
          <span className="header-divider" />
          {view === 'live'
            ? 'LIVE MISSION'
            : view === 'earth' || view === 'results'
              ? 'COUPLED MISSION'
              : view === 'spacecraft'
                ? independentStudy
                  ? 'INDEPENDENT STUDY'
                  : spacecraftSection === 'geometry'
                    ? 'MODEL PREVIEW'
                    : 'COUPLED MISSION'
                : 'ANTENNA REFERENCE'}
          {(view === 'earth' ||
            view === 'results' ||
            (view === 'spacecraft' && !independentStudy)) && (
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
          view === 'results' || view === 'live'
            ? { gridTemplateColumns: 'minmax(0,1fr)' }
            : compact
              ? undefined
              : { gridTemplateColumns: `minmax(0,1fr) 7px ${actualPanelWidth}px` }
        }
      >
        <div
          className={`instrument ${view !== 'earth' ? 'inspection-mode' : ''}`}
          ref={instrumentRef}
          style={{
            gridTemplateRows:
              view === 'earth'
                ? compact
                  ? '420px 36px 360px minmax(92px,auto) 32px'
                  : `minmax(160px,${sceneFraction}fr) 7px 36px minmax(160px,${1 - sceneFraction}fr) minmax(91px,auto) 27px`
                : `${compact ? 'minmax(700px,auto)' : 'minmax(0,1fr)'} ${showTimeline ? 'minmax(91px,auto) ' : ''}27px`,
          }}
        >
          <div className="visual-stage">
            <nav className="workspace-views" aria-label="Workspace views">
              {workspaceViews.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={view === item.id || (view === 'live' && item.id === 'earth')}
                  className={
                    view === item.id || (view === 'live' && item.id === 'earth') ? 'active' : ''
                  }
                  onClick={() => setView(item.id)}
                >
                  {item.label}
                </button>
              ))}
              {(view === 'earth' || view === 'live') && (
                <div className="earth-mode-toggle" role="group" aria-label="Earth simulation mode">
                  <button aria-pressed={view === 'earth'} onClick={() => setView('earth')}>
                    Replay
                  </button>
                  <button aria-pressed={view === 'live'} onClick={() => setView('live')}>
                    Live{live.active ? ' ●' : ''}
                  </button>
                </div>
              )}
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
                    coverageScenario={mission.snapshot?.scenario ?? null}
                    sampleIndex={index}
                    displayTime={displayTime}
                    asset={assets.variants[selectedVariant]}
                    variant={selectedVariant}
                  />
                ) : view === 'live' ? (
                  <LiveWorkspace
                    live={live}
                    config={scenario}
                    assets={assets}
                    busy={busy || mission.loading || mission.importing}
                    layout={{
                      compact,
                      panelWidth: actualPanelWidth,
                      panelMax,
                      sceneFraction,
                      onPanelWidth: setPanelWidth,
                      onSceneFraction: setSceneFraction,
                    }}
                    onPreset={mission.loadPreset}
                    onOpenResults={async (file) => {
                      const ok = await mission.openArchive(file);
                      if (ok) setView('results');
                      return ok;
                    }}
                  />
                ) : view === 'results' ? (
                  <ResultsWorkspace
                    snapshot={snapshot}
                    baseline={baseline}
                    cursorTime={time}
                    onScrub={scrub}
                    timeRange={timeRange}
                    onTimeRangeChange={changeTimeRange}
                    onFocusRange={focusRange}
                    liveReport={busy ? mission.run?.progress?.reporting : undefined}
                    actions={
                      <>
                        <button className="text-button" onClick={() => setInspector(true)}>
                          Inputs ↗
                        </button>
                        <button
                          className="text-button"
                          disabled={!snapshot}
                          onClick={() => setBaseline(baseline ? null : snapshot)}
                        >
                          {baseline ? 'Clear comparison' : 'Pin comparison'}
                        </button>
                        <MissionArchiveControls mission={mission} />
                      </>
                    }
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
                ) : independentStudy === 'gnc' ? (
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
                ) : independentStudy ? (
                  <PowerLab
                    session={powerSession}
                    onSession={setPowerSession}
                    inspectorTarget={systemsInspector}
                    asset={
                      independentStudy === 'thermal' && cutawayAsset?.available
                        ? cutawayAsset
                        : modelAsset
                    }
                    variant={modelVariant}
                    cutaway={
                      independentStudy === 'thermal' && cutawayAsset?.available ? true : cutaway
                    }
                    starTrackerVisible={starTrackerVisible}
                    moduleVisibility={renderModules}
                    section={independentStudy}
                  />
                ) : (
                  <Workbench
                    variant={modelVariant}
                    asset={modelAsset}
                    preview={cutaway ? 'cutaway' : 'exterior'}
                    starTrackerVisible={starTrackerVisible}
                    moduleVisibility={renderModules}
                    onAvailableModules={setAvailableModules}
                    onThermalNodePick={
                      spacecraftSection === 'thermal' ? setThermalNodeId : undefined
                    }
                    thermalTemperaturesK={
                      spacecraftSection === 'thermal' && samples?.thermal
                        ? missionTemperatures
                        : undefined
                    }
                    quaternion={
                      followsMission ? samples?.q_body_from_inertial_wxyz[index] : undefined
                    }
                    displayTime={followsMission ? displayTime : undefined}
                    quaternionTimes={followsMission ? times : undefined}
                    quaternionHistory={
                      followsMission ? samples?.q_body_from_inertial_wxyz : undefined
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
                  {receiverMode && !radioIdle && (
                    <span title="Selected receiver mode and modeled lock state at this sample.">
                      <b>
                        {receiverMode.modulation} {receiverMode.code_rate}
                      </b>{' '}
                      · {receiver?.receiver_state[index].toUpperCase()}
                    </span>
                  )}
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
            <PlotDock
              snapshot={snapshot}
              baseline={baseline}
              cursorTime={time}
              onScrub={scrub}
              timeRange={timeRange}
              onTimeRangeChange={changeTimeRange}
              onFocusRange={focusRange}
              liveReport={busy ? mission.run?.progress?.reporting : undefined}
            />
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
                    <div className="speed-presets" role="group" aria-label="Playback speed presets">
                      {[1, 5, 20, 100, 1000].map((value) => (
                        <button
                          key={value}
                          aria-pressed={rate === value}
                          onClick={() => setRate(value)}
                        >
                          {value}×
                        </button>
                      ))}
                    </div>
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
              {view === 'live'
                ? 'LIVE · CONTINUOUS NUMERICAL STATE'
                : view === 'spacecraft'
                  ? independentStudy
                    ? independentStudy === 'gnc'
                      ? 'GNC · INDEPENDENT DYNAMICS STUDY'
                      : `${independentStudy.toUpperCase()} · INDEPENDENT STUDY · ${powerSession.result?.manifest.model_version || 'NOT RUN'}`
                    : spacecraftSection === 'geometry'
                      ? `${cutaway ? 'LAYOUT STUDY' : 'MODEL'} ${modelAsset?.revision || '—'}`
                      : `${mission.snapshot?.imported ? 'IMPORTED RUN' : 'MISSION RUN'} ${displayedId || '—'} · ${times.length} SAMPLES`
                  : view === 'antenna'
                    ? 'ANTENNA REFERENCE'
                    : snapshot
                      ? `${mission.snapshot?.imported ? 'IMPORTED RUN' : 'RUN'} ${displayedId} · ${times.length} SAMPLES · Δt ${snapshot.scenario.step_s} s`
                      : 'NO COMPUTED HISTORY'}
              {(view === 'earth' ||
                view === 'results' ||
                (view === 'spacecraft' && !independentStudy)) &&
              dirty
                ? ' · UNRUN EDITS'
                : ''}
            </span>
            <span>
              {view === 'live'
                ? 'Commands apply at controller boundaries'
                : view === 'earth' || view === 'results'
                  ? mission.snapshot?.scenario.radio_delivery
                    ? 'Assumed receiver · modeled frame payload'
                    : 'Ideal threshold capacity · receiver not modeled'
                  : view === 'antenna'
                    ? 'Analytical patterns · nominal geometry'
                    : independentStudy === 'gnc'
                      ? 'Supplied target and magnetic field · illustrative actuators'
                      : independentStudy
                        ? 'Prescribed CONOPS · provisional thermal inputs'
                        : spacecraftSection !== 'geometry'
                          ? 'Shared orbit, attitude, CONOPS, power and thermal history'
                          : cutaway
                            ? 'Visual layout study'
                            : 'Concept geometry'}
            </span>
          </footer>
        </div>
        {!compact && view !== 'results' && view !== 'live' && (
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
        {view !== 'results' && view !== 'live' && (
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
                <div className="controls-title">
                  <span className="eyebrow">MISSION SPACECRAFT</span>
                  <button className="text-button" onClick={() => setInspector(true)}>
                    Inputs ↗
                  </button>
                  <MissionArchiveControls mission={mission} />
                </div>
                <nav className="spacecraft-sections" aria-label="Spacecraft sections">
                  {(['geometry', 'hardware', 'power', 'thermal', 'gnc'] as const).map((section) => (
                    <button
                      key={section}
                      aria-pressed={!independentStudy && spacecraftSection === section}
                      onClick={() => {
                        setIndependentStudy(null);
                        setSpacecraftSection(section);
                        if (section === 'hardware' && cutawayAsset?.available) changeCutaway(true);
                      }}
                    >
                      {section === 'geometry'
                        ? 'Geometry'
                        : section === 'hardware'
                          ? 'Hardware'
                          : section === 'power'
                            ? 'Power'
                            : section === 'thermal'
                              ? 'Thermal'
                              : 'GNC'}
                    </button>
                  ))}
                </nav>
                {spacecraftSection !== 'power' && (
                  <details className="mission-study-menu" open={!!independentStudy}>
                    <summary>Independent studies</summary>
                    <div className="mission-mode-selector" aria-label="Independent study">
                      {(['thermal', 'gnc'] as const).map((study) => (
                        <button
                          key={study}
                          aria-pressed={independentStudy === study}
                          onClick={() => setIndependentStudy(study)}
                        >
                          {study === 'gnc' ? 'GNC' : study[0].toUpperCase() + study.slice(1)}
                        </button>
                      ))}
                      {independentStudy && (
                        <button onClick={() => setIndependentStudy(null)}>Mission ↩</button>
                      )}
                    </div>
                  </details>
                )}
                {independentStudy ? (
                  <div ref={setSystemsInspector} />
                ) : spacecraftSection !== 'geometry' ? (
                  scenario ? (
                    <>
                      <label className="spacecraft-follow">
                        <input
                          type="checkbox"
                          checked={cutaway}
                          disabled={!cutawayAsset?.available}
                          onChange={(event) => changeCutaway(event.target.checked)}
                        />
                        Cutaway
                      </label>
                      <label
                        className="spacecraft-follow"
                        title="Replay the computed spacecraft orientation at the timeline time. Off holds the inspection pose; plots still follow the timeline."
                      >
                        <input
                          type="checkbox"
                          checked={followAttitude}
                          disabled={!snapshot}
                          onChange={(event) => setFollowAttitude(event.target.checked)}
                        />
                        Replay orientation
                      </label>
                      {spacecraftSection === 'power' ? (
                        <MissionPowerControls config={scenario} edit={mission.edit} />
                      ) : spacecraftSection === 'thermal' ? (
                        <MissionThermalControls
                          config={scenario}
                          edit={mission.edit}
                          nodeId={thermalNodeId}
                          onNodeChange={setThermalNodeId}
                        />
                      ) : spacecraftSection === 'gnc' ? (
                        <MissionGncControls
                          config={scenario}
                          edit={mission.edit}
                          samples={samples}
                          sampleIndex={index}
                        />
                      ) : (
                        <MissionHardware
                          config={scenario}
                          edit={mission.edit}
                          onAntennaVariant={setPreviewVariant}
                        />
                      )}
                      <div className="mission-run-actions">
                        <Field
                          label="Mission duration"
                          unit="h"
                          value={scenario.duration_s / 3600}
                          min={1 / 3}
                          max={720}
                          step={1}
                          onChange={(v) =>
                            mission.edit((d) => {
                              if (v > 168) d.run_kind = 'long_mission';
                              setMissionDuration(d, v * 3600);
                            })
                          }
                        />
                        <button
                          className="primary"
                          title="Use these shared inputs for the next mission run. Displayed history stays unchanged."
                          onClick={() => setView('earth')}
                        >
                          Update on Earth <span>↗</span>
                        </button>
                        {dirty && (
                          <span className="eyebrow">UNRUN EDITS · displayed history retained</span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="offline-note">
                      {mission.loading ? 'Loading mission' : 'Mission unavailable'}
                    </div>
                  )
                ) : (
                  <SpacecraftInspector
                    variant={modelVariant}
                    asset={modelAsset}
                    cutaway={cutaway}
                    onCutaway={changeCutaway}
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
                sampleIndex={index}
                catalog={catalog}
                onRun={startMission}
                onInspect={() => setInspector(true)}
                canPin={!!snapshot}
                hasBaseline={!!baseline}
                onPin={() => setBaseline(baseline ? null : snapshot)}
              />
            )}
          </aside>
        )}
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
                        ...(mission.snapshot?.imported
                          ? { import: mission.snapshot.imported }
                          : {}),
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
