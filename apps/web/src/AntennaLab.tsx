import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import type { Assets, Direction, RunSnapshot, Variant } from './types';
import { AngularCut } from './antenna/AngularCut';
import { LobeView } from './antenna/LobeView';
import type { AntennaModel, Pattern, Probe, RadiusMode } from './antenna/types';
import './antenna.css';

const labels: Record<AntennaModel, string> = {
  dipole: 'Half-wave dipole',
  turnstile: 'Quadrature turnstile',
  patch: 'Cosine patch surrogate',
  v45: 'Installed V / tape · unresolved',
  bent_v_up_45: 'Upward V tape · assumed current',
  bent_v_out_45: 'Outward V tape · assumed current',
};
const MIN_PATCH_GAIN = 10 * Math.log10(2),
  MAX_PATCH_GAIN = 20;
const value = (number: number | null | undefined, digits = 2) =>
  number == null || !Number.isFinite(number) ? '—' : number.toFixed(digits);

export function AntennaLab({
  snapshot,
  sampleIndex,
  inspectorTarget,
  assets,
  onFollowRunChange,
}: {
  snapshot: RunSnapshot | null;
  sampleIndex: number;
  inspectorTarget?: HTMLElement | null;
  assets?: Assets;
  onFollowRunChange?: (following: boolean) => void;
}) {
  const [source, setSource] = useState<'run' | AntennaModel>('run');
  const [direction, setDirection] = useState<Direction>('uplink');
  const [radiusMode, setRadiusMode] = useState<RadiusMode>('db');
  const [geometryVisible, setGeometryVisible] = useState(true);
  const [lobeVisible, setLobeVisible] = useState(true);
  const [lobeOpacity, setLobeOpacity] = useState(0.22);
  const [focusRequest, setFocusRequest] = useState(0);
  const [efficiency, setEfficiency] = useState(1);
  const [frequencyMHz, setFrequencyMHz] = useState(438);
  const [armLengthMm, setArmLengthMm] = useState(171.1144166667);
  const [patchGain, setPatchGain] = useState(6);
  const [angles, setAngles] = useState<[number, number, number]>([0, 0, 0]);
  const [azimuth, setAzimuth] = useState(90),
    [elevation, setElevation] = useState(0),
    [feedRoll, setFeedRoll] = useState(0);
  const [followLos, setFollowLos] = useState(false);
  const [patternResult, setPattern] = useState<{ key: string; value: Pattern } | null>(null),
    [probeResult, setProbe] = useState<{ key: string; value: Probe } | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const lastProbeDispatch = useRef(0);
  const samples = snapshot?.run.result?.samples;
  const runLink = snapshot?.scenario[direction];
  const model: AntennaModel =
    source === 'run'
      ? runLink?.spacecraft_antenna === 'patch'
        ? 'patch'
        : snapshot?.scenario.antenna_variant || 'dipole'
      : source;
  const bentTape = model === 'bent_v_up_45' || model === 'bent_v_out_45';
  const physicalVariant: Variant =
    model === 'patch'
      ? snapshot?.scenario.antenna_variant || 'dipole'
      : bentTape
        ? 'v45'
        : (model as Variant);
  const physicalAsset =
    model === 'bent_v_out_45'
      ? assets?.previews?.v45_outward || {
          revision: 'unavailable',
          available: false,
          url: '/api/assets/previews/v45_outward.glb',
        }
      : assets?.variants[physicalVariant];
  useEffect(() => {
    if (source === 'run' && runLink?.spacecraft_antenna === 'patch')
      setPatchGain(
        Math.max(MIN_PATCH_GAIN, Math.min(MAX_PATCH_GAIN, runLink.spacecraft_peak_gain_dbi)),
      );
  }, [source, runLink?.spacecraft_antenna, runLink?.spacecraft_peak_gain_dbi]);
  const shape = useMemo(
    () => ({
      model,
      efficiency,
      frequency_hz: frequencyMHz * 1e6,
      arm_length_m: armLengthMm / 1000,
      patch_peak_gain_dbi: patchGain,
      orientation_deg: angles,
      cut_azimuth_deg: model === 'patch' ? 90 : 0,
    }),
    [model, efficiency, patchGain, angles, frequencyMHz, armLengthMm],
  );
  const shapeKey = JSON.stringify(shape);
  const pattern = patternResult?.key === shapeKey ? patternResult.value : null;
  const probe = probeResult?.key === shapeKey ? probeResult.value : null;
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    const timeout = setTimeout(() => {
      api<Pattern>('/api/antenna-lab/pattern', {
        method: 'POST',
        body: JSON.stringify(shape),
        signal: abort.signal,
      })
        .then((result) => {
          if (active) setPattern({ key: shapeKey, value: result });
        })
        .catch((cause) => {
          if (active && cause.name !== 'AbortError')
            setError(cause.message || 'Pattern unavailable');
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [shape, retry]);
  const runProbe = useMemo(() => {
    if (!followLos || !samples) return null;
    const i = Math.max(0, Math.min(sampleIndex, samples.time_s.length - 1));
    const spacecraft = samples.satellite_position_m[i],
      station = samples.station_position_m[i],
      quaternion = samples.q_body_from_inertial_wxyz[i];
    return spacecraft && station && quaternion
      ? {
          spacecraft_position_m: spacecraft,
          station_position_m: station,
          q_body_from_inertial_wxyz: quaternion,
        }
      : null;
  }, [followLos, samples, sampleIndex]);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(
      () => {
        lastProbeDispatch.current = performance.now();
        api<Probe>('/api/antenna-lab/probe', {
          method: 'POST',
          body: JSON.stringify({
            ...shape,
            probe_azimuth_deg: azimuth,
            probe_elevation_deg: elevation,
            linear_feed_roll_deg: feedRoll,
            run_probe: runProbe,
          }),
          signal: abort.signal,
        })
          .then((result) => {
            if (active) setProbe({ key: shapeKey, value: result });
          })
          .catch((cause) => {
            if (active && cause.name !== 'AbortError')
              setError(cause.message || 'Probe unavailable');
          });
      },
      Math.max(0, 75 - (performance.now() - lastProbeDispatch.current)),
    );
    return () => {
      active = false;
      clearTimeout(timeout);
      abort.abort();
    };
  }, [shape, azimuth, elevation, feedRoll, runProbe, retry]);
  useEffect(() => {
    onFollowRunChange?.(runProbe !== null);
    return () => onFollowRunChange?.(false);
  }, [runProbe !== null, onFollowRunChange]);
  const actualCoupling = samples?.[direction].polarization_coupling[sampleIndex];
  const time = samples?.time_s[sampleIndex];
  const angleChange = (index: number, next: number) =>
    setAngles(
      (previous) =>
        previous.map((entry, i) => (i === index ? next : entry)) as [number, number, number],
    );
  const inspector = (
    <aside
      className={`antenna-inspection${inspectorTarget ? ' antenna-inspection-external' : ''}`}
      aria-label="Pattern and probe controls"
    >
      <fieldset>
        <legend>ANTENNA REFERENCE</legend>
        <div className="antenna-model-select">
          <label>
            Model
            <select
              aria-label="Antenna reference model"
              value={source}
              onChange={(event) => setSource(event.target.value as 'run' | AntennaModel)}
            >
              <option value="run">Run antenna</option>
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {source === 'run' ? (
            <select
              aria-label="Run antenna link"
              value={direction}
              onChange={(event) => setDirection(event.target.value as Direction)}
            >
              <option value="uplink">Uplink</option>
              <option value="downlink">Downlink</option>
            </select>
          ) : null}
        </div>
        {bentTape && (
          <>
            <NumberField
              label="Frequency"
              value={frequencyMHz}
              unit="MHz"
              min={1}
              max={10000}
              step={1}
              onChange={setFrequencyMHz}
            />
            <NumberField
              label="Arm length"
              value={armLengthMm}
              unit="mm"
              min={0.1}
              max={10000}
              step={1}
              onChange={setArmLengthMm}
            />
            <small
              className="antenna-geometry-note"
              title="Balanced sinusoidal thin-wire current approximation. No bus, feed gap, matching or finite tape width. The nominal spacecraft mesh retains its authored dimensions."
            >
              Free space · assumed current
            </small>
          </>
        )}
        <label className="antenna-follow">
          <input
            type="checkbox"
            checked={geometryVisible}
            onChange={(event) => setGeometryVisible(event.target.checked)}
          />
          Nominal spacecraft geometry
        </label>
        <label className="antenna-follow">
          <input
            type="checkbox"
            checked={lobeVisible}
            disabled={model === 'v45'}
            onChange={(event) => setLobeVisible(event.target.checked)}
          />
          Analytical lobe
        </label>
        <NumberField
          label="Lobe opacity"
          value={lobeOpacity * 100}
          unit="%"
          min={5}
          max={80}
          step={5}
          onChange={(next) => setLobeOpacity(next / 100)}
        />
        <button
          className="antenna-focus-button"
          disabled={!geometryVisible}
          onClick={() => setFocusRequest((previous) => previous + 1)}
        >
          Focus antenna
        </button>
        <small
          className="antenna-geometry-note"
          title="The reference lobe is anchored at the nominal feed or radiator center. This is a display datum, not a measured phase center. Pattern rotation is independent."
        >
          Highlighted hardware · pattern origin
        </small>
      </fieldset>
      <fieldset>
        <legend>LOBE DISPLAY</legend>
        <label className="antenna-field">
          Radius
          <select
            aria-label="Lobe radius encoding"
            value={radiusMode}
            onChange={(event) => setRadiusMode(event.target.value as RadiusMode)}
          >
            <option value="linear">Linear gain / peak</option>
            <option value="db">Relative dB · −30…0</option>
          </select>
        </label>
        <NumberField
          label="Efficiency"
          value={efficiency * 100}
          unit="%"
          min={0}
          max={100}
          step={1}
          onChange={(next) => setEfficiency(next / 100)}
        />
        {model === 'patch' ? (
          <NumberField
            label="Patch peak at η = 1"
            value={patchGain}
            unit="dBi"
            min={MIN_PATCH_GAIN}
            max={MAX_PATCH_GAIN}
            step={0.1}
            onChange={setPatchGain}
          />
        ) : null}
        <div className="antenna-stat">
          <span>Sampled peak gain</span>
          <b>
            {value(pattern?.peak_gain_dbi)} <small>dBi</small>
          </b>
        </div>
        <div className="antenna-stat">
          <span>Sphere mean gain</span>
          <b>{value(pattern?.sphere_mean_gain, 4)}</b>
        </div>
      </fieldset>
      <fieldset>
        <legend>DIRECTION PROBE</legend>
        <label className="antenna-follow">
          <input
            type="checkbox"
            checked={followLos}
            disabled={!samples}
            onChange={(event) => setFollowLos(event.target.checked)}
          />
          Follow run LOS
          <span title="Changes the body-frame probe direction only. The reference linear analyzer below is separate from the ground-station feed.">
            direction only
          </span>
        </label>
        <NumberField
          label="Azimuth"
          value={runProbe ? (probe?.azimuth_deg ?? azimuth) : azimuth}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          disabled={!!runProbe}
          onChange={setAzimuth}
        />
        <NumberField
          label="Elevation"
          value={runProbe ? (probe?.elevation_deg ?? elevation) : elevation}
          unit="deg"
          min={-90}
          max={90}
          step={1}
          disabled={!!runProbe}
          onChange={setElevation}
        />
        <div
          className="antenna-feed-label"
          title="Reference analyzer starts along increasing body-spherical elevation; positive roll turns toward increasing azimuth. This is not the Durand ground feed."
        >
          Reference linear feed
        </div>
        <NumberField
          label="Feed roll"
          value={feedRoll}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          onChange={setFeedRoll}
        />
        <div className="antenna-stat">
          <span>Probe gain</span>
          <b>
            {value(probe?.gain_dbi)} <small>dBi</small>
          </b>
        </div>
        <div className="antenna-stat">
          <span>Reference coupling</span>
          <b>{value(probe?.linear_coupling, 3)}</b>
        </div>
        {probe?.linear_coupling == null ? (
          <small className="antenna-null">
            Polarization undefined at a field null or unresolved pattern.
          </small>
        ) : null}
        {snapshot && runProbe ? (
          <div className="antenna-run-reference">
            <span>Run {direction} coupling</span>
            <b>{value(actualCoupling, 3)}</b>
            <small>T+ {value(time, 1)} s · actual run feed</small>
          </div>
        ) : null}
      </fieldset>
      <details className="antenna-orientation">
        <summary>Reference mount rotation</summary>
        <NumberField
          label="Roll · X"
          value={angles[0]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          onChange={(next) => angleChange(0, next)}
        />
        <NumberField
          label="Pitch · Y"
          value={angles[1]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          onChange={(next) => angleChange(1, next)}
        />
        <NumberField
          label="Yaw · Z"
          value={angles[2]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          onChange={(next) => angleChange(2, next)}
        />
        <small>Rz(yaw) Ry(pitch) Rx(roll). Lab controls do not edit the run.</small>
      </details>
    </aside>
  );
  return (
    <section
      className={`antenna-lab${inspectorTarget ? ' antenna-lab-external' : ''}`}
      aria-label="Antenna pattern laboratory"
    >
      <header className="antenna-toolbar">
        <div>
          <span className="eyebrow">ANTENNA LAB / FREE-SPACE ANALYTICAL</span>
          <h1>{pattern?.definition.label || labels[model]}</h1>
        </div>
        <span className="antenna-toolbar-note">Nominal hardware + analytical reference</span>
      </header>
      <div className="antenna-main">
        <LobeView
          pattern={pattern}
          probe={probe}
          mode={radiusMode}
          loading={loading}
          variant={physicalVariant}
          asset={physicalAsset}
          model={model}
          geometryVisible={geometryVisible}
          lobeVisible={lobeVisible}
          lobeOpacity={lobeOpacity}
          focusRequest={focusRequest}
        />
        {inspectorTarget ? createPortal(inspector, inspectorTarget) : inspector}
      </div>
      {error ? (
        <div className="antenna-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setRetry((previous) => previous + 1)}>Retry lab</button>
        </div>
      ) : null}
      <div className="antenna-cuts">
        <AngularCut pattern={pattern} kind="azimuth" />
        <AngularCut pattern={pattern} kind="elevation" />
      </div>
      <footer className="antenna-evidence">
        <span>
          {pattern?.definition.axes || 'Core vector pattern'} ·{' '}
          {pattern?.status === 'unresolved' ? 'UNRESOLVED' : 'ANALYTICAL REFERENCE'}
        </span>
        <details>
          <summary>Model, vector field &amp; limits</summary>
          <p>{pattern?.definition.limits}</p>
          <p>
            Body azimuth +X toward +Y; elevation above XY. Display and camera use these same axes.
            The run option selects its antenna family; efficiency and mount controls are independent
            reference inputs.
          </p>
          <p>
            {pattern?.field_convention}. Sphere mean is a finite-grid power check, expected{' '}
            {value(pattern?.expected_sphere_mean_gain, 4)}. Grid {pattern?.grid?.polar_steps ?? 0} ×{' '}
            {pattern?.grid?.azimuth_steps ?? 0} angular intervals; narrow lobes need finer
            convergence checks.
          </p>
          <code>
            {pattern?.source.path} · {pattern?.source.function || 'no vector model'}
          </code>
          <p className="antenna-complex">
            Probe F ={' '}
            {probe?.field_real
              ? probe.field_real
                  .map(
                    (real, i) =>
                      `${value(real, 3)} ${probe.field_imag![i] < 0 ? '−' : '+'} j${value(Math.abs(probe.field_imag![i]), 3)}`,
                  )
                  .join(' ; ')
              : 'undefined'}{' '}
            [X; Y; Z]
          </p>
          <small>
            {pattern?.model_version} · pattern {pattern?.identity.slice(0, 12)} · run{' '}
            {snapshot?.run.run_id.slice(0, 8) || 'none'}
          </small>
        </details>
      </footer>
    </section>
  );
}

function NumberField({
  label,
  value: current,
  unit,
  min,
  max,
  step,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <label className="antenna-field">
      <span>{label}</span>
      <span className="antenna-number">
        <input
          type="number"
          aria-label={label}
          value={Number(current.toFixed(3))}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
          }}
        />
        <small>{unit}</small>
      </span>
    </label>
  );
}
