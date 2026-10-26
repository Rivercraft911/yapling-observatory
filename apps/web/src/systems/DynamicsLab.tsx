import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Workbench } from '../Workbench';
import { TracePlot, closestIndex, type Trace } from '../plots/TracePlot';
import type { AssetInfo, Variant } from '../types';
import type {
  AttitudeResult,
  DynamicsDefaults,
  DynamicsSession,
  OrbitResult,
} from './dynamicsTypes';
import './systems.css';
import './dynamics.css';
import { OrbitalElementsFields } from './OrbitalElementsFields';

const colors = ['#e5ddd6', '#d76d7b', '#9bb8c7', '#c4ae80'];
const axes = ['X', 'Y', 'Z'];
const degrees = 180 / Math.PI;
const rpm = 60 / (2 * Math.PI);
type Plot = { title: string; unit: string; traces: Trace[]; stepped?: boolean };
const scientific = (value: number | null | undefined) =>
  value == null ? '—' : value.toExponential(2);

export function DynamicsLab({
  session,
  onSession,
  inspectorTarget,
  asset,
  variant,
  cutaway,
  starTrackerVisible,
  moduleVisibility,
}: {
  session: DynamicsSession;
  onSession: Dispatch<SetStateAction<DynamicsSession>>;
  inspectorTarget: HTMLElement | null;
  asset?: AssetInfo;
  variant: Variant;
  cutaway: boolean;
  starTrackerVisible: boolean;
  moduleVisibility?: Record<string, boolean>;
}) {
  const { config, result } = session;
  const [mode, setMode] = useState<'attitude' | 'orbit'>('attitude');
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const displayClock = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (config) return;
    const abort = new AbortController();
    api<DynamicsDefaults>('/api/dynamics-lab/defaults', { signal: abort.signal })
      .then((value) =>
        onSession((current) => (current.config ? current : { ...current, config: value })),
      )
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => abort.abort();
  }, [config, onSession]);
  useEffect(() => () => request.current?.abort(), []);
  const attitude = result?.attitude;
  const orbit = result?.orbit;
  const activeResult = mode === 'attitude' ? attitude : orbit;
  const times = useMemo(
    () =>
      mode === 'attitude'
        ? attitude?.samples.map((s) => s.state.time_s) || []
        : orbit?.result.states.map((s) => s.time_s) || [],
    [mode, attitude, orbit],
  );
  const index = closestIndex(times, cursor);
  const quaternionHistory = useMemo(
    () => attitude?.samples.map((s) => s.state.q_body_from_inertial_wxyz),
    [attitude],
  );
  useEffect(() => {
    setPlaying(false);
    displayClock.current = times[0] ?? 0;
    setCursor(displayClock.current);
  }, [times]);
  useEffect(() => {
    if (!playing || times.length < 2) return;
    let previous = performance.now();
    let lastUpdate = previous;
    let frame = 0;
    const tick = (now: number) => {
      displayClock.current = Math.min(
        times.at(-1)!,
        displayClock.current + (now - previous) / 1000,
      );
      previous = now;
      if (now - lastUpdate >= 80 || displayClock.current >= times.at(-1)!) {
        setCursor(displayClock.current);
        lastUpdate = now;
      }
      if (displayClock.current >= times.at(-1)!) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, times]);
  const scrub = (time: number) => {
    setPlaying(false);
    displayClock.current = time;
    setCursor(time);
  };
  const edit = (change: (draft: DynamicsDefaults) => void) =>
    onSession((current) => {
      if (!current.config) return current;
      const next = structuredClone(current.config);
      change(next);
      return { ...current, config: next };
    });
  const run = async () => {
    if (!config) return;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setPlaying(false);
    setError('');
    try {
      if (mode === 'attitude') {
        const next = await api<AttitudeResult>('/api/dynamics-lab/attitude', {
          method: 'POST',
          body: JSON.stringify(config.attitude),
          signal: abort.signal,
        });
        if (!abort.signal.aborted)
          onSession((current) => ({ ...current, result: { ...current.result, attitude: next } }));
      } else {
        const next = await api<OrbitResult>('/api/dynamics-lab/orbit', {
          method: 'POST',
          body: JSON.stringify(config.orbit),
          signal: abort.signal,
        });
        if (!abort.signal.aborted)
          onSession((current) => ({ ...current, result: { ...current.result, orbit: next } }));
      }
      if (!abort.signal.aborted) setCursor(0);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Study failed');
    } finally {
      if (request.current === abort) setBusy(false);
    }
  };
  const dirty =
    !!config &&
    !!activeResult &&
    JSON.stringify(config[mode]) !== JSON.stringify(activeResult.request);
  const plots = useMemo<Plot[]>(() => {
    if (mode === 'orbit') {
      if (!orbit) return [];
      const values = orbit.result.diagnostics;
      return [
        {
          title: 'Relative orbital energy change',
          unit: 'ppb',
          traces: [
            {
              label: 'Energy',
              color: colors[0],
              values: values.map((v) =>
                v.relative_energy_change == null ? null : v.relative_energy_change * 1e9,
              ),
            },
          ],
        },
        {
          title: 'Axial angular momentum conservation',
          unit: 'ppb of |h₀|',
          traces: [
            {
              label: 'Scaled ΔHz',
              color: colors[1],
              values: values.map((v) =>
                v.scaled_axial_angular_momentum_change == null
                  ? null
                  : v.scaled_axial_angular_momentum_change * 1e9,
              ),
            },
          ],
        },
        ...(orbit.nodes
          ? [
              {
                title: 'Osculating RAAN drift',
                unit: 'deg',
                traces: [{ label: 'ΔΩ', color: colors[2], values: orbit.nodes.raan_drift_deg }],
              },
            ]
          : []),
      ];
    }
    if (!attitude) return [];
    const samples = attitude.samples;
    const wheelCount = attitude.request.body.wheels.length;
    return [
      {
        title: 'Boresight error',
        unit: 'deg',
        traces: [
          {
            label: 'Target cone angle',
            color: colors[0],
            values: samples.map((s) => s.pointing_error_rad * degrees),
          },
        ],
      },
      {
        title: 'Body rate',
        unit: 'deg/s',
        traces: axes.map((label, i) => ({
          label,
          color: colors[i],
          values: samples.map((s) => s.state.omega_body_rad_s[i] * degrees),
        })),
      },
      ...(wheelCount
        ? [
            {
              title: 'Relative wheel speed',
              unit: 'rpm',
              traces: Array.from({ length: wheelCount }, (_, i) => ({
                label: `Wheel ${i + 1}`,
                color: colors[i % colors.length],
                values: samples.map((s) => s.mechanics.wheel_relative_speed_rad_s[i] * rpm),
              })),
            },
            {
              title: 'Wheel electrical power',
              unit: 'W',
              traces: [
                {
                  label: 'Bus',
                  color: colors[0],
                  values: samples.map((s) => s.actuators.wheel_bus_power_w),
                },
                {
                  label: 'Heat',
                  color: colors[1],
                  values: samples.map((s) => s.actuators.wheel_heat_w),
                },
              ],
            },
          ]
        : []),
      {
        title: 'Actuator limits',
        unit: 'flag',
        stepped: true,
        traces: [
          {
            label: 'Wheel torque',
            color: colors[0],
            values: samples.map((s) => Number(s.actuators.wheels.some((w) => w.torque_saturated))),
          },
          {
            label: 'Wheel speed',
            color: colors[1],
            values: samples.map((s) =>
              Number(s.actuators.wheels.some((w) => w.at_speed_limit || w.overspeed)),
            ),
          },
          {
            label: 'Magnetic dipole',
            color: colors[2],
            values: samples.map((s) => Number(s.controller_dipole_saturated)),
          },
          {
            label: 'Wheel power',
            color: colors[3],
            values: samples.map((s) => Number(s.actuators.wheels.some((w) => w.power_saturated))),
          },
        ],
      },
    ];
  }, [mode, attitude, orbit]);
  const a = config?.attitude;
  const o = config?.orbit;
  const controls =
    config && a && o ? (
      <div className="systems-controls dynamics-controls">
        <div className="controls-title">
          <span className="eyebrow">DYNAMICS</span>
        </div>
        <nav className="systems-subtabs" aria-label="Dynamics study">
          {(['attitude', 'orbit'] as const).map((id) => (
            <button
              key={id}
              aria-pressed={mode === id}
              onClick={() => {
                request.current?.abort();
                setBusy(false);
                setError('');
                setCursor(0);
                setMode(id);
              }}
            >
              {id === 'attitude' ? 'GNC' : 'Propagation'}
            </button>
          ))}
        </nav>
        <span className="study-scope" title={config.scope}>
          {mode === 'attitude'
            ? 'Fixed target · constant inertial B'
            : 'Standalone · selected gravity'}
        </span>
        {mode === 'attitude' ? (
          <>
            <label className="field-row">
              <span>Controller</span>
              <select
                aria-label="Dynamics controller"
                value={a.controller}
                onChange={(e) =>
                  edit((d) => {
                    d.attitude.controller = e.target.value as typeof a.controller;
                  })
                }
              >
                <option value="coast">Coast</option>
                <option value="quaternion_pd">Quaternion PD</option>
                <option value="magnetic_bdot">Magnetic B-dot</option>
              </select>
            </label>
            {a.controller === 'quaternion_pd' && (
              <label className="spacecraft-follow">
                <input
                  type="checkbox"
                  checked={a.free_roll}
                  onChange={(e) =>
                    edit((d) => {
                      d.attitude.free_roll = e.target.checked;
                    })
                  }
                />
                Free roll about boresight
              </label>
            )}
            {a.controller === 'quaternion_pd' && a.free_roll && (
              <label className="spacecraft-follow">
                <input
                  type="checkbox"
                  checked={a.damp_free_roll_rate}
                  onChange={(e) =>
                    edit((d) => {
                      d.attitude.damp_free_roll_rate = e.target.checked;
                    })
                  }
                />
                Damp roll rate
              </label>
            )}
            <Numeric
              label="Duration"
              unit="s"
              value={a.duration_s}
              min={0}
              max={7200}
              onChange={(v) =>
                edit((d) => {
                  d.attitude.duration_s = v;
                })
              }
            />
            <fieldset>
              <legend>LOCKED INERTIA · COM</legend>
              {axes.map((axis, i) => (
                <Numeric
                  key={axis}
                  label={`I${axis.toLowerCase()}${axis.toLowerCase()}`}
                  unit="kg m²"
                  value={a.body.locked_inertia_kg_m2[i][i]}
                  min={1e-10}
                  step={0.0001}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.body.locked_inertia_kg_m2[i][i] = v;
                    })
                  }
                />
              ))}
              <details>
                <summary>Products of inertia</summary>
                {(
                  [
                    [0, 1],
                    [0, 2],
                    [1, 2],
                  ] as const
                ).map(([i, j]) => (
                  <Numeric
                    key={`${i}${j}`}
                    label={`I${axes[i].toLowerCase()}${axes[j].toLowerCase()}`}
                    unit="kg m²"
                    value={a.body.locked_inertia_kg_m2[i][j]}
                    step={0.00001}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.locked_inertia_kg_m2[i][j] = v;
                        d.attitude.body.locked_inertia_kg_m2[j][i] = v;
                      })
                    }
                  />
                ))}
              </details>
            </fieldset>
            {a.body.magnetorquer && (
              <fieldset>
                <legend>MAGNETORQUER</legend>
                <Numeric
                  label="Dipole norm limit"
                  unit="A m²"
                  value={a.body.magnetorquer.max_dipole_am2}
                  min={0}
                  step={0.01}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.body.magnetorquer!.max_dipole_am2 = v;
                    })
                  }
                />
                <Numeric
                  label="Unloading gain"
                  unit="1/s"
                  value={a.unloading_gain_s_inv}
                  min={0}
                  step={0.001}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.unloading_gain_s_inv = v;
                    })
                  }
                />
              </fieldset>
            )}
            {a.body.wheels.map((wheel, i) => (
              <fieldset key={i}>
                <legend>WHEEL {i + 1}</legend>
                <Numeric
                  label={`Wheel ${i + 1} spin inertia`}
                  unit="kg m²"
                  value={wheel.spin_inertia_kg_m2}
                  min={1e-12}
                  step={1e-7}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.body.wheels[i].spin_inertia_kg_m2 = v;
                    })
                  }
                />
                <Numeric
                  label={`Wheel ${i + 1} speed limit`}
                  unit="rpm"
                  value={wheel.max_speed_rpm}
                  min={1}
                  step={100}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.body.wheels[i].max_speed_rpm = v;
                    })
                  }
                />
                <Numeric
                  label={`Wheel ${i + 1} torque limit`}
                  unit="µN m"
                  value={wheel.max_motor_torque_nm * 1e6}
                  min={0}
                  step={1}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.body.wheels[i].max_motor_torque_nm = v * 1e-6;
                    })
                  }
                />
                {wheel.max_bus_power_w != null && (
                  <Numeric
                    label={`Wheel ${i + 1} bus limit`}
                    unit="W"
                    value={wheel.max_bus_power_w}
                    min={0}
                    step={0.01}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].max_bus_power_w = v;
                      })
                    }
                  />
                )}
                <details>
                  <summary>Drive & losses</summary>
                  <Numeric
                    label="Torque constant"
                    unit="N m/A"
                    value={wheel.motor_torque_constant_nm_a}
                    min={1e-9}
                    step={0.001}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].motor_torque_constant_nm_a = v;
                      })
                    }
                  />
                  <Numeric
                    label="Winding resistance"
                    unit="Ω"
                    value={wheel.winding_resistance_ohm}
                    min={0}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].winding_resistance_ohm = v;
                      })
                    }
                  />
                  <Numeric
                    label="Non-ohmic efficiency"
                    value={wheel.non_ohmic_drive_efficiency}
                    min={0.001}
                    max={1}
                    step={0.01}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].non_ohmic_drive_efficiency = v;
                      })
                    }
                  />
                  <Numeric
                    label="Idle demand"
                    unit="W"
                    value={wheel.idle_power_w}
                    min={0}
                    step={0.001}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].idle_power_w = v;
                      })
                    }
                  />
                  <Numeric
                    label="Regeneration"
                    value={wheel.regenerative_efficiency}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].regenerative_efficiency = v;
                      })
                    }
                  />
                  <Numeric
                    label="Constant-torque knee"
                    unit="rpm"
                    value={wheel.constant_torque_until_rpm}
                    min={0}
                    onChange={(v) =>
                      edit((d) => {
                        d.attitude.body.wheels[i].constant_torque_until_rpm = v;
                      })
                    }
                  />
                </details>
              </fieldset>
            ))}
            <details>
              <summary>Gains, clocks & supplied field</summary>
              {a.pd_gains && (
                <>
                  {axes.map((axis, i) => (
                    <Numeric
                      key={`kp${i}`}
                      label={`Kp ${axis}`}
                      unit="N m/rad"
                      value={a.pd_gains!.proportional_nm_per_rad[i]}
                      min={0}
                      step={0.00001}
                      onChange={(v) =>
                        edit((d) => {
                          d.attitude.pd_gains!.proportional_nm_per_rad[i] = v;
                        })
                      }
                    />
                  ))}
                  {axes.map((axis, i) => (
                    <Numeric
                      key={`kd${i}`}
                      label={`Kd ${axis}`}
                      unit="N m s/rad"
                      value={a.pd_gains!.derivative_nm_s_per_rad[i]}
                      min={0}
                      step={0.0001}
                      onChange={(v) =>
                        edit((d) => {
                          d.attitude.pd_gains!.derivative_nm_s_per_rad[i] = v;
                        })
                      }
                    />
                  ))}
                </>
              )}
              <Numeric
                label="B-dot gain"
                unit="A m² s/T"
                value={a.bdot_gain_am2_s_t}
                min={0}
                step={1000}
                onChange={(v) =>
                  edit((d) => {
                    d.attitude.bdot_gain_am2_s_t = v;
                  })
                }
              />
              <Numeric
                label="Physics step"
                unit="s"
                value={a.physics_step_s}
                min={0.001}
                step={0.01}
                onChange={(v) =>
                  edit((d) => {
                    d.attitude.physics_step_s = v;
                  })
                }
              />
              <Numeric
                label="Controller period"
                unit="s"
                value={a.controller_period_s}
                min={0.001}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    d.attitude.controller_period_s = v;
                  })
                }
              />
              <Numeric
                label="Output step"
                unit="s"
                value={a.output_step_s}
                min={0.001}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    d.attitude.output_step_s = v;
                  })
                }
              />
              {axes.map((axis, i) => (
                <Numeric
                  key={`B${i}`}
                  label={`Inertial B ${axis}`}
                  unit="µT"
                  value={a.magnetic_field_inertial_t[i] * 1e6}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.magnetic_field_inertial_t[i] = v * 1e-6;
                    })
                  }
                />
              ))}
              <p>Controller and output intervals must be integer physics steps.</p>
            </details>
            <details>
              <summary>Initial rate & target</summary>
              {axes.map((axis, i) => (
                <Numeric
                  key={`rate${i}`}
                  label={`Initial rate ${axis}`}
                  unit="deg/s"
                  value={a.initial.omega_body_rad_s[i] * degrees}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.initial.omega_body_rad_s[i] = v / degrees;
                    })
                  }
                />
              ))}
              {axes.map((axis, i) => (
                <Numeric
                  key={`target${i}`}
                  label={`Inertial target ${axis}`}
                  value={a.target_direction_inertial[i]}
                  min={-1}
                  max={1}
                  step={0.1}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.target_direction_inertial[i] = v;
                    })
                  }
                />
              ))}
              {a.initial.wheel_relative_speed_rad_s.map((speed, i) => (
                <Numeric
                  key={`speed${i}`}
                  label={`Initial wheel ${i + 1}`}
                  unit="rpm"
                  value={speed * rpm}
                  onChange={(v) =>
                    edit((d) => {
                      d.attitude.initial.wheel_relative_speed_rad_s[i] = v / rpm;
                    })
                  }
                />
              ))}
            </details>
          </>
        ) : (
          <>
            <label className="field-row">
              <span>Force model</span>
              <select
                aria-label="Propagation force model"
                value={o.config.force_model}
                onChange={(e) =>
                  edit((d) => {
                    d.orbit.config.force_model = e.target.value as typeof o.config.force_model;
                  })
                }
              >
                <option value="central">Central</option>
                <option value="j2">Central + J2</option>
              </select>
            </label>
            <label className="field-row">
              <span>Integrator</span>
              <select
                aria-label="Orbit integrator"
                value={o.config.method}
                onChange={(e) =>
                  edit((d) => {
                    d.orbit.config.method = e.target.value as typeof o.config.method;
                  })
                }
              >
                <option value="rk4">RK4</option>
                <option value="velocity_verlet">Velocity Verlet</option>
              </select>
            </label>
            <label className="field-row">
              <span>Initial state</span>
              <select
                aria-label="Propagation initial state definition"
                value={o.initialization}
                onChange={(e) =>
                  edit((d) => {
                    d.orbit.initialization = e.target.value as typeof o.initialization;
                    d.orbit.node_definition = 'raan';
                  })
                }
              >
                <option value="elements">a, e, i, Ω, ω, ν</option>
                <option value="cartesian">Cartesian</option>
              </select>
            </label>
            {o.initialization === 'elements' && o.elements && (
              <>
                <OrbitalElementsFields
                  value={o.elements}
                  onChange={(elements) =>
                    edit((d) => {
                      d.orbit.elements = elements;
                      d.orbit.node_definition = 'raan';
                    })
                  }
                />
                <button
                  type="button"
                  disabled={o.config.force_model !== 'j2'}
                  title="First-order mean-J2 inclination reference; initial elements are osculating and remain editable."
                  onClick={async () => {
                    try {
                      const elements = o.elements!;
                      const value = await api<{ inclination_deg: number | null }>(
                        '/api/dynamics-lab/orbit/sso-reference',
                        {
                          method: 'POST',
                          body: JSON.stringify({
                            semi_major_axis_m: elements.semi_major_axis_m,
                            eccentricity: elements.eccentricity,
                            mu_m3_s2: o.config.mu_m3_s2,
                            reference_radius_m: o.config.reference_radius_m,
                            j2: o.config.j2,
                          }),
                        },
                      );
                      if (value.inclination_deg == null)
                        setError('No first-order SSO inclination exists for these inputs.');
                      else
                        edit((d) => {
                          if (
                            d.orbit.elements?.semi_major_axis_m === elements.semi_major_axis_m &&
                            d.orbit.elements.eccentricity === elements.eccentricity
                          )
                            d.orbit.elements.inclination_deg = value.inclination_deg!;
                        });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Reference calculation failed');
                    }
                  }}
                >
                  iₛₛₒ · first order
                </button>
              </>
            )}
            <Numeric
              label="Duration"
              unit="s"
              value={o.duration_s}
              min={0}
              onChange={(v) =>
                edit((d) => {
                  d.orbit.duration_s = v;
                })
              }
            />
            <Numeric
              label="Physics step"
              unit="s"
              value={o.config.step_s}
              min={0.001}
              onChange={(v) =>
                edit((d) => {
                  d.orbit.config.step_s = v;
                })
              }
            />
            <Numeric
              label="Output step"
              unit="s"
              value={o.output_step_s}
              min={0.001}
              onChange={(v) =>
                edit((d) => {
                  d.orbit.output_step_s = v;
                })
              }
            />
            <details>
              <summary>Cartesian initial state & gravity</summary>
              <Numeric
                label="Reference R"
                unit="m"
                value={o.config.reference_radius_m}
                min={1}
                onChange={(v) =>
                  edit((d) => {
                    d.orbit.config.reference_radius_m = v;
                  })
                }
              />
              <Numeric
                label="J₂"
                value={o.config.j2}
                min={-0.1}
                max={0.1}
                step={0.000001}
                onChange={(v) =>
                  edit((d) => {
                    d.orbit.config.j2 = v;
                  })
                }
              />
              <Numeric
                label="Gravitational μ"
                unit="m³/s²"
                value={o.config.mu_m3_s2}
                min={1e-12}
                step={1e10}
                onChange={(v) =>
                  edit((d) => {
                    d.orbit.config.mu_m3_s2 = v;
                  })
                }
              />
              {o.initialization === 'cartesian' &&
                axes.map((axis, i) => (
                  <Numeric
                    key={`r${i}`}
                    label={`Position ${axis}`}
                    unit="km"
                    value={o.initial.position_m[i] / 1000}
                    onChange={(v) =>
                      edit((d) => {
                        d.orbit.initial.position_m[i] = v * 1000;
                      })
                    }
                  />
                ))}
              {o.initialization === 'cartesian' &&
                axes.map((axis, i) => (
                  <Numeric
                    key={`v${i}`}
                    label={`Velocity ${axis}`}
                    unit="m/s"
                    value={o.initial.velocity_m_s[i]}
                    onChange={(v) =>
                      edit((d) => {
                        d.orbit.initial.velocity_m_s[i] = v;
                      })
                    }
                  />
                ))}
            </details>
            {orbit && (
              <dl className="dynamics-diagnostics">
                <dt>Max relative Δenergy</dt>
                <dd>{scientific(orbit.result.maximum_relative_energy_change)}</dd>
                <dt>Max scaled ΔHz</dt>
                <dd>{scientific(orbit.result.maximum_scaled_axial_angular_momentum_change)}</dd>
                <dt>Fitted Ω rate</dt>
                <dd>
                  {orbit.nodes?.fitted_raan_rate_deg_day == null
                    ? '—'
                    : `${orbit.nodes.fitted_raan_rate_deg_day.toFixed(5)} deg/day`}
                </dd>
                <dt>Force evaluations</dt>
                <dd>{orbit.result.acceleration_evaluations}</dd>
              </dl>
            )}
          </>
        )}
        <button className="run-button" disabled={busy} onClick={run}>
          {busy ? 'Computing…' : `Run ${mode === 'attitude' ? 'GNC' : 'propagation'} study`}
          {dirty ? ' · edited' : ''}
        </button>
        {busy && (
          <button
            className="dynamics-cancel"
            onClick={() => {
              request.current?.abort();
              setBusy(false);
            }}
          >
            Cancel request
          </button>
        )}
        {error && (
          <div className="study-error" role="alert">
            {error}
          </div>
        )}
        <details>
          <summary>Model & example limits</summary>
          <p>{config.evidence}</p>
          {(
            activeResult?.limits || [
              mode === 'attitude'
                ? 'Constant supplied inertial field and fixed target. Truth-state feedback; no estimator, IGRF or pass coupling.'
                : 'Conservative point-mass gravity. Verlet is symplectic here, with energy and phase error.',
            ]
          ).map((limit, i) => (
            <p key={i}>{limit}</p>
          ))}
          {attitude && mode === 'attitude' && (
            <p>
              Mechanical energy residual{' '}
              {scientific(attitude.samples.at(-1)?.energy_balance_residual_j)} J. MTQ watts are
              unresolved.
            </p>
          )}
        </details>
      </div>
    ) : (
      <div className="control-loading">{error || 'Loading dynamics inputs'}</div>
    );
  return (
    <section className="dynamics-lab" aria-label="Independent dynamics study">
      <div className="study-model">
        <Workbench
          variant={variant}
          asset={asset}
          preview={cutaway ? 'cutaway' : 'exterior'}
          starTrackerVisible={starTrackerVisible}
          moduleVisibility={moduleVisibility}
          quaternion={
            mode === 'attitude'
              ? attitude?.samples[index]?.state.q_body_from_inertial_wxyz
              : undefined
          }
          displayTime={mode === 'attitude' ? displayClock : undefined}
          quaternionTimes={mode === 'attitude' ? times : undefined}
          quaternionHistory={mode === 'attitude' ? quaternionHistory : undefined}
        />
        <span className="study-model-note">
          {mode === 'attitude' && attitude
            ? 'Computed rigid-body pose · nominal geometry'
            : 'Nominal geometry · independent study'}
        </span>
      </div>
      <div className="study-status">
        <strong>{mode === 'attitude' ? 'GNC' : 'ORBIT'}</strong>
        <span>
          {activeResult ? `T+ ${(times[index] ?? 0).toFixed(2)} s` : 'Run the standalone study'}
        </span>
        {dirty && <b>Unrun edits</b>}
      </div>
      {times.length > 1 && (
        <div className="dynamics-scrub" role="group" aria-label="Dynamics playback">
          <button
            type="button"
            onClick={() => {
              if (!playing && displayClock.current >= times.at(-1)!) scrub(times[0]);
              setPlaying((value) => !value);
            }}
            aria-label={playing ? 'Pause dynamics playback' : 'Play dynamics playback'}
          >
            {playing ? 'Pause' : 'Play'} · 1×
          </button>
          <span>Study time</span>
          <input
            aria-label="Dynamics study time"
            type="range"
            min={times[0]}
            max={times.at(-1)}
            step="any"
            value={Math.min(times.at(-1)!, Math.max(times[0], cursor))}
            onChange={(e) => scrub(e.target.valueAsNumber)}
          />
        </div>
      )}
      <div className="dynamics-plots">
        {plots.map((plot) => (
          <TracePlot
            key={`${mode}-${plot.title}`}
            {...plot}
            minimumSpan={plot.unit === 'flag' ? 1 : 0}
            times={times}
            cursorTime={cursor}
            onScrub={scrub}
          />
        ))}
        {!activeResult && <div className="study-empty">Choose inputs and run the study.</div>}
      </div>
      {inspectorTarget ? createPortal(controls, inspectorTarget) : controls}
    </section>
  );
}

function Numeric({
  label,
  value,
  onChange,
  unit = '',
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <span className="study-number">
        <input
          aria-label={label}
          type="number"
          value={Number(value.toPrecision(10))}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber))
              onChange(e.target.valueAsNumber);
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </label>
  );
}
