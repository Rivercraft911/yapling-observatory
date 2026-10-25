import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import type { Assets, Direction, RunSnapshot, Variant } from './types';
import { AngularCut } from './antenna/AngularCut';
import { LobeView } from './antenna/LobeView';
import {
  downloadProfile,
  FieldModelDetails,
  profileEvidenceLabel,
} from './antenna/FieldModelDetails';
import type {
  AntennaCatalog,
  AntennaModel,
  Pattern,
  PatternRequest,
  Probe,
  RadiusMode,
  SphericalHarmonicProfile,
} from './antenna/types';
import './antenna.css';

const labels: Record<AntennaModel, string> = {
  dipole: 'Half-wave dipole',
  turnstile: 'Quadrature turnstile',
  patch: 'Cosine patch surrogate',
  spherical_harmonic: 'Spherical harmonics',
  v45: 'Installed V / tape · unresolved',
  bent_v_up_45: 'Upward V tape · assumed current',
  bent_v_out_45: 'Outward V tape · assumed current',
};
const MIN_PATCH_GAIN = 10 * Math.log10(2),
  MAX_PATCH_GAIN = 20;
const ZERO_ANGLES: [number, number, number] = [0, 0, 0];
const value = (number: number | null | undefined, digits = 2) =>
  number == null || !Number.isFinite(number) ? '—' : number.toFixed(digits);

export function AntennaLab({
  snapshot,
  sampleIndex,
  inspectorTarget,
  assets,
  onFollowRunChange,
  onUseProfile,
}: {
  snapshot: RunSnapshot | null;
  sampleIndex: number;
  inspectorTarget?: HTMLElement | null;
  assets?: Assets;
  onFollowRunChange?: (following: boolean) => void;
  onUseProfile?: (
    direction: Direction,
    profile: SphericalHarmonicProfile,
    orientationDeg: [number, number, number],
  ) => void;
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
  const [catalog, setCatalog] = useState<AntennaCatalog | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<SphericalHarmonicProfile | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [appliedTo, setAppliedTo] = useState<Direction | null>(null);
  const [runReferenceResult, setRunReference] = useState<{
    key: string;
    value: PatternRequest;
  } | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
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
  const runReferenceKey = JSON.stringify({
    link: runLink,
    antenna_variant: snapshot?.scenario.antenna_variant || 'dipole',
  });
  const runReference =
    runReferenceResult?.key === runReferenceKey ? runReferenceResult.value : null;
  const model: AntennaModel =
    source === 'run'
      ? runLink?.spacecraft_antenna === 'spherical_harmonic'
        ? 'spherical_harmonic'
        : runLink?.spacecraft_antenna === 'patch'
          ? 'patch'
          : snapshot?.scenario.antenna_variant || 'dipole'
      : source;
  const harmonic = model === 'spherical_harmonic';
  const harmonicProfile =
    source === 'run' ? runLink?.spherical_harmonic_profile || null : selectedProfile;
  const mountAngles: [number, number, number] =
    source === 'run' ? runLink?.antenna_orientation_deg || ZERO_ANGLES : angles;
  const bentTape = model === 'bent_v_up_45' || model === 'bent_v_out_45';
  const physicalVariant: Variant =
    model === 'patch' || harmonic
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
    const abort = new AbortController();
    api<AntennaCatalog>('/api/antenna-lab/catalog', { signal: abort.signal })
      .then((result) => {
        setCatalog(result);
        setSelectedProfile((previous) => previous || result.examples?.[0]?.profile || null);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError')
          setImportError(cause.message || 'Reference profiles unavailable');
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (source !== 'run' || !runLink) return;
    const abort = new AbortController();
    let active = true;
    setReferenceLoading(true);
    setError('');
    api<PatternRequest>('/api/antenna-lab/reference-request', {
      method: 'POST',
      body: runReferenceKey,
      signal: abort.signal,
    })
      .then((result) => {
        if (active) setRunReference({ key: runReferenceKey, value: result });
      })
      .catch((cause) => {
        if (active && cause.name !== 'AbortError')
          setError(cause.message || 'Run antenna unavailable');
      })
      .finally(() => {
        if (active) setReferenceLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
      setReferenceLoading(false);
    };
  }, [source, runReferenceKey, retry]);
  const shape = useMemo(
    () =>
      source === 'run'
        ? runReference
        : harmonic && !harmonicProfile
          ? null
          : {
              model,
              efficiency: harmonic ? 1 : efficiency,
              frequency_hz: harmonic ? harmonicProfile!.frequency_hz : frequencyMHz * 1e6,
              arm_length_m: armLengthMm / 1000,
              patch_peak_gain_dbi: patchGain,
              orientation_deg: mountAngles,
              cut_azimuth_deg: model === 'patch' ? 90 : 0,
              ...(harmonic ? { spherical_harmonic_profile: harmonicProfile } : {}),
            },
    [
      source,
      runReference,
      model,
      harmonic,
      harmonicProfile,
      efficiency,
      patchGain,
      mountAngles,
      frequencyMHz,
      armLengthMm,
    ],
  );
  const shapeKey = JSON.stringify(shape);
  useEffect(() => setAppliedTo(null), [shapeKey]);
  const pattern = patternResult?.key === shapeKey ? patternResult.value : null;
  useEffect(() => {
    if (!shape) {
      setLoading(false);
      return;
    }
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
  const probeRequest = useMemo(
    () =>
      shape
        ? {
            ...shape,
            probe_azimuth_deg: azimuth,
            probe_elevation_deg: elevation,
            linear_feed_roll_deg: feedRoll,
            run_probe: runProbe,
          }
        : null,
    [shape, azimuth, elevation, feedRoll, runProbe],
  );
  const probeKey = JSON.stringify({
    request: probeRequest,
    followed_run: runProbe
      ? {
          id: snapshot?.run.run_id,
          sample_index: sampleIndex,
          time_s: samples?.time_s[sampleIndex],
        }
      : null,
    retry,
  });
  const probe = probeRequest && probeResult?.key === probeKey ? probeResult.value : null;
  useEffect(() => {
    if (!probeRequest) return;
    const abort = new AbortController();
    let active = true;
    const timeout = setTimeout(
      () => {
        lastProbeDispatch.current = performance.now();
        api<Probe>('/api/antenna-lab/probe', {
          method: 'POST',
          body: JSON.stringify(probeRequest),
          signal: abort.signal,
        })
          .then((result) => {
            if (active) setProbe({ key: probeKey, value: result });
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
  }, [probeRequest, probeKey]);
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
  const importProfile = async (file: File) => {
    setImporting(true);
    setImportError('');
    try {
      if (file.size > 256 * 1024) throw new Error('Profile JSON exceeds 256 KiB.');
      const candidate: unknown = JSON.parse(await file.text());
      const frequency =
        candidate && typeof candidate === 'object' && 'frequency_hz' in candidate
          ? candidate.frequency_hz
          : undefined;
      const validated = await api<Pattern>('/api/antenna-lab/pattern', {
        method: 'POST',
        body: JSON.stringify({
          model: 'spherical_harmonic',
          efficiency: 1,
          frequency_hz: frequency,
          spherical_harmonic_profile: candidate,
          orientation_deg: [0, 0, 0],
        }),
      });
      const profile = validated.request?.spherical_harmonic_profile;
      if (validated.model !== 'spherical_harmonic' || !profile)
        throw new Error('Unexpected profile response');
      setSelectedProfile(profile);
      setAngles([0, 0, 0]);
      setSource('spherical_harmonic');
      setAppliedTo(null);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : 'Profile import failed');
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = '';
    }
  };
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
        {harmonic && source !== 'run' && catalog?.examples?.length ? (
          <label className="antenna-field antenna-reference-select">
            Reference
            <select
              aria-label="Harmonic reference profile"
              value={
                catalog.examples.find((item) => item.profile === selectedProfile)?.id || 'imported'
              }
              onChange={(event) => {
                const selected = catalog.examples.find((item) => item.id === event.target.value);
                if (selected) setSelectedProfile(selected.profile);
              }}
            >
              {!catalog.examples.some((item) => item.profile === selectedProfile) ? (
                <option value="imported">Imported profile</option>
              ) : null}
              {catalog.examples.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="antenna-profile-actions">
          <input
            ref={importInput}
            className="antenna-file-input"
            type="file"
            accept="application/json,.json"
            aria-label="Import antenna coefficient JSON"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importProfile(file);
            }}
          />
          <button type="button" disabled={importing} onClick={() => importInput.current?.click()}>
            {importing ? 'Validating…' : 'Import JSON'}
          </button>
          {harmonic && harmonicProfile ? (
            <button type="button" onClick={() => downloadProfile(harmonicProfile)}>
              Download JSON
            </button>
          ) : null}
        </div>
        {importError ? (
          <small className="antenna-import-error" role="alert">
            {importError}
          </small>
        ) : null}
        {harmonic && harmonicProfile ? (
          <>
            <div className="antenna-profile-summary">
              {source === 'run' ? (
                <strong>
                  {catalog?.examples?.find(
                    (item) =>
                      item.profile.name === harmonicProfile.name &&
                      item.profile.revision === harmonicProfile.revision,
                  )?.label || harmonicProfile.name}
                </strong>
              ) : null}
              <span>
                {profileEvidenceLabel(harmonicProfile)} · ℓ ≤ {harmonicProfile.maximum_degree}
              </span>
              <span>
                {harmonicProfile.frequency_hz / 1e6} MHz · η ={' '}
                {harmonicProfile.radiation_efficiency}
              </span>
            </div>
            {onUseProfile ? (
              <div className="antenna-use-profile">
                {(['uplink', 'downlink'] as Direction[]).map((target) => (
                  <button
                    type="button"
                    key={target}
                    disabled={!pattern || loading || importing}
                    title="Set the editable mission antenna and carrier. Run to compute the change."
                    onClick={() => {
                      onUseProfile(target, harmonicProfile, [...mountAngles]);
                      setAppliedTo(target);
                    }}
                  >
                    Use for {target === 'uplink' ? 'UL' : 'DL'}
                  </button>
                ))}
                {appliedTo ? (
                  <small>{appliedTo === 'uplink' ? 'UL' : 'DL'} draft set · run required</small>
                ) : null}
              </div>
            ) : null}
            <FieldModelDetails
              profile={harmonicProfile}
              orientationDeg={mountAngles}
              definition={pattern?.definition}
            />
          </>
        ) : harmonic ? (
          <small className="antenna-geometry-note">
            Select a reference or import coefficient JSON.
          </small>
        ) : null}
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
          Gain lobe
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
        {!harmonic ? (
          <button
            className="antenna-focus-button"
            disabled={!geometryVisible}
            onClick={() => setFocusRequest((previous) => previous + 1)}
          >
            Focus antenna
          </button>
        ) : null}
        <small
          className="antenna-geometry-note"
          title={
            harmonic
              ? 'Generic coefficient profiles use the nominal body origin. Spacecraft geometry supplies visual context; no installation or phase center is inferred.'
              : 'The reference lobe is anchored at the nominal feed or radiator center. This is a display datum, not a measured phase center. Pattern rotation is independent.'
          }
        >
          {harmonic ? 'Body origin · geometry context' : 'Highlighted hardware · pattern origin'}
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
        {!harmonic ? (
          <NumberField
            label="Efficiency"
            value={(source === 'run' ? (runReference?.efficiency ?? 1) : efficiency) * 100}
            unit="%"
            min={0}
            max={100}
            step={1}
            disabled={source === 'run'}
            onChange={(next) => setEfficiency(next / 100)}
          />
        ) : null}
        {model === 'patch' ? (
          <NumberField
            label="Patch peak at η = 1"
            value={source === 'run' ? (runLink?.spacecraft_peak_gain_dbi ?? patchGain) : patchGain}
            unit="dBi"
            min={MIN_PATCH_GAIN}
            max={MAX_PATCH_GAIN}
            step={0.1}
            disabled={source === 'run'}
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
          value={runProbe ? (probe?.azimuth_deg ?? null) : azimuth}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          disabled={!!runProbe}
          onChange={setAzimuth}
        />
        <NumberField
          label="Elevation"
          value={runProbe ? (probe?.elevation_deg ?? null) : elevation}
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
        {probe && probe.linear_coupling == null ? (
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
        <summary>{source === 'run' ? 'Run mount rotation' : 'Reference mount rotation'}</summary>
        <NumberField
          label="Roll · X"
          value={mountAngles[0]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          disabled={source === 'run'}
          onChange={(next) => angleChange(0, next)}
        />
        <NumberField
          label="Pitch · Y"
          value={mountAngles[1]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          disabled={source === 'run'}
          onChange={(next) => angleChange(1, next)}
        />
        <NumberField
          label="Yaw · Z"
          value={mountAngles[2]}
          unit="deg"
          min={-180}
          max={180}
          step={1}
          disabled={source === 'run'}
          onChange={(next) => angleChange(2, next)}
        />
        <small>
          Rz(yaw) Ry(pitch) Rx(roll), native to body.{' '}
          {source === 'run'
            ? 'Uses the completed run mount.'
            : harmonic
              ? 'Use for UL/DL copies the mount to mission inputs.'
              : 'Lab controls do not edit the run.'}
        </small>
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
          <span className="eyebrow">ANTENNA LAB / VECTOR FIELD</span>
          <h1>{pattern?.definition.label || labels[model]}</h1>
        </div>
        <span className="antenna-toolbar-note">
          {harmonic && harmonicProfile
            ? profileEvidenceLabel(harmonicProfile)
            : 'Nominal hardware + analytical reference'}
        </span>
      </header>
      <div className="antenna-main">
        <LobeView
          pattern={pattern}
          probe={probe}
          mode={radiusMode}
          loading={loading || referenceLoading}
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
          {pattern?.status?.replace('_', ' ').toUpperCase() || 'REFERENCE'}
        </span>
        <details>
          <summary>{harmonic ? 'Probe & sampling' : 'Field model'}</summary>
          {!harmonic && pattern?.definition.formula ? (
            <pre className="antenna-formula">{pattern.definition.formula}</pre>
          ) : null}
          <p>{pattern?.definition.limits}</p>
          <p>
            Body azimuth +X toward +Y; elevation above XY. Display and camera use these same axes.
            {source === 'run'
              ? 'Uses the archived antenna, frequency, efficiency and mount.'
              : 'Reference inputs are independent until copied to a mission.'}
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
  value: number | null;
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
          value={current == null ? '' : Number(current.toFixed(3))}
          placeholder="—"
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
