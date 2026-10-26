import { useEffect, useState } from 'react';
import { api, cloneScenario } from '../api';
import { Field, Select } from '../controls/RadioControls';

import type { MissionConfig } from './missionTypes';

export function MissionHardware({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const craft = config.spacecraft;
  const wheelsEnabled = craft.wheels.some((wheel) => wheel.enabled);
  const magneticEnabled = !!craft.magnetorquer?.enabled;
  const magneticAuthority = magneticEnabled && (craft.magnetorquer?.spec.max_dipole_am2 || 0) > 0;
  const unloadingUnavailable =
    !wheelsEnabled && !magneticEnabled
      ? 'Needs wheels + MTQ'
      : !wheelsEnabled
        ? 'Needs wheels'
        : !magneticEnabled
          ? 'Needs MTQ'
          : !magneticAuthority
            ? 'Zero MTQ authority'
            : craft.controller !== 'quaternion_pd'
              ? 'Controller inactive'
              : '';
  const [presets, setPresets] = useState<
    Record<string, Pick<MissionConfig['spacecraft'], 'wheels' | 'magnetorquer'>>
  >({});
  const [wheelEvidence, setWheelEvidence] = useState<{
    sources: { title: string; url: string }[];
    assumptions: string[];
    limits: string[];
  } | null>(null);
  const wheelExample = presets.wheels_and_magnetic?.wheels.map((wheel) => wheel.spec) || [];
  useEffect(() => {
    const abort = new AbortController();
    api<Record<string, Pick<MissionConfig['spacecraft'], 'wheels' | 'magnetorquer'>>>(
      '/api/mission/actuator-presets',
      { signal: abort.signal },
    )
      .then(setPresets)
      .catch(() => {});
    api<{ example: NonNullable<typeof wheelEvidence> }>('/api/mission/wheel-reference', {
      signal: abort.signal,
    })
      .then((data) => setWheelEvidence(data.example))
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return (
    <>
      <Select
        label="Earth field"
        value={config.magnetic_model || 'igrf14_degree1'}
        options={[
          { value: 'igrf14_degree13', label: 'IGRF-14 · degree 13' },
          { value: 'igrf14_degree1', label: 'IGRF-14 · dipole only' },
        ]}
        onChange={(value) =>
          edit((draft) => {
            if (value === 'igrf14_degree1') delete draft.magnetic_model;
            else draft.magnetic_model = 'igrf14_degree13';
          })
        }
      />
      <div className="mission-field-model">
        <span>2025–2030 · internal field</span>
        <a
          href="https://www.ncei.noaa.gov/products/international-geomagnetic-reference-field"
          target="_blank"
          rel="noreferrer"
          title="IGRF-14 internal field, with 2025–2030 secular variation. External disturbance fields and magnetic sensor errors are omitted."
        >
          NOAA ↗
        </a>
      </div>
      <fieldset>
        <legend>
          ACTUATORS <span>mission</span>
        </legend>
        <div className="mission-presets">
          <button
            disabled={!presets.magnetic_only}
            onClick={() =>
              edit((d) => {
                Object.assign(d.spacecraft, cloneScenario(presets.magnetic_only));
              })
            }
          >
            MTQ only
          </button>
          <button
            disabled={!presets.wheels_and_magnetic}
            onClick={() =>
              edit((d) => {
                Object.assign(d.spacecraft, cloneScenario(presets.wheels_and_magnetic));
              })
            }
          >
            Wheels + MTQ
          </button>
        </div>
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={!!craft.magnetorquer?.enabled}
            disabled={!craft.magnetorquer}
            onChange={(e) =>
              edit((d) => {
                if (d.spacecraft.magnetorquer) d.spacecraft.magnetorquer.enabled = e.target.checked;
              })
            }
          />
          Magnetorquers
        </label>
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={wheelsEnabled}
            disabled={!craft.wheels.length && !wheelExample.length}
            onChange={(e) =>
              edit((d) => {
                if (!d.spacecraft.wheels.length)
                  d.spacecraft.wheels = wheelExample.map((spec) => ({
                    spec: cloneScenario(spec),
                    enabled: true,
                    initial_speed_rpm: 0,
                  }));
                d.spacecraft.wheels.forEach((w) => {
                  w.enabled = e.target.checked;
                });
              })
            }
          />
          Reaction wheels
        </label>
        {craft.magnetorquer?.enabled && (
          <Field
            label="m max"
            unit="A·m²"
            value={craft.magnetorquer.spec.max_dipole_am2}
            min={0}
            max={10}
            step={0.01}
            onChange={(v) =>
              edit((d) => {
                d.spacecraft.magnetorquer!.spec.max_dipole_am2 = v;
              })
            }
          />
        )}
        <Select
          label="Controller"
          value={craft.controller}
          options={[
            { value: 'quaternion_pd', label: 'Quaternion PD' },
            { value: 'coast', label: 'Coast' },
          ]}
          onChange={(v) =>
            edit((d) => {
              d.spacecraft.controller = v as typeof craft.controller;
            })
          }
        />
        <div title="Moving target includes the target direction's angular rate and acceleration. Stationary reference retains the earlier zero-rate guidance for comparisons.">
          <Select
            label="Pointing reference"
            value={craft.pointing_reference || 'instantaneous_zero_rate'}
            options={[
              { value: 'moving_boresight', label: 'Moving target' },
              { value: 'instantaneous_zero_rate', label: 'Stationary reference' },
            ]}
            onChange={(value) =>
              edit((draft) => {
                draft.spacecraft.pointing_reference = value as NonNullable<
                  typeof craft.pointing_reference
                >;
                if (value === 'moving_boresight') draft.spacecraft.free_roll = true;
              })
            }
          />
        </div>
        <label
          className="spacecraft-follow"
          title="Magnetic wheel momentum unloading during wheel PD. Saved intent is retained when hardware or controller authority is unavailable."
        >
          <input
            type="checkbox"
            checked={craft.magnetic_unloading_enabled ?? false}
            disabled={!!unloadingUnavailable}
            onChange={(event) =>
              edit((draft) => {
                draft.spacecraft.magnetic_unloading_enabled = event.target.checked;
              })
            }
          />
          Momentum unloading
        </label>
        {unloadingUnavailable ? (
          <div className="profile-evidence">{unloadingUnavailable}</div>
        ) : null}
        {craft.magnetic_unloading_enabled ? (
          <div title="Requested momentum decay time. Field projection, actuator limits and guidance affect the achieved response.">
            <Field
              label="τ unload"
              unit="s"
              value={craft.magnetic_unloading_time_constant_s ?? 600}
              min={1}
              max={1e7}
              step={10}
              disabled={!!unloadingUnavailable}
              onChange={(value) =>
                edit((draft) => {
                  draft.spacecraft.magnetic_unloading_time_constant_s = value;
                })
              }
            />
            {!unloadingUnavailable &&
              (craft.magnetic_unloading_time_constant_s ?? 600) <
                config.clocks.controller_period_s && (
                <small title="With a fixed field, a stationary body and no saturation, held commands alternate the perpendicular momentum when τ is below the controller interval. At τ ≤ half the interval, that scalar response does not decay. This is not a general stability test.">
                  τ below controller interval
                </small>
              )}
          </div>
        ) : null}
        <label
          className="spacecraft-follow"
          title={
            craft.pointing_reference === 'moving_boresight'
              ? 'Moving-target guidance controls the boresight and leaves roll free.'
              : undefined
          }
        >
          <input
            type="checkbox"
            checked={craft.free_roll}
            disabled={craft.pointing_reference === 'moving_boresight'}
            onChange={(e) =>
              edit((d) => {
                d.spacecraft.free_roll = e.target.checked;
              })
            }
          />
          Free roll
        </label>
        {craft.free_roll && (
          <label className="spacecraft-follow">
            <input
              type="checkbox"
              checked={craft.roll_rate_damping ?? true}
              onChange={(e) =>
                edit((d) => {
                  d.spacecraft.roll_rate_damping = e.target.checked;
                })
              }
            />
            Damp roll rate
          </label>
        )}
      </fieldset>
      <details className="mission-details">
        <summary>Mass & inertia</summary>
        <Field
          label="m"
          unit="kg"
          value={craft.mass_kg}
          min={0.01}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.spacecraft.mass_kg = v;
            })
          }
        />
        {([0, 1, 2] as const).map((axis) => (
          <Field
            key={axis}
            label={`J${'xyz'[axis]}`}
            unit="kg·m²"
            value={craft.locked_inertia_kg_m2[axis][axis]}
            min={0.000001}
            max={10}
            step={0.0001}
            onChange={(v) =>
              edit((d) => {
                d.spacecraft.locked_inertia_kg_m2[axis][axis] = v;
              })
            }
          />
        ))}
        <small>Declared locked inertia. Module switches change authority and load.</small>
      </details>
      {craft.magnetorquer?.enabled && (
        <details className="mission-details">
          <summary>Coil power</summary>
          {craft.magnetorquer.full_axis_power_w?.map((watts, index) => (
            <Field
              key={index}
              label={`P${'xyz'[index]} max`}
              unit="W"
              value={watts}
              min={0}
              max={20}
              step={0.05}
              onChange={(v) =>
                edit((d) => {
                  d.spacecraft.magnetorquer!.full_axis_power_w![index] = v;
                })
              }
            />
          ))}
          <small>Quadratic dipole-to-power example, per axis.</small>
        </details>
      )}
      <details className="mission-details">
        <summary>Controller gains</summary>
        {([0, 1, 2] as const).map((axis) => (
          <div key={axis}>
            <Field
              label={`Kp ${'xyz'[axis]}`}
              unit="N·m/rad"
              value={craft.proportional_nm_per_rad[axis]}
              min={0}
              max={1}
              step={0.000001}
              onChange={(v) =>
                edit((d) => {
                  d.spacecraft.proportional_nm_per_rad[axis] = v;
                })
              }
            />
            <Field
              label={`Kd ${'xyz'[axis]}`}
              unit="N·m·s/rad"
              value={craft.derivative_nm_s_per_rad[axis]}
              min={0}
              max={1}
              step={0.00001}
              onChange={(v) =>
                edit((d) => {
                  d.spacecraft.derivative_nm_s_per_rad[axis] = v;
                })
              }
            />
          </div>
        ))}
      </details>
      {craft.wheels.length > 0 && (
        <details className="mission-details">
          <summary>Wheels</summary>
          <div className="mission-presets">
            <button
              disabled={!wheelExample.length}
              title="Install three RW1 Type A mechanical references with an assumed torque envelope and power budget. Resets their initial speed to zero."
              onClick={() =>
                edit((draft) => {
                  draft.spacecraft.wheels = wheelExample.map((spec) => ({
                    enabled: true,
                    initial_speed_rpm: 0,
                    spec: cloneScenario(spec),
                  }));
                })
              }
            >
              RW1 reference
            </button>
          </div>
          {craft.wheels.map((wheel, index) => (
            <fieldset key={index}>
              <legend>W{index + 1}</legend>
              <Field
                label="ω₀"
                unit="rpm"
                value={wheel.initial_speed_rpm ?? 0}
                min={-wheel.spec.max_speed_rpm}
                max={wheel.spec.max_speed_rpm}
                step={100}
                onChange={(value) =>
                  edit((draft) => {
                    draft.spacecraft.wheels[index].initial_speed_rpm = value;
                  })
                }
              />
              <Field
                label="Js"
                unit="kg·m²"
                value={wheel.spec.spin_inertia_kg_m2}
                min={1e-9}
                max={1}
                step={1e-7}
                onChange={(v) =>
                  edit((d) => {
                    d.spacecraft.wheels[index].spec.spin_inertia_kg_m2 = v;
                  })
                }
              />
              <Field
                label="ω max"
                unit="rpm"
                value={wheel.spec.max_speed_rpm}
                min={Math.max(1, Math.abs(wheel.initial_speed_rpm ?? 0))}
                max={100000}
                step={100}
                onChange={(v) =>
                  edit((d) => {
                    d.spacecraft.wheels[index].spec.max_speed_rpm = v;
                    d.spacecraft.wheels[index].spec.constant_torque_until_rpm = Math.min(
                      d.spacecraft.wheels[index].spec.constant_torque_until_rpm,
                      Math.max(0, v - 1),
                    );
                  })
                }
              />
              <Field
                label="τ max"
                unit="mN·m"
                value={wheel.spec.max_motor_torque_nm * 1000}
                min={0}
                max={1000}
                step={0.01}
                onChange={(v) =>
                  edit((d) => {
                    d.spacecraft.wheels[index].spec.max_motor_torque_nm = v / 1000;
                  })
                }
              />
              <Field
                label="P floor"
                unit="W"
                value={wheel.spec.idle_power_w}
                min={0}
                max={100}
                step={0.01}
                onChange={(value) =>
                  edit((draft) => {
                    const spec = draft.spacecraft.wheels[index].spec;
                    spec.idle_power_w = value;
                    if (spec.max_bus_power_w !== null && spec.max_bus_power_w < value)
                      spec.max_bus_power_w = value;
                  })
                }
              />
              <label className="spacecraft-follow">
                <input
                  type="checkbox"
                  checked={wheel.spec.max_bus_power_w !== null}
                  onChange={(event) =>
                    edit((draft) => {
                      const spec = draft.spacecraft.wheels[index].spec;
                      spec.max_bus_power_w = event.target.checked
                        ? Math.max(spec.idle_power_w, 0.5)
                        : null;
                    })
                  }
                />{' '}
                Power limit
              </label>
              {wheel.spec.max_bus_power_w !== null && (
                <Field
                  label="P max"
                  unit="W"
                  value={wheel.spec.max_bus_power_w}
                  min={wheel.spec.idle_power_w}
                  max={100}
                  step={0.01}
                  onChange={(value) =>
                    edit((draft) => {
                      draft.spacecraft.wheels[index].spec.max_bus_power_w = value;
                    })
                  }
                />
              )}
              <details className="mission-details">
                <summary>Drive assumptions</summary>
                {(
                  [
                    [
                      'constant_torque_until_rpm',
                      'Torque knee',
                      'rpm',
                      0,
                      Math.max(0, wheel.spec.max_speed_rpm - 1),
                      100,
                    ],
                    ['motor_torque_constant_nm_a', 'Kt', 'N·m/A', 1e-9, 10, 0.001],
                    ['winding_resistance_ohm', 'R', 'Ω', 0, 10000, 0.1],
                    ['non_ohmic_drive_efficiency', 'η drive', '', 0.001, 1, 0.01],
                    ['viscous_friction_nm_s', 'b', 'N·m·s', 0, 1, 1e-8],
                    ['regenerative_efficiency', 'η regen', '', 0, 1, 0.01],
                  ] as const
                ).map(([key, label, unit, min, max, step]) => (
                  <Field
                    key={key}
                    label={label}
                    unit={unit}
                    value={wheel.spec[key]}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(value) =>
                      edit((draft) => {
                        draft.spacecraft.wheels[index].spec[key] = value;
                      })
                    }
                  />
                ))}
              </details>
            </fieldset>
          ))}
          <small>Editable power allowance and torque curve.</small>
          {wheelEvidence && (
            <details className="mission-details">
              <summary>Reference & assumptions</summary>
              <div className="profile-evidence">
                RW1 reference button: published rotor, assumed drive. Edits create a custom
                configuration.
              </div>
              {wheelEvidence.sources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                  {source.title} ↗
                </a>
              ))}
              <ul>
                {[...wheelEvidence.assumptions, ...wheelEvidence.limits].map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </details>
          )}
        </details>
      )}
    </>
  );
}
