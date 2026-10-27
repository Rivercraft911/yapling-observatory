import { useEffect, useRef, useState } from 'react';
import { api, APIError, cloneScenario } from '../api';
import { FieldModelDetails, profileEvidenceLabel } from '../antenna/FieldModelDetails';
import type { SphericalHarmonicProfile } from '../antenna/types';
import type { Direction, Radio, RadioCatalog, Variant } from '../types';
export function Field({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
}: {
  label: string;
  unit: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
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
          disabled={disabled}
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
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
interface DishGainEstimate {
  diameter_m: number;
  frequency_hz: number;
  aperture_efficiency: number;
  peak_gain_dbi: number;
  assumptions: string;
  source: { url: string; locator: string };
}

const groundLinkKey = (direction: Direction, link: Radio) => JSON.stringify([direction, link]);

export function GroundDishEstimator({
  direction,
  link,
  onChange,
}: {
  direction: Direction;
  link: Radio;
  onChange: (change: (draft: Radio) => void) => void;
}) {
  const [diameterM, setDiameterM] = useState(1.9);
  const [efficiency, setEfficiency] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<{
    key: string;
    version: number;
    data: DishGainEstimate;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const sourceKey = groundLinkKey(direction, link);
  const currentKey = useRef(sourceKey);
  currentKey.current = sourceKey;
  useEffect(() => {
    setEstimate(null);
    setPending(false);
    setError('');
    return () => {
      version.current++;
      abort.current?.abort();
    };
  }, [sourceKey]);
  const changeDraft = () => {
    version.current++;
    abort.current?.abort();
    setEstimate(null);
    setPending(false);
    setError('');
  };
  const calculate = async () => {
    if (efficiency == null) return;
    const request = ++version.current;
    const requestKey = sourceKey;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = () =>
      version.current === request &&
      currentKey.current === requestKey &&
      !controller.signal.aborted;
    setEstimate(null);
    setPending(true);
    setError('');
    try {
      const data = await api<DishGainEstimate>('/api/ground-antennas/dish-gain', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          diameter_m: diameterM,
          frequency_hz: link.frequency_hz,
          aperture_efficiency: efficiency / 100,
        }),
      });
      if (current()) setEstimate({ key: requestKey, version: request, data });
    } catch (cause) {
      if (current())
        setError(
          cause instanceof APIError && cause.status === 404
            ? 'Dish estimate unavailable: this local service needs the current antenna endpoint.'
            : cause instanceof Error
              ? cause.message
              : 'Dish estimate unavailable',
        );
    } finally {
      if (current()) setPending(false);
    }
  };
  const result = estimate?.key === sourceKey ? estimate.data : null;
  const applicable =
    result != null &&
    Number.isFinite(result.peak_gain_dbi) &&
    result.peak_gain_dbi >= -10 &&
    result.peak_gain_dbi <= 70;
  return (
    <details className="mission-details">
      <summary title="User-reported S-band ground dish: 1.9 m. Gain remains independently editable; efficiency and feed/pattern measurements are unresolved.">
        Ground dish · 1.9 m reported
      </summary>
      <Field
        label="Dish diameter"
        unit="m"
        value={diameterM}
        min={0.01}
        max={100}
        step={0.1}
        onChange={(value) => {
          changeDraft();
          setDiameterM(value);
        }}
      />
      <Field
        label="Aperture efficiency · assumed"
        unit="%"
        value={efficiency}
        min={0.01}
        max={100}
        step={1}
        onChange={(value) => {
          changeDraft();
          setEfficiency(value);
        }}
      />
      <button
        className="text-button"
        disabled={pending || efficiency == null}
        onClick={() => void calculate()}
      >
        {pending ? 'Estimating…' : 'Estimate gain'}
      </button>
      {result && (
        <>
          <div className="field-row" title={result.assumptions}>
            <span>Estimated peak</span>
            <output aria-label={`${direction} dish estimate`}>
              {result.peak_gain_dbi.toFixed(2)} dBi
            </output>
          </div>
          <button
            className="text-button"
            disabled={!applicable}
            title="Apply only this estimated gain to this direction. The calculator inputs remain an unsaved local draft; stored link gain stays editable."
            onClick={() => {
              if (!applicable || version.current !== estimate?.version) return;
              onChange((draft) => {
                if (
                  version.current === estimate?.version &&
                  groundLinkKey(direction, draft) === estimate?.key
                )
                  draft.ground_peak_gain_dbi = result.peak_gain_dbi;
              });
            }}
          >
            Apply gain
          </button>{' '}
          <a
            href={result.source.url}
            title={result.source.locator}
            target="_blank"
            rel="noreferrer"
          >
            Equation source
          </a>
          {!applicable && <small>Estimate outside the link gain range.</small>}
        </>
      )}
      {error && <small role="alert">{error}</small>}
    </details>
  );
}

export function AntennaMountControls({
  orientationDeg = [0, 0, 0],
  groundFeedRollDeg,
  onOrientation,
  onGroundFeedRoll,
}: {
  orientationDeg?: [number, number, number];
  groundFeedRollDeg: number;
  onOrientation: (axis: 0 | 1 | 2, value: number) => void;
  onGroundFeedRoll: (value: number) => void;
}) {
  return (
    <details className="mission-details">
      <summary title="Antenna-to-body mount: Rz Ry Rx. Ground feed roll rotates the linear polarization axis.">
        Mount & polarization
      </summary>
      {([0, 1, 2] as const).map((axis) => (
        <Field
          key={axis}
          label={`Mount ${'XYZ'[axis]}`}
          unit="deg"
          value={orientationDeg[axis]}
          min={-360}
          max={360}
          step={1}
          onChange={(value) => onOrientation(axis, value)}
        />
      ))}
      <Field
        label="Ground feed roll"
        unit="deg"
        value={groundFeedRollDeg}
        min={-360}
        max={360}
        step={1}
        onChange={onGroundFeedRoll}
      />
    </details>
  );
}

export function AntennaControls({
  direction,
  link,
  onChange,
  antennaVariant = 'dipole',
  onVariant,
}: {
  direction: Direction;
  link: Radio;
  onChange: (change: (draft: Radio) => void) => void;
  antennaVariant?: Variant;
  onVariant?: (variant: Variant) => void;
}) {
  const [savedProfile, setSavedProfile] = useState<SphericalHarmonicProfile | null>(
    link.spherical_harmonic_profile || null,
  );
  useEffect(() => {
    if (link.spherical_harmonic_profile) setSavedProfile(link.spherical_harmonic_profile);
  }, [link.spherical_harmonic_profile]);
  const coefficientProfile = link.spherical_harmonic_profile || savedProfile;
  const harmonic = link.spacecraft_antenna === 'spherical_harmonic';
  return (
    <>
      <Select
        label="Pattern"
        value={link.spacecraft_antenna}
        options={[
          { value: 'patch', label: 'Cosine patch' },
          { value: 'wire', label: 'Wire surrogate' },
          { value: 'spherical_harmonic', label: 'Harmonics', disabled: !coefficientProfile },
        ]}
        onChange={(value) =>
          onChange((draft) => {
            draft.spacecraft_antenna = value as Radio['spacecraft_antenna'];
            draft.spherical_harmonic_profile =
              value === 'spherical_harmonic' ? coefficientProfile : null;
            if (value === 'spherical_harmonic' && coefficientProfile)
              draft.frequency_hz = coefficientProfile.frequency_hz;
            if (value === 'wire')
              draft.spacecraft_peak_gain_dbi = Math.min(draft.spacecraft_peak_gain_dbi, 2.15);
          })
        }
      />
      {harmonic && link.spherical_harmonic_profile ? (
        <div className="antenna-radio-evidence">
          {profileEvidenceLabel(link.spherical_harmonic_profile)} · ℓ ≤{' '}
          {link.spherical_harmonic_profile.maximum_degree}
        </div>
      ) : null}
      <FieldModelDetails
        profile={harmonic ? link.spherical_harmonic_profile || undefined : undefined}
        model={
          harmonic
            ? 'spherical_harmonic'
            : link.spacecraft_antenna === 'patch'
              ? 'patch'
              : antennaVariant
        }
        orientationDeg={link.antenna_orientation_deg}
      />
      {link.spacecraft_antenna === 'wire' && onVariant && (
        <Select
          label="Wire assembly"
          value={antennaVariant}
          options={[
            { value: 'dipole', label: 'Straight dipole' },
            { value: 'turnstile', label: 'Turnstile' },
            { value: 'v45', label: '45° V / tape · unresolved', disabled: true },
          ]}
          onChange={(value) => onVariant(value as Variant)}
        />
      )}
      {!harmonic ? (
        <Field
          label={link.spacecraft_antenna === 'patch' ? 'Patch peak' : 'Wire peak'}
          unit="dBi"
          value={link.spacecraft_peak_gain_dbi}
          min={-10}
          max={link.spacecraft_antenna === 'patch' ? 30 : 2.15}
          step={0.1}
          onChange={(value) =>
            onChange((draft) => {
              draft.spacecraft_peak_gain_dbi = value;
            })
          }
        />
      ) : null}
      <Field
        label={link.profile.waveform === 'lora' ? 'Ground Yagi gain' : 'Ground dish gain'}
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
      {link.profile.waveform === 'dvb_s2' && (
        <GroundDishEstimator direction={direction} link={link} onChange={onChange} />
      )}
      <AntennaMountControls
        orientationDeg={link.antenna_orientation_deg}
        groundFeedRollDeg={link.ground_feed_roll_deg}
        onOrientation={(axis, value) =>
          onChange((draft) => {
            draft.antenna_orientation_deg ??= [0, 0, 0];
            draft.antenna_orientation_deg[axis] = value;
          })
        }
        onGroundFeedRoll={(value) =>
          onChange((draft) => {
            draft.ground_feed_roll_deg = value;
          })
        }
      />
    </>
  );
}

export function RadioControls({
  direction,
  link,
  catalog,
  onChange,
  antennaVariant = 'dipole',
  fixedReference = false,
}: {
  direction: Direction;
  link: Radio;
  catalog: RadioCatalog;
  onChange: (change: (draft: Radio) => void) => void;
  antennaVariant?: Variant;
  fixedReference?: boolean;
}) {
  const harmonic = link.spacecraft_antenna === 'spherical_harmonic';
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
        label={fixedReference ? 'Fixed reference' : 'Profile'}
        value={preset?.id || 'current'}
        options={options}
        onChange={(id) => {
          const selected = catalog.presets.find((item) => item.id === id);
          if (selected)
            onChange((draft) => {
              draft.frequency_hz = selected.frequency_hz;
              draft.spacecraft_antenna = selected.spacecraft_antenna;
              draft.spherical_harmonic_profile = null;
              draft.antenna_orientation_deg = [0, 0, 0];
              draft.spacecraft_peak_gain_dbi = selected.spacecraft_peak_gain_dbi;
              draft.profile = cloneScenario(selected.profile);
              if (selected.ground_peak_gain_dbi != null)
                draft.ground_peak_gain_dbi = selected.ground_peak_gain_dbi;
              if (selected.rx_system_noise_temperature_k != null)
                draft.rx_system_noise_temperature_k = selected.rx_system_noise_temperature_k;
            });
        }}
      />
      <AntennaControls
        direction={direction}
        link={link}
        onChange={onChange}
        antennaVariant={antennaVariant}
      />
      <Field
        label="Carrier"
        unit="MHz"
        value={link.frequency_hz / 1e6}
        min={1.000001}
        max={40000}
        step={0.1}
        disabled={harmonic}
        onChange={(value) =>
          onChange((draft) => {
            draft.frequency_hz = value * 1e6;
          })
        }
      />
      <Field
        label={direction === 'uplink' ? 'Ground TX power' : 'Spacecraft TX power'}
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
          disabled={link.profile.channel_bandwidth_hz != null}
          onChange={(value) =>
            onChange((draft) => {
              draft.profile.symbol_rate_sps = value * 1e6;
              delete draft.profile.channel_bandwidth_hz;
              delete draft.profile.rolloff;
            })
          }
        />
      )}
      <Field
        label={
          fixedReference
            ? link.profile.threshold_metric === 'cn0'
              ? 'Reference C/N₀'
              : 'Reference Es/N₀'
            : link.profile.threshold_metric === 'cn0'
              ? 'C/N₀ threshold'
              : 'Es/N₀ threshold'
        }
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
