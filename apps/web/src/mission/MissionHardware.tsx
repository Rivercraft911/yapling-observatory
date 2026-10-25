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
  const [presets, setPresets] = useState<
    Record<string, Pick<MissionConfig['spacecraft'], 'wheels' | 'magnetorquer'>>
  >({});
  const wheelExample = presets.wheels_and_magnetic?.wheels.map((wheel) => wheel.spec) || [];
  useEffect(() => {
    const abort = new AbortController();
    api<Record<string, Pick<MissionConfig['spacecraft'], 'wheels' | 'magnetorquer'>>>(
      '/api/mission/actuator-presets',
      { signal: abort.signal },
    )
      .then(setPresets)
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return (
    <>
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
            checked={craft.wheels.some((w) => w.enabled)}
            disabled={!craft.wheels.length && !wheelExample.length}
            onChange={(e) =>
              edit((d) => {
                if (!d.spacecraft.wheels.length)
                  d.spacecraft.wheels = wheelExample.map((spec) => ({
                    spec: cloneScenario(spec),
                    enabled: true,
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
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={craft.free_roll}
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
          <summary>Wheel limits</summary>
          {craft.wheels.map((wheel, index) => (
            <fieldset key={index}>
              <legend>W{index + 1}</legend>
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
                min={1}
                max={100000}
                step={100}
                onChange={(v) =>
                  edit((d) => {
                    d.spacecraft.wheels[index].spec.max_speed_rpm = v;
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
            </fieldset>
          ))}
          <small>Editable illustrative wheel model.</small>
        </details>
      )}
    </>
  );
}
