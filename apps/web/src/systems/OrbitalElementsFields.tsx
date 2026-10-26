import type { OrbitElementsConfig } from './dynamicsTypes';
import { useEffect, useId, useRef, useState } from 'react';
import './dynamics.css';

export interface SolarNodeControl {
  definition: 'raan' | 'ltan';
  ltanHours: number;
  derivedRaanDeg: number | null;
  derivedLtanHours: number | null;
  pending?: boolean;
  onChange: (next: { definition: 'raan' | 'ltan'; ltanHours: number }) => void;
}

export function OrbitalElementsFields({
  value,
  onChange,
  solarNode,
}: {
  value: OrbitElementsConfig;
  onChange: (nextElements: OrbitElementsConfig) => void;
  solarNode?: SolarNodeControl;
}) {
  const fields = [
    ['semi_major_axis_m', 'a', 'km', 'Semi-major axis, osculating', 1000, 0.001, undefined, 1],
    ['eccentricity', 'e', '', 'Eccentricity, elliptic initial orbit', 1, 0, 0.999999, 0.001],
    ['inclination_deg', 'i', '°', 'Inclination to the inertial equatorial plane', 1, 0, 180, 0.1],
    [
      'raan_deg',
      'Ω',
      '°',
      'Right ascension of ascending node at epoch',
      1,
      undefined,
      undefined,
      0.1,
    ],
    [
      'argument_of_periapsis_deg',
      'ω',
      '°',
      'Argument of periapsis; arbitrary phase reference when e = 0',
      1,
      undefined,
      undefined,
      0.1,
    ],
    [
      'true_anomaly_deg',
      'ν',
      '°',
      'True anomaly at epoch; circular phase is relative to chosen ω',
      1,
      undefined,
      undefined,
      0.1,
    ],
  ] as const;
  return (
    <div className="orbital-fields">
      <div className="orbital-six">
        {fields.map(([key, symbol, unit, name, factor, min, max, step]) => {
          const derived = key === 'raan_deg' && solarNode?.definition === 'ltan';
          const displayed = derived ? solarNode.derivedRaanDeg : value[key] / factor;
          return (
            <label className="orbital-element" key={key} title={name}>
              <span>
                {symbol}
                <small>{unit}</small>
              </span>
              <BufferedInput
                aria-label={name}
                type="number"
                value={displayed == null ? '' : `${Number(displayed.toPrecision(12))}`}
                placeholder="—"
                readOnly={derived}
                min={min}
                max={max}
                step={step}
                validate={(text) => numberError(text, min, max)}
                onCommit={(text) => onChange({ ...value, [key]: Number(text) * factor })}
              />
            </label>
          );
        })}
      </div>
      <label
        className="orbital-epoch"
        title="Initial state epoch in UTC, ISO 8601 with Z or +00:00; LTAN is local mean solar time, not UTC."
      >
        <span>
          Epoch <small>UTC</small>
        </span>
        <BufferedInput
          aria-label="Orbital epoch UTC"
          type="text"
          value={value.epoch_utc}
          validate={(text) =>
            !/(Z|\+00:00)$/.test(text) || !Number.isFinite(Date.parse(text))
              ? 'Use an ISO UTC timestamp with Z or +00:00.'
              : ''
          }
          onCommit={(text) => onChange({ ...value, epoch_utc: text })}
        />
      </label>
      {solarNode && (
        <div className="orbital-solar-node">
          <label title="One authoritative node definition. The backend links Ω and local mean solar time at the entered epoch.">
            <span>Node</span>
            <select
              aria-label="Ascending node definition"
              value={solarNode.definition}
              onChange={(event) =>
                solarNode.onChange({
                  definition: event.target.value as 'raan' | 'ltan',
                  ltanHours: solarNode.ltanHours,
                })
              }
            >
              <option value="raan">Ω</option>
              <option value="ltan">LTAN</option>
            </select>
          </label>
          <label title="Local mean solar time at ascending node, hours at the entered UTC epoch. The epoch mean-Sun model supplies the linked angle.">
            <span>
              LTAN <small>h</small>
            </span>
            <BufferedInput
              aria-label="Local mean solar time at ascending node"
              type="number"
              min={0}
              max={23.999999}
              step={0.25}
              readOnly={solarNode.definition !== 'ltan'}
              value={
                solarNode.definition === 'ltan'
                  ? `${solarNode.ltanHours}`
                  : solarNode.derivedLtanHours == null
                    ? ''
                    : `${Number(solarNode.derivedLtanHours.toFixed(6))}`
              }
              placeholder={solarNode.pending ? '…' : '—'}
              validate={(text) => numberError(text, 0, 23.999999)}
              onCommit={(text) =>
                solarNode.onChange({ definition: 'ltan', ltanHours: Number(text) })
              }
            />
          </label>
          <div className="orbital-terminator">
            <button
              type="button"
              onClick={() => solarNode.onChange({ definition: 'ltan', ltanHours: 18 })}
            >
              Dusk 18h
            </button>
            <button
              type="button"
              onClick={() => solarNode.onChange({ definition: 'ltan', ltanHours: 6 })}
            >
              Dawn 06h
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function numberError(text: string, min?: number, max?: number) {
  if (text.trim() === '' || !Number.isFinite(Number(text))) return 'Enter a finite number.';
  const value = Number(text);
  if (min != null && value < min) return `Minimum ${min}.`;
  if (max != null && value > max) return `Maximum ${max}.`;
  return '';
}

function BufferedInput({
  value,
  onCommit,
  validate,
  ...props
}: {
  value: string;
  onCommit: (text: string) => void;
  validate: (text: string) => string;
  'aria-label': string;
  type: 'text' | 'number';
  placeholder?: string;
  readOnly?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState('');
  const focused = useRef(false),
    dirty = useRef(false);
  const id = useId();
  useEffect(() => {
    if ((!focused.current && !dirty.current) || props.readOnly) {
      setText(value);
      setError('');
    }
  }, [value, props.readOnly]);
  const commit = () => {
    if (props.readOnly || !dirty.current) return;
    const failure = validate(text);
    setError(failure);
    if (!failure) {
      dirty.current = false;
      if (text !== value) onCommit(text);
    }
  };
  return (
    <>
      <input
        {...props}
        value={text}
        aria-invalid={!!error}
        aria-describedby={error ? id : undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(event) => {
          dirty.current = true;
          setText(event.target.value);
          setError('');
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            dirty.current = false;
            setText(value);
            setError('');
          }
        }}
      />
      {error && (
        <small id={id} className="orbital-input-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
