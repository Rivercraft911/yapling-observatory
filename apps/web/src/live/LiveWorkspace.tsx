import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { EarthView } from '../EarthView';
import { PaneDivider } from '../Resizer';
import { PlotDock } from '../plots/PlotDock';
import { formatValue } from '../plots/TracePlot';
import { displayBracket } from '../graphics/displayInterpolation';
import type { TimeRange } from '../plots/timeWindow';
import type { Assets } from '../types';
import type { MissionConfig } from '../mission/missionTypes';
import { MissionPresetSelect, type MissionPresetId } from '../mission/MissionPresetSelect';
import { setMissionDuration } from '../mission/missionDuration';
import type { LiveMissionSession } from './useLiveMission';
import { LiveDisplayClock, type LiveDisplayState } from './liveDisplayClock';
import { unloadingStatusLabels } from '../mission/unloadingStatus';
import './live.css';

export function LiveWorkspace({
  live,
  config,
  assets,
  busy,
  onPreset,
  onOpenResults,
  layout,
}: {
  live: LiveMissionSession;
  config: MissionConfig | null;
  assets: Assets;
  busy: boolean;
  onPreset: (preset: MissionPresetId) => Promise<void>;
  onOpenResults: (file: File) => Promise<boolean>;
  layout: {
    compact: boolean;
    panelWidth: number;
    panelMax: number;
    sceneFraction: number;
    onPanelWidth: (value: number) => void;
    onSceneFraction: (value: number) => void;
  };
}) {
  const { session, snapshot } = live;
  const main = useRef<HTMLDivElement>(null);
  const [mainHeight, setMainHeight] = useState(700);
  useEffect(() => {
    if (!main.current) return;
    const observer = new ResizeObserver(() => setMainHeight(main.current?.clientHeight ?? 700));
    observer.observe(main.current);
    return () => observer.disconnect();
  }, []);
  const flexibleHeight = Math.max(320, mainHeight - 43);
  const [speed, setSpeed] = useState(60);
  const [durationH, setDurationH] = useState(24);
  const [opening, setOpening] = useState(false);
  const [localError, setLocalError] = useState('');
  const [target, setTarget] = useState<{ latitude_deg: number; longitude_deg: number } | null>(
    null,
  );
  const [inspectedTime, setInspectedTime] = useState<number | null>(null);
  const [presentationTime, setPresentationTime] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRange | null>(null);
  const displayTime = useRef(0);
  const pickRequest = useRef(0);
  const pickAbort = useRef<AbortController | null>(null);
  const currentSession = useRef({ id: session?.live_id, active: live.active });
  currentSession.current = { id: session?.live_id, active: live.active };
  const times = snapshot?.run.result?.samples.time_s;
  const latest = times?.at(-1) ?? 0;
  const currentTime = Math.max(
    times?.[0] ?? 0,
    Math.min(latest, inspectedTime ?? presentationTime),
  );
  const index = displayBracket(times || [], currentTime)?.lower ?? 0;
  const samples = snapshot?.run.result?.samples;
  const unloadingStatus = samples?.gnc?.unloading_status?.[index];
  const visualClock = useRef(new LiveDisplayClock());
  const nextVisualState: LiveDisplayState = {
    sessionId: session?.live_id ?? snapshot?.run.run_id,
    firstTime: times?.[0] ?? 0,
    latestTime: latest,
    running:
      live.active && session?.status !== 'paused' && !session?.paused && !session?.lease_expired,
    speed: session?.speed ?? 1,
    inspectedTime,
  };
  const visualState = useRef(nextVisualState);
  visualState.current = nextVisualState;
  useLayoutEffect(() => {
    displayTime.current = visualClock.current.advance(
      visualState.current,
      performance.now() / 1000,
    );
    setPresentationTime(displayTime.current);
  }, [
    nextVisualState.sessionId,
    nextVisualState.firstTime,
    nextVisualState.latestTime,
    nextVisualState.running,
    nextVisualState.speed,
    nextVisualState.inspectedTime,
  ]);
  const freshConfig = useMemo(() => {
    if (!config) return null;
    const next = structuredClone(config) as MissionConfig & {
      pointing_commands?: unknown;
      numerical_step_commands?: unknown;
      stop_time_s?: number;
    };
    delete next.pointing_commands;
    delete next.numerical_step_commands;
    delete next.stop_time_s;
    if (durationH > 168) next.run_kind = 'long_mission';
    setMissionDuration(next, durationH * 3600);
    return next;
  }, [config, durationH]);
  useEffect(() => {
    let frame = 0;
    let lastReadout = 0;
    const animate = (now: number) => {
      displayTime.current = visualClock.current.advance(visualState.current, now / 1000);
      if (now - lastReadout >= 100) {
        setPresentationTime(displayTime.current);
        lastReadout = now;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    pickRequest.current += 1;
    pickAbort.current?.abort();
    setInspectedTime(null);
    setTimeRange(null);
    setTarget(null);
    return () => {
      pickRequest.current += 1;
      pickAbort.current?.abort();
    };
  }, [session?.live_id]);
  useEffect(() => {
    if (session) setSpeed(session.speed);
  }, [session?.speed]);
  const unappliedRequests =
    (session?.unapplied_command_ids.length ?? 0) +
    (session?.unapplied_numerical_step_ids?.length ?? 0);
  const commandReady = live.active && session?.status !== 'stopping' && !live.pending;
  const ack = live.acknowledgments.at(-1)?.command;
  const pickTarget = async (position: number[]) => {
    const own = ++pickRequest.current;
    const liveId = session?.live_id;
    pickAbort.current?.abort();
    const abort = new AbortController();
    pickAbort.current = abort;
    const current = () =>
      own === pickRequest.current &&
      liveId === currentSession.current.id &&
      currentSession.current.active;
    setLocalError('');
    try {
      const value = await api<{ latitude_deg: number; longitude_deg: number }>(
        '/api/live/ground-target',
        {
          method: 'POST',
          body: JSON.stringify({ position_ecef_m: position }),
          signal: abort.signal,
        },
      );
      if (!current()) return;
      if (
        await live.command({
          mode: 'imaging',
          target_latitude_deg: value.latitude_deg,
          target_longitude_deg: value.longitude_deg,
        })
      ) {
        if (current()) setTarget(value);
      }
    } catch (cause) {
      if (current() && !abort.signal.aborted)
        setLocalError(cause instanceof Error ? cause.message : 'Map target unavailable');
    }
  };
  const openResults = async () => {
    if (!session) return;
    setOpening(true);
    setLocalError('');
    try {
      const response = await fetch(`/api/live/${encodeURIComponent(session.live_id)}/archive`);
      if (!response.ok) throw new Error('The completed live archive is unavailable.');
      const bytes = await response.blob();
      await onOpenResults(
        new File([bytes], `live-${session.live_id}.ssi-mission.json`, { type: 'application/json' }),
      );
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Could not open Results');
    } finally {
      setOpening(false);
    }
  };
  return (
    <section
      className="live-workspace"
      aria-label="Live mission"
      style={
        layout.compact
          ? undefined
          : { gridTemplateColumns: `minmax(0,1fr) 7px ${layout.panelWidth}px` }
      }
    >
      <div
        className="live-main"
        ref={main}
        style={{
          gridTemplateRows: `minmax(160px,${layout.sceneFraction}fr) 7px 36px minmax(160px,${1 - layout.sceneFraction}fr)`,
        }}
      >
        <EarthView
          snapshot={snapshot}
          coverageScenario={session?.final_snapshot?.scenario ?? session?.initial_scenario ?? null}
          sampleIndex={index}
          displayTime={displayTime}
          asset={
            assets.variants[
              snapshot?.scenario.antenna_variant || config?.antenna_variant || 'dipole'
            ]
          }
          variant={snapshot?.scenario.antenna_variant || config?.antenna_variant}
          onGroundTarget={commandReady ? (position) => void pickTarget(position) : undefined}
        />
        <PaneDivider
          orientation="horizontal"
          label="Resize live Earth and charts"
          value={flexibleHeight * layout.sceneFraction}
          min={flexibleHeight * 0.2}
          max={flexibleHeight * 0.8}
          onChange={(pixels) => layout.onSceneFraction(pixels / flexibleHeight)}
          onReset={() => layout.onSceneFraction(0.56)}
        />
        <div className="live-strip">
          <span className={`live-status ${live.active ? 'active' : ''}`}>
            {session?.status.toUpperCase() ||
              (live.restoring ? 'RECONNECTING' : snapshot ? 'DISCONNECTED PREFIX' : 'READY')}
          </span>
          <span>{samples?.mode?.[index]?.replaceAll('_', ' ') || 'Shared mission inputs'}</span>
          <span>
            T+ <b>{currentTime.toFixed(1)}</b> s
          </span>
          <button
            aria-pressed={inspectedTime === null}
            onClick={() => setInspectedTime(null)}
            title="Follow returned telemetry with a 1.5–3 s receipt buffer. Readouts and plots follow the displayed time; no future states are predicted."
          >
            Now
          </button>
          <span title="Pointing error from the current returned numerical state.">
            θ <b>{formatValue(samples?.attitude_angle_deg?.[index])}°</b>
          </span>
          <span
            aria-label="Simulated wheel unloading"
            title="Returned unloading status at the displayed sample. Active controller does not imply nonzero achieved torque; inspect the unloading torque plot."
          >
            Unloading{' '}
            <b>{unloadingStatus ? unloadingStatusLabels[unloadingStatus] : 'Unavailable'}</b>
          </span>
        </div>
        <PlotDock
          snapshot={snapshot}
          baseline={null}
          cursorTime={currentTime}
          onScrub={setInspectedTime}
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          showReportTab={false}
        />
      </div>
      {!layout.compact && (
        <PaneDivider
          orientation="vertical"
          reverse
          label="Resize live controls"
          value={layout.panelWidth}
          min={240}
          max={layout.panelMax}
          onChange={layout.onPanelWidth}
          onReset={() => layout.onPanelWidth(310)}
        />
      )}
      <aside className="live-controls" aria-label="Live controls">
        <div className="controls-title">
          <span className="eyebrow">LIVE MISSION</span>
        </div>
        <strong className="live-scenario-name">
          {live.active ? session?.initial_scenario.name : config?.name || 'Loading mission'}
        </strong>
        {live.error || localError ? (
          <div className="live-error" role="alert">
            {live.error || localError}
            <button
              onClick={() => {
                live.clearError();
                setLocalError('');
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {!live.active && (
          <>
            <MissionPresetSelect onSelect={onPreset} disabled={busy || live.pending} />
            <label className="live-field">
              Duration{' '}
              <span>
                <input
                  aria-label="Live duration hours"
                  type="number"
                  min={1 / 3}
                  max={720}
                  step={1}
                  value={durationH}
                  onChange={(e) => setDurationH(Number(e.target.value))}
                />{' '}
                h
              </span>
            </label>
            <small className="live-note">Keeps flying until the selected duration or Finish.</small>
          </>
        )}
        <label className="live-field">
          Speed <output>{Math.round(speed)}×</output>
          <input
            aria-label="Live speed"
            aria-valuetext={`${Math.round(speed)} times real time`}
            type="range"
            min={0}
            max={1000}
            value={(1000 * Math.log(speed)) / Math.log(1000)}
            onChange={(e) => setSpeed(Math.round(1000 ** (Number(e.target.value) / 1000)))}
            onPointerUp={() => {
              if (live.active) void live.control({ speed });
            }}
            onKeyUp={() => {
              if (live.active) void live.control({ speed });
            }}
          />
        </label>
        {session?.numerical_step_options && (
          <label
            className="live-field"
            title="Changes the integration timestep at a compatible controller boundary. Wall speed is independent; every accepted change is recorded for replay."
          >
            Integration step
            <select
              aria-label="Live integration timestep"
              value={session.numerical_step_s ?? session.initial_scenario.clocks.dynamics_step_s}
              disabled={
                !live.active ||
                live.pending ||
                !!session.pending_numerical_steps ||
                session.status === 'stopping'
              }
              onChange={(event) => void live.numerics(Number(event.target.value))}
            >
              {session.numerical_step_options.map((option) => (
                <option
                  key={option.dynamics_step_s}
                  value={option.dynamics_step_s}
                  disabled={!option.allowed}
                  title={option.reason || undefined}
                >
                  {option.dynamics_step_s} s{option.allowed ? '' : ' · incompatible'}
                </option>
              ))}
            </select>
            {!!session.pending_numerical_steps && <small>Queued</small>}
          </label>
        )}
        {live.numericalAcknowledgments?.length ? (
          <small className="live-note">
            Step accepted at T+
            {live.numericalAcknowledgments.at(-1)!.command.effective_time_s.toFixed(2)} s
          </small>
        ) : null}
        <div className="live-speed-presets">
          {[1, 10, 100, 1000].map((value) => (
            <button
              key={value}
              disabled={live.pending}
              onClick={() => {
                setSpeed(value);
                if (live.active) void live.control({ speed: value });
              }}
            >
              {value}×
            </button>
          ))}
        </div>
        {live.active ? (
          <div className="live-actions">
            <button
              className="primary"
              disabled={live.pending || session?.status === 'stopping'}
              onClick={() => void live.control({ paused: !session?.paused })}
            >
              {session?.paused ? 'Resume' : 'Pause'}
            </button>
            <button
              disabled={live.pending || session?.status === 'stopping'}
              onClick={() => void live.control({ stop: true })}
            >
              Finish & keep results
            </button>
          </div>
        ) : (
          <button
            className="primary"
            disabled={
              !freshConfig ||
              live.restoring ||
              busy ||
              live.pending ||
              !Number.isFinite(durationH) ||
              durationH < 1 / 3 ||
              durationH > 720
            }
            onClick={() => {
              if (freshConfig) void live.start(freshConfig, speed);
            }}
          >
            Start live <span>▶</span>
          </button>
        )}
        {session?.status === 'complete' && (
          <button disabled={opening || busy} onClick={() => void openResults()}>
            {opening ? 'Opening…' : 'Open in Results ↗'}
          </button>
        )}
        {session?.lease_expired && (
          <p className="live-note">Paused after the browser disconnected. Resume when ready.</p>
        )}
        {live.historyGap && (
          <p className="live-note">
            Some streamed history expired. The completed archive retains its scheduled samples.
          </p>
        )}
        {!!unappliedRequests && (
          <p className="live-note">
            {unappliedRequests} requests were not applied before this session ended.
          </p>
        )}
        <div className="live-command-heading">
          <span className="eyebrow">POINTING</span>
          <small>{session?.pending_commands ? `${session.pending_commands} queued` : ''}</small>
        </div>
        <div className="live-modes">
          {[
            ['auto', 'Auto CONOPS'],
            ['sun_pointing', 'Sun'],
            ['ground_tracking', 'Ground station'],
          ].map(([mode, label]) => (
            <button
              key={mode}
              disabled={!commandReady}
              aria-pressed={ack?.mode === mode}
              onClick={() =>
                void live.command({ mode: mode as 'auto' | 'sun_pointing' | 'ground_tracking' })
              }
            >
              {label}
            </button>
          ))}
        </div>
        <small className="live-note">
          Use Pick target on Earth for imaging. The RF station stays at Durand.
        </small>
        {target && (
          <span className="live-target">
            Requested {target.latitude_deg.toFixed(3)}°, {target.longitude_deg.toFixed(3)}°
          </span>
        )}
        {ack && (
          <span className="live-command-ack">
            {ack.mode.replaceAll('_', ' ')} · accepted T+{ack.effective_time_s.toFixed(1)} s
          </span>
        )}
        <details className="live-details">
          <summary>Session details</summary>
          <dl>
            <dt>Horizon</dt>
            <dd>{((session?.requested_duration_s ?? durationH * 3600) / 3600).toFixed(2)} h</dd>
            <dt>Computed</dt>
            <dd>{session?.computed_time_s.toFixed(1) ?? '—'} s</dd>
            <dt>Archive cadence</dt>
            <dd>
              {(live.active ? session?.initial_scenario : freshConfig)?.clocks.output_step_s ?? '—'}{' '}
              s
            </dd>
            <dt>Dynamics step</dt>
            <dd>
              {(live.active
                ? (session?.numerical_step_s ?? session?.initial_scenario.clocks.dynamics_step_s)
                : freshConfig?.clocks.dynamics_step_s) ?? '—'}{' '}
              s
            </dd>
          </dl>
          <p>
            Start uses the current spacecraft and orbit inputs. Previous live commands are cleared.
            Edits apply to the next session.
          </p>
          <p>
            Speed controls wall time. Physics clocks stay fixed. Plots use returned samples; the
            camera smooths between them.
          </p>
          {live.active && (
            <button disabled={live.pending} onClick={() => void live.cancel()}>
              Discard session
            </button>
          )}
        </details>
      </aside>
    </section>
  );
}
