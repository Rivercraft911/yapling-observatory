import { useEffect, useState } from 'react';
import { cloneScenario } from '../api';
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
export function RadioControls({
  direction,
  link,
  catalog,
  onChange,
  antennaVariant = 'dipole',
}: {
  direction: Direction;
  link: Radio;
  catalog: RadioCatalog;
  onChange: (change: (draft: Radio) => void) => void;
  antennaVariant?: Variant;
}) {
  const [savedProfile, setSavedProfile] = useState<SphericalHarmonicProfile | null>(
    link.spherical_harmonic_profile || null,
  );
  useEffect(() => {
    if (link.spherical_harmonic_profile) setSavedProfile(link.spherical_harmonic_profile);
  }, [link.spherical_harmonic_profile]);
  const harmonic = link.spacecraft_antenna === 'spherical_harmonic';
  const coefficientProfile = link.spherical_harmonic_profile || savedProfile;
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
      {link.spacecraft_antenna === 'patch' ? (
        <Field
          label="Patch peak"
          unit="dBi"
          value={link.spacecraft_peak_gain_dbi}
          min={-10}
          max={30}
          step={0.1}
          onChange={(value) =>
            onChange((draft) => {
              draft.spacecraft_peak_gain_dbi = value;
            })
          }
        />
      ) : null}
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
