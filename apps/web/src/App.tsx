import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, cloneScenario } from './api';
import type {
  Assets,
  Direction,
  Radio,
  RadioCatalog,
  Run,
  RunSnapshot,
  Scenario,
  Variant,
} from './types';
import { Workbench } from './Workbench';
import { PaneDivider } from './Resizer';
import { closestIndex, formatValue } from './plots/TracePlot';
import { PlotDock } from './plots/PlotDock';
import { SpacecraftInspector } from './spacecraft/SpacecraftInspector';
import { advanceDisplayTime } from './graphics/displayInterpolation';
import type { PowerSession } from './systems/powerTypes';
import './systems/systems.css';
const PowerLab = lazy(() =>
  import('./systems/PowerLab').then((module) => ({ default: module.PowerLab })),
);

const EarthView = lazy(() =>
  import('./EarthView').then((module) => ({ default: module.EarthView })),
);
const AntennaLab = lazy(() =>
  import('./AntennaLab').then((module) => ({ default: module.AntennaLab })),
);
type WorkspaceView = 'earth' | 'spacecraft' | 'antenna';
const workspaceViews: { id: WorkspaceView; label: string }[] = [
  { id: 'earth', label: 'Earth' },
  { id: 'spacecraft', label: 'Spacecraft' },
  { id: 'antenna', label: 'Antenna lab' },
];
const EMPTY: number[] = [];
const variants: { value: Variant; label: string }[] = [
  { value: 'dipole', label: 'Straight dipole' },
  { value: 'turnstile', label: 'Turnstile' },
  { value: 'v45', label: '45° V / tape' },
];
const busyStatuses = new Set(['queued', 'running', 'cancelling']);

export default function App() {
  const [view, setView] = useState<WorkspaceView>('earth');
  const [antennaInspector, setAntennaInspector] = useState<HTMLDivElement | null>(null);
  const [antennaFollowsRun, setAntennaFollowsRun] = useState(false);
  const [previewVariant, setPreviewVariant] = useState<Variant | null>(null);
  const [cutaway, setCutaway] = useState(false);
  const [spacecraftSection, setSpacecraftSection] = useState<'geometry' | 'power' | 'thermal'>(
    'geometry',
  );
  const [powerSession, setPowerSession] = useState<PowerSession>({ config: null, result: null });
  const [systemsInspector, setSystemsInspector] = useState<HTMLDivElement | null>(null);
  const [starTrackerVisible, setStarTrackerVisible] = useState(true);
  const [followAttitude, setFollowAttitude] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [baseline, setBaseline] = useState<RunSnapshot | null>(null);
  const [assets, setAssets] = useState<Assets>({ variants: {} });
  const [catalog, setCatalog] = useState<RadioCatalog>({ presets: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reload, setReload] = useState(0);
  const [index, setIndex] = useState(0);
  const displayTime = useRef(0);
  const displayReadout = useRef<HTMLSpanElement>(null);
  const displayTick = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(60);
  const [panelWidth, setPanelWidth] = useState(() => readLayout().panelWidth);
  const [sceneFraction, setSceneFraction] = useState(() => readLayout().sceneFraction);
  const [layoutSize, setLayoutSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight - 62,
  });
  const workspaceRef = useRef<HTMLElement>(null);
  const instrumentRef = useRef<HTMLDivElement>(null);
  const autoplayNext = useRef(false);
  const compact = layoutSize.width <= 760;
  const panelMax = Math.max(240, Math.min(600, layoutSize.width * 0.45));
  const actualPanelWidth = Math.min(panelMax, Math.max(240, panelWidth));
  const flexibleHeight = Math.max(320, layoutSize.height - 161);
  const sceneHeight = flexibleHeight * sceneFraction;
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
  const [inspector, setInspector] = useState(false);
  const pendingScenario = useRef<Scenario | null>(null);
  const generation = useRef(0);
  const completeId = useRef('');
  const samples = snapshot?.run.result?.samples;
  const times = samples?.time_s || EMPTY;
  const time = times[index] ?? 0;
  const paintDisplayTime = useCallback(
    (value: number) => {
      displayTime.current = value;
      if (displayReadout.current) displayReadout.current.textContent = value.toFixed(1);
      if (displayTick.current)
        displayTick.current.style.left = `${(100 * value) / (times[times.length - 1] || 1)}%`;
    },
    [times],
  );
  const busy = submitting || (!!run && busyStatuses.has(run.status));
  const dirty =
    !!scenario && !!snapshot && JSON.stringify(scenario) !== JSON.stringify(snapshot.scenario);

  const startRun = useCallback(async (input: Scenario, autoplay = true) => {
    autoplayNext.current = autoplay;
    const ticket = ++generation.current;
    setError('');
    setSubmitting(true);
    setPlaying(false);
    pendingScenario.current = cloneScenario(input);
    try {
      const created = await api<Run>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ scenario: input }),
      });
      if (ticket !== generation.current) return;
      setRun({ ...created, result: created.result ?? null, error: created.error ?? null });
    } catch (cause) {
      if (ticket === generation.current)
        setError(cause instanceof Error ? cause.message : 'Run request failed');
    } finally {
      if (ticket === generation.current) setSubmitting(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    api<{ scenario: Scenario }>('/api/scenarios/default', { signal: abort.signal })
      .then((data) => {
        if (!active) return;
        setScenario(data.scenario);
        setLoading(false);
        void startRun(data.scenario, false);
      })
      .catch((cause) => {
        if (active && cause.name !== 'AbortError') {
          setError(cause.message || 'Local service unavailable');
          setLoading(false);
        }
      });
    api<Assets>('/api/assets', { signal: abort.signal })
      .then((data) => {
        if (active) setAssets(data);
      })
      .catch(() => {});
    api<RadioCatalog>('/api/radio-profiles', { signal: abort.signal })
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {});
    return () => {
      active = false;
      abort.abort();
    };
  }, [reload, startRun]);

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const metadata = await api<Assets>('/api/assets', { signal: abort.signal });
        if (active)
          setAssets((previous) =>
            JSON.stringify(previous) === JSON.stringify(metadata) ? previous : metadata,
          );
      } catch {
      } finally {
        if (active) timeout = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!run || !busyStatuses.has(run.status)) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const id = run.run_id;
    async function poll() {
      try {
        const updated = await api<Run>(`/api/runs/${encodeURIComponent(id)}`, {
          signal: abort.signal,
        });
        if (!active) return;
        setRun(updated);
        if (busyStatuses.has(updated.status)) timeout = setTimeout(poll, 400);
      } catch (cause) {
        if (active && cause instanceof Error && cause.name !== 'AbortError') {
          setError(cause.message);
          timeout = setTimeout(poll, 1500);
        }
      }
    }
    timeout = setTimeout(poll, 100);
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timeout);
    };
  }, [run?.run_id, run?.status]);

  useEffect(() => {
    if (
      run?.status === 'complete' &&
      run.result &&
      pendingScenario.current &&
      completeId.current !== run.run_id
    ) {
      completeId.current = run.run_id;
      setSnapshot({ run, scenario: cloneScenario(pendingScenario.current) });
      displayTime.current = run.result.samples.time_s[0] ?? 0;
      setIndex(0);
      setPlaying(autoplayNext.current);
      autoplayNext.current = false;
      setError('');
    }
    if (run?.status === 'failed') setError(run.error || 'Simulation failed');
  }, [run]);

  useEffect(() => {
    if (!playing || times.length < 2) return;
    let animation = 0;
    let previous = performance.now();
    let elapsed = displayTime.current;
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
    // A scrub stops playback; only playback start, rate, or a new immutable history restarts this clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const update = (change: (draft: Scenario) => void) =>
    setScenario((current) => {
      if (!current) return current;
      const next = cloneScenario(current);
      change(next);
      recordEdits(current, next);
      return next;
    });
  const cancel = async () => {
    if (!run) return;
    autoplayNext.current = false;
    try {
      const cancelled = await api<Run>(`/api/runs/${encodeURIComponent(run.run_id)}`, {
        method: 'DELETE',
      });
      setRun(cancelled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancellation failed');
    }
  };
  const segments = useMemo(() => {
    if (!samples?.time_s.length) return [];
    const result: { start: number; end: number; direction: Direction }[] = [];
    samples.active_direction.forEach((direction, i) => {
      const t = samples.time_s[i];
      const last = result[result.length - 1];
      if (last?.direction === direction) last.end = t;
      else result.push({ start: t, end: t, direction });
    });
    return result;
  }, [samples]);
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
      ? spacecraftSection === 'geometry' && followAttitude
      : antennaFollowsRun);
  const status = busy
    ? submitting
      ? 'Submitting'
      : run?.status || 'Running'
    : run?.status || 'Offline';
  const currentDirection = samples?.active_direction[index];
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
            ? 'ANALYTICAL EXAMPLE'
            : view === 'spacecraft'
              ? spacecraftSection === 'geometry'
                ? 'MODEL PREVIEW'
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
            <button onClick={() => setReload((n) => n + 1)}>Reconnect</button>
          ) : (
            <button onClick={() => setError('')}>Dismiss</button>
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
                  />
                ) : spacecraftSection !== 'geometry' ? (
                  <PowerLab
                    session={powerSession}
                    onSession={setPowerSession}
                    inspectorTarget={systemsInspector}
                    asset={modelAsset}
                    variant={modelVariant}
                    cutaway={cutaway}
                    starTrackerVisible={starTrackerVisible}
                    section={spacecraftSection}
                  />
                ) : (
                  <Workbench
                    variant={modelVariant}
                    asset={modelAsset}
                    preview={cutaway ? 'cutaway' : 'exterior'}
                    starTrackerVisible={starTrackerVisible}
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
                    className={currentDirection === 'uplink' ? 'uplink-color' : 'downlink-color'}
                  >
                    {currentDirection === 'uplink'
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
                  <span className="eyebrow">CONOPS / ALTERNATING</span>
                  <div className="direction-key">
                    <span className="uplink-color">UL</span>
                    <span className="downlink-color">DL</span>
                  </div>
                </div>
                <div className="timeline-track">
                  <div className="operation-segments">
                    {segments.map((segment, i) => (
                      <span
                        key={i}
                        className={segment.direction}
                        style={{
                          left: `${(segment.start / lastTime) * 100}%`,
                          width: `${Math.max(0.1, ((segment.end - segment.start + (snapshot?.scenario.step_s || 0)) / lastTime) * 100)}%`,
                        }}
                        title={`${segment.direction} · ${segment.start.toFixed(0)}–${segment.end.toFixed(0)} s`}
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
                ? spacecraftSection === 'geometry'
                  ? `${cutaway ? 'LAYOUT STUDY' : 'MODEL'} ${modelAsset?.revision || '—'}`
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
                  : spacecraftSection !== 'geometry'
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
                {(['geometry', 'power', 'thermal'] as const).map((section) => (
                  <button
                    key={section}
                    aria-pressed={spacecraftSection === section}
                    onClick={() => setSpacecraftSection(section)}
                  >
                    {section === 'geometry'
                      ? 'Geometry'
                      : section === 'power'
                        ? 'Power & avionics'
                        : 'Thermal'}
                  </button>
                ))}
              </nav>
              {spacecraftSection !== 'geometry' ? (
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
                  onVariant={setPreviewVariant}
                  followAttitude={followAttitude}
                  onFollowAttitude={setFollowAttitude}
                  hasRun={!!samples}
                  onApply={() => {
                    update((draft) => {
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
            <>
              <div className="controls-title">
                <span className="eyebrow">SCENARIO</span>
                <button
                  className="text-button"
                  onClick={() => setInspector(true)}
                  disabled={!scenario}
                  title="Inspect the exact inputs and immutable result manifest"
                >
                  Inspect ↗
                </button>
              </div>
              {loading ? (
                <div className="control-loading">
                  <span className="spinner" />
                  Connecting to local core
                </div>
              ) : scenario ? (
                <>
                  <div className="scenario-name">
                    {scenario.name}
                    {dirty && (
                      <small className="pending-edits">
                        Edits pending · view retains displayed run
                      </small>
                    )}
                  </div>
                  <fieldset>
                    <legend>SPACECRAFT</legend>
                    <Select
                      label="Wire geometry"
                      value={scenario.antenna_variant}
                      onChange={(value) =>
                        update((draft) => {
                          draft.antenna_variant = value as Variant;
                        })
                      }
                      options={variants}
                    />
                    <Select
                      label="Attitude"
                      value={scenario.attitude.mode}
                      onChange={(value) =>
                        update((draft) => {
                          draft.attitude.mode = value as 'tracking' | 'tumble';
                        })
                      }
                      options={[
                        { value: 'tracking', label: 'Station tracking' },
                        { value: 'tumble', label: 'Prescribed tumble' },
                      ]}
                    />
                    {scenario.attitude.mode === 'tumble' ? (
                      <Field
                        label="Spin rate"
                        unit="deg/s"
                        value={scenario.attitude.spin_rate_deg_s}
                        min={0}
                        max={90}
                        step={0.1}
                        onChange={(value) =>
                          update((draft) => {
                            draft.attitude.spin_rate_deg_s = value;
                          })
                        }
                      />
                    ) : (
                      <Field
                        label="Pointing offset"
                        unit="deg"
                        value={scenario.attitude.pointing_error_deg}
                        min={0}
                        max={90}
                        step={1}
                        onChange={(value) =>
                          update((draft) => {
                            draft.attitude.pointing_error_deg = value;
                          })
                        }
                      />
                    )}
                    <Field
                      label="Altitude"
                      unit="km"
                      value={scenario.orbit.altitude_m / 1000}
                      min={160}
                      max={2000}
                      step={10}
                      onChange={(value) =>
                        update((draft) => {
                          draft.orbit.altitude_m = value * 1000;
                        })
                      }
                    />
                  </fieldset>
                  <RadioControls
                    direction="uplink"
                    link={scenario.uplink}
                    catalog={catalog}
                    onChange={(change) => update((draft) => change(draft.uplink))}
                  />
                  <RadioControls
                    direction="downlink"
                    link={scenario.downlink}
                    catalog={catalog}
                    onChange={(change) => update((draft) => change(draft.downlink))}
                  />
                  <fieldset>
                    <legend>
                      GROUND<span>Durand · example</span>
                    </legend>
                    <div className="static-row">
                      <span>S band / dish</span>
                      <b>1.9 m*</b>
                    </div>
                    <div className="static-row">
                      <span>UHF / Yagi</span>
                      <b>15 dBi*</b>
                    </div>
                    <Field
                      label="Elevation mask"
                      unit="deg"
                      value={scenario.station.minimum_elevation_deg}
                      min={0}
                      max={89}
                      step={1}
                      onChange={(value) =>
                        update((draft) => {
                          draft.station.minimum_elevation_deg = value;
                        })
                      }
                    />
                  </fieldset>
                  <fieldset>
                    <legend>RUN</legend>
                    <Field
                      label="Duration"
                      unit="s"
                      value={scenario.duration_s}
                      min={10}
                      max={3600}
                      step={60}
                      onChange={(value) =>
                        update((draft) => {
                          draft.duration_s = value;
                        })
                      }
                    />
                    <Field
                      label="Sample step"
                      unit="s"
                      value={scenario.step_s}
                      min={Math.max(0.05, scenario.duration_s / 7200)}
                      max={30}
                      step={0.05}
                      onChange={(value) =>
                        update((draft) => {
                          draft.step_s = value;
                        })
                      }
                    />
                    <Field
                      label="Direction slot"
                      unit="s"
                      value={scenario.schedule.slot_duration_s}
                      min={1}
                      max={3600}
                      step={5}
                      onChange={(value) =>
                        update((draft) => {
                          draft.schedule.slot_duration_s = value;
                        })
                      }
                    />
                  </fieldset>
                  <div className="run-actions">
                    {busy ? (
                      <button
                        className="primary cancel"
                        onClick={() => void cancel()}
                        disabled={submitting || run?.status === 'cancelling'}
                      >
                        Cancel run
                      </button>
                    ) : (
                      <button className="primary" onClick={() => void startRun(scenario)}>
                        Run scenario <span>↗</span>
                      </button>
                    )}
                    <button
                      disabled={!snapshot || busy}
                      onClick={() => setBaseline(snapshot)}
                      title="Retain this completed result as a dashed comparison"
                    >
                      Pin comparison
                    </button>
                  </div>
                  {baseline && (
                    <div className="comparison-note">
                      <span>
                        – –{' '}
                        {
                          variants.find((item) => item.value === baseline.scenario.antenna_variant)
                            ?.label
                        }
                        <small>{baseline.run.run_id.slice(0, 8)}</small>
                      </span>
                      <button className="text-button" onClick={() => setBaseline(null)}>
                        Clear
                      </button>
                    </div>
                  )}
                  <div className="capacity-totals">
                    <span className="eyebrow">IDEAL CAPACITY</span>
                    {snapshot?.run.result?.summary.capacity_available &&
                      (!snapshot.run.result.summary.capacity_available.uplink ||
                        !snapshot.run.result.summary.capacity_available.downlink) && (
                        <small className="unresolved-note">Receiver / pattern unresolved</small>
                      )}
                    <div>
                      <span className="uplink-color">
                        UL{' '}
                        <b>
                          {formatValue(
                            snapshot?.run.result?.summary.ideal_capacity_bits.uplink == null
                              ? null
                              : snapshot.run.result.summary.ideal_capacity_bits.uplink / 8e6,
                            2,
                          )}
                        </b>{' '}
                        MB
                      </span>
                      <span className="downlink-color">
                        DL{' '}
                        <b>
                          {formatValue(
                            snapshot?.run.result?.summary.ideal_capacity_bits.downlink == null
                              ? null
                              : snapshot.run.result.summary.ideal_capacity_bits.downlink / 8e6,
                            2,
                          )}
                        </b>{' '}
                        MB
                      </span>
                    </div>
                  </div>
                  <div className="provenance-note">
                    Example inputs · analytical models
                    <br />
                    <span>* User-reported station hardware. Survey pending.</span>
                  </div>
                </>
              ) : (
                <div className="offline-note">
                  Local core unavailable.
                  <button onClick={() => setReload((n) => n + 1)}>Reconnect</button>
                </div>
              )}
            </>
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

function Field({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(Number(value.toPrecision(10)))), [value]);
  return (
    <label className="field-row">
      <span>{label}</span>
      <span className="numeric-field">
        <input
          aria-label={label}
          type="number"
          value={text}
          placeholder="—"
          min={min}
          max={max}
          step={step}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => {
            const number = event.currentTarget.valueAsNumber;
            if (Number.isFinite(number) && number >= min && number <= max) onChange(number);
            else setText(value == null ? '' : String(value));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <small>{unit}</small>
      </span>
    </label>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
function formatUtc(epoch: string, elapsed: number) {
  const date = new Date(new Date(epoch).getTime() + elapsed * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(11, 19);
}
function recordEdits(before: Scenario, after: Scenario) {
  const changes: { path: string; previous: unknown }[] = [];
  function walk(left: unknown, right: unknown, path: string) {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (
      left &&
      right &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      Object.keys(right)
        .filter((key) => key !== 'provenance')
        .forEach((key) =>
          walk(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
          ),
        );
    } else changes.push({ path, previous: left });
  }
  walk(before, after, '');
  const prior = before.provenance.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
  );
  after.provenance = [
    ...before.provenance.filter(
      (entry) =>
        !changes.some(
          (change) =>
            entry && typeof entry === 'object' && 'path' in entry && entry.path === change.path,
        ),
    ),
    ...changes.map((change) => {
      const previous = prior.find((entry) => entry.path === change.path);
      return {
        path: change.path,
        status: 'user_input',
        source: 'Local workbench input edit',
        conditions:
          `Previous value: ${JSON.stringify(change.previous)}.${previous ? ` Prior evidence: ${JSON.stringify(previous)}` : ''}`.slice(
            0,
            2000,
          ),
      };
    }),
  ];
}
function RadioControls({
  direction,
  link,
  catalog,
  onChange,
}: {
  direction: Direction;
  link: Radio;
  catalog: RadioCatalog;
  onChange: (change: (draft: Radio) => void) => void;
}) {
  const preset = catalog.presets.find(
    (item) =>
      item.profile.modulation === link.profile.modulation &&
      item.profile.code_rate === link.profile.code_rate &&
      item.profile.waveform === link.profile.waveform,
  );
  const options = catalog.presets.map((item) => ({ value: item.id, label: item.label }));
  if (!preset)
    options.unshift({
      value: 'current',
      label: `${link.profile.modulation} · ${link.profile.code_rate}`,
    });
  return (
    <fieldset>
      <legend>
        <span className={direction === 'uplink' ? 'uplink-color' : 'downlink-color'}>
          {direction.toUpperCase()}
        </span>
        <span>{link.frequency_hz / 1e6} MHz</span>
      </legend>
      <Select
        label="Profile"
        value={preset?.id || 'current'}
        options={options}
        onChange={(id) => {
          const selected = catalog.presets.find((item) => item.id === id);
          if (selected)
            onChange((draft) => {
              draft.frequency_hz = selected.frequency_hz;
              draft.spacecraft_antenna = selected.spacecraft_antenna;
              draft.spacecraft_peak_gain_dbi = selected.spacecraft_peak_gain_dbi;
              draft.profile = cloneScenario(selected.profile);
              if (selected.ground_peak_gain_dbi != null)
                draft.ground_peak_gain_dbi = selected.ground_peak_gain_dbi;
              if (selected.rx_system_noise_temperature_k != null)
                draft.rx_system_noise_temperature_k = selected.rx_system_noise_temperature_k;
            });
        }}
      />
      <Select
        label="Spacecraft feed"
        value={link.spacecraft_antenna}
        options={[
          { value: 'patch', label: 'Patch' },
          { value: 'wire', label: 'Wire surrogate' },
        ]}
        onChange={(value) =>
          onChange((draft) => {
            draft.spacecraft_antenna = value as 'patch' | 'wire';
            if (value === 'wire')
              draft.spacecraft_peak_gain_dbi = Math.min(draft.spacecraft_peak_gain_dbi, 2.15);
          })
        }
      />
      <Field
        label="Carrier"
        unit="MHz"
        value={link.frequency_hz / 1e6}
        min={1.000001}
        max={40000}
        step={0.1}
        onChange={(value) =>
          onChange((draft) => {
            draft.frequency_hz = value * 1e6;
          })
        }
      />
      <Field
        label="Source power"
        unit="W"
        value={link.tx_power_w}
        min={0.0001}
        max={1000}
        step={0.1}
        onChange={(value) =>
          onChange((draft) => {
            draft.tx_power_w = value;
          })
        }
      />
      <Field
        label="Ground gain"
        unit="dBi"
        value={link.ground_peak_gain_dbi}
        min={-10}
        max={70}
        step={0.1}
        onChange={(value) =>
          onChange((draft) => {
            draft.ground_peak_gain_dbi = value;
          })
        }
      />
      {link.profile.waveform === 'lora' ? (
        <Field
          label="Information rate"
          unit="kb/s"
          value={
            link.profile.information_rate_bps == null
              ? null
              : link.profile.information_rate_bps / 1000
          }
          min={0.000001}
          max={100000}
          step={0.1}
          onChange={(value) =>
            onChange((draft) => {
              draft.profile.information_rate_bps = value * 1000;
            })
          }
        />
      ) : (
        <Field
          label="Symbol rate"
          unit="Msym/s"
          value={link.profile.symbol_rate_sps == null ? null : link.profile.symbol_rate_sps / 1e6}
          min={0.000001}
          max={100}
          step={0.1}
          onChange={(value) =>
            onChange((draft) => {
              draft.profile.symbol_rate_sps = value * 1e6;
            })
          }
        />
      )}
      <Field
        label={link.profile.threshold_metric === 'cn0' ? 'C/N₀ threshold' : 'Es/N₀ threshold'}
        unit={link.profile.threshold_metric === 'cn0' ? 'dB Hz' : 'dB'}
        value={link.profile.threshold_db}
        min={-50}
        max={150}
        step={0.1}
        onChange={(value) =>
          onChange((draft) => {
            draft.profile.threshold_db = value;
            draft.profile.threshold_status = 'illustrative';
          })
        }
      />
      <div className="profile-evidence">
        {link.profile.threshold_status === 'unresolved'
          ? 'Threshold unresolved'
          : link.profile.threshold_status === 'ideal_awgn'
            ? 'Ideal AWGN threshold'
            : 'Illustrative threshold'}
      </div>
    </fieldset>
  );
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
