import { Field, Select } from '../controls/RadioControls';
import type { Samples } from '../types';
import type { MissionConfig } from './missionTypes';
import { unloadingStatusLabels } from './unloadingStatus';

export function MissionGncControls({
  config,
  edit,
  samples,
  sampleIndex = 0,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
  samples?: Samples;
  sampleIndex?: number;
}) {
  const craft = config.spacecraft;
  const wheelCount = craft.wheels.filter((wheel) => wheel.enabled).length;
  const magneticEnabled = !!craft.magnetorquer?.enabled;
  const magneticAuthority = magneticEnabled && (craft.magnetorquer?.spec.max_dipole_am2 || 0) > 0;
  const unloadingEnabled = craft.magnetic_unloading_enabled ?? false;
  const unloadingTime = craft.magnetic_unloading_time_constant_s ?? 600;
  const unloadingUnavailable =
    !wheelCount && !magneticEnabled
      ? 'Needs wheels + MTQ'
      : !wheelCount
        ? 'Needs wheels'
        : !magneticEnabled
          ? 'Needs MTQ'
          : !magneticAuthority
            ? 'Zero MTQ authority'
            : craft.controller !== 'quaternion_pd'
              ? 'Controller inactive'
              : '';
  const sampleTime = samples?.time_s[sampleIndex];
  const unloadingStatus =
    sampleTime == null ? undefined : samples?.gnc?.unloading_status?.[sampleIndex];
  return (
    <>
      <div
        className="mission-field-model"
        title="Actuator sizing and hardware switches are shared inputs in Spacecraft → GNC."
      >
        <span>Shared actuators</span>
        <span>
          {wheelCount} wheel{wheelCount === 1 ? '' : 's'} · MTQ{' '}
          {magneticEnabled ? 'enabled' : 'disabled'}
        </span>
      </div>
      <fieldset>
        <legend>
          CONTROLLER <span>Earth inputs</span>
        </legend>
        <Select
          label="Controller"
          value={craft.controller}
          options={[
            { value: 'quaternion_pd', label: 'Quaternion PD' },
            { value: 'coast', label: 'Coast' },
          ]}
          onChange={(value) =>
            edit((draft) => {
              draft.spacecraft.controller = value as typeof craft.controller;
            })
          }
        />
        <div title="Moving target includes the target direction's angular rate and acceleration. Stationary reference retains zero-rate guidance for comparisons.">
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
            onChange={(event) =>
              edit((draft) => {
                draft.spacecraft.free_roll = event.target.checked;
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
              onChange={(event) =>
                edit((draft) => {
                  draft.spacecraft.roll_rate_damping = event.target.checked;
                })
              }
            />
            Damp roll rate
          </label>
        )}
      </fieldset>
      <fieldset>
        <legend>
          WHEEL UNLOADING <span>Earth inputs</span>
        </legend>
        <div title="Magnetic wheel momentum unloading during wheel PD. The setting is saved even when hardware or controller authority is unavailable.">
          <Select
            label="Wheel unloading"
            value={unloadingEnabled ? 'enabled' : 'disabled'}
            options={[
              { value: 'disabled', label: 'Disabled' },
              { value: 'enabled', label: 'Enabled' },
            ]}
            onChange={(value) =>
              edit((draft) => {
                draft.spacecraft.magnetic_unloading_enabled = value === 'enabled';
              })
            }
          />
        </div>
        <div title="Requested wheel-momentum decay time while unloading is enabled. This is a control time constant, not a start delay or unloading duration. Field projection and actuator limits affect the achieved response.">
          <Field
            label="Decay time constant"
            unit="s"
            value={unloadingTime}
            min={1}
            max={1e7}
            step={10}
            disabled={!unloadingEnabled}
            onChange={(value) =>
              edit((draft) => {
                draft.spacecraft.magnetic_unloading_time_constant_s = value;
              })
            }
          />
        </div>
        {unloadingEnabled && unloadingUnavailable ? (
          <div className="profile-evidence">{unloadingUnavailable}</div>
        ) : null}
        {unloadingEnabled &&
          !unloadingUnavailable &&
          unloadingTime < config.clocks.controller_period_s && (
            <div
              className="profile-evidence"
              title="With a fixed field, a stationary body and no saturation, held commands alternate the perpendicular momentum when the time constant is below the controller interval. At or below half the interval, that scalar response does not decay. This is not a general stability test."
            >
              Time constant below controller interval
            </div>
          )}
        <div
          className="mission-radio-ledger"
          aria-label="Simulated wheel unloading"
          title="Returned state at the replay sample, independent of unrun input edits. Active controller does not guarantee decreasing wheel speed or nonzero unloading torque."
        >
          <span>
            <span>Replay{sampleTime == null ? '' : ` · T+${Number(sampleTime.toFixed(3))} s`}</span>
            <strong>
              {unloadingStatus ? unloadingStatusLabels[unloadingStatus] : 'Unavailable'}
            </strong>
          </span>
        </div>
      </fieldset>
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
              onChange={(value) =>
                edit((draft) => {
                  draft.spacecraft.proportional_nm_per_rad[axis] = value;
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
              onChange={(value) =>
                edit((draft) => {
                  draft.spacecraft.derivative_nm_s_per_rad[axis] = value;
                })
              }
            />
          </div>
        ))}
      </details>
      {craft.wheels.length > 0 && (
        <details className="mission-details">
          <summary>Initial wheel speeds</summary>
          {craft.wheels.map((wheel, index) => (
            <Field
              key={index}
              label={`W${index + 1} initial speed`}
              unit="rpm"
              value={wheel.initial_speed_rpm ?? 0}
              min={-wheel.spec.max_speed_rpm}
              max={wheel.spec.max_speed_rpm}
              step={100}
              disabled={!wheel.enabled}
              onChange={(value) =>
                edit((draft) => {
                  draft.spacecraft.wheels[index].initial_speed_rpm = value;
                })
              }
            />
          ))}
        </details>
      )}
      <details className="mission-details">
        <summary>Magnetic environment</summary>
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
      </details>
    </>
  );
}
