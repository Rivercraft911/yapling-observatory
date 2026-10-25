import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Workbench } from '../Workbench';
import { TracePlot, closestIndex } from '../plots/TracePlot';
import type { AssetInfo, Variant } from '../types';
import type { PowerConfig, PowerResult, PowerSession, PowerStage } from './powerTypes';
import './systems.css';

const colors = ['#e4ddd4', '#d96773', '#9fb9c4', '#c6ac7a', '#b0aaa6', '#9ba693'];
const names: Record<string, string> = {
  sun_pointing: 'Sun pointing',
  ground_tracking: 'Ground pass',
  imaging: 'Imaging',
  detumble: 'Detumble',
};
const display = (n: number | undefined, d = 2) => (n == null ? '—' : n.toFixed(d));
export function PowerLab({
  session,
  onSession,
  inspectorTarget,
  asset,
  variant,
  cutaway,
  starTrackerVisible,
  section,
}: {
  session: PowerSession;
  onSession: Dispatch<SetStateAction<PowerSession>>;
  inspectorTarget: HTMLElement | null;
  asset?: AssetInfo;
  variant: Variant;
  cutaway: boolean;
  starTrackerVisible: boolean;
  section: 'power' | 'thermal';
}) {
  const { config, result } = session;
  const [templates, setTemplates] = useState<
    Record<string, Pick<PowerStage, 'mode' | 'loads' | 'sun_direction_body'>>
  >({});
  useEffect(() => {
    const abort = new AbortController();
    api<typeof templates>('/api/power-lab/stage-templates', { signal: abort.signal })
      .then(setTemplates)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => abort.abort();
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [phase, setPhase] = useState(0),
    [node, setNode] = useState('battery'),
    [cursor, setCursor] = useState(0);
  const [editor, setEditor] = useState<'loads' | 'arrays' | 'battery' | 'stages'>('loads');
  useEffect(() => {
    if (config) return;
    const abort = new AbortController();
    api<PowerConfig>('/api/power-lab/default', { signal: abort.signal })
      .then((value) => onSession({ config: value, result: null }))
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => abort.abort();
  }, [config, onSession]);
  const edit = (change: (draft: PowerConfig) => void) => {
    if (!config) return;
    const draft = structuredClone(config);
    change(draft);
    onSession({ config: draft, result });
  };
  const run = async () => {
    if (!config) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<PowerResult>('/api/power-lab/study', {
        method: 'POST',
        body: JSON.stringify(config),
      });
      onSession((current) => ({ ...current, result: next }));
      setCursor(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Study failed');
    } finally {
      setBusy(false);
    }
  };
  const dirty =
    !!config && !!result && JSON.stringify(config) !== JSON.stringify(result.manifest.config);
  const samples = result?.samples,
    times = samples?.time_s || [];
  const index = closestIndex(times, cursor);
  const plots = useMemo(() => {
    if (!samples) return [];
    if (section === 'thermal')
      return [
        {
          title: 'Temperature',
          unit: '°C',
          traces: Object.entries(samples.node_temperature_k).map(([id, values], i) => ({
            label: id,
            color: colors[i % colors.length],
            values: values.map((t) => t - 273.15),
          })),
        },
        {
          title: 'Internal heat',
          unit: 'W',
          traces: Object.entries(samples.component_heat_w).map(([id, values], i) => ({
            label: id,
            color: colors[i % colors.length],
            values,
          })),
        },
        {
          title: 'Sun visibility',
          unit: 'ratio',
          traces: [{ label: 'Sun', color: colors[0], values: samples.sun_visibility }],
        },
      ];
    return [
      {
        title: 'Electrical power',
        unit: 'W',
        traces: [
          { label: 'PV bus', color: colors[0], values: samples.generated_bus_w },
          { label: 'Demand', color: colors[1], values: samples.requested_load_w },
          { label: 'Potential net', color: colors[2], values: samples.net_bus_w },
        ],
      },
      {
        title: 'Stored energy',
        unit: 'Wh',
        traces: [{ label: 'Battery', color: colors[0], values: samples.stored_energy_wh }],
      },
      {
        title: 'Battery temperature',
        unit: '°C',
        traces: [
          {
            label: 'Battery node',
            color: colors[2],
            values: (samples.node_temperature_k.battery || []).map((t) => t - 273.15),
          },
        ],
      },
    ];
  }, [samples, section]);
  const selectedStage = config?.stages[Math.min(phase, config.stages.length - 1)];
  const nodeIndex = config?.thermal.nodes.findIndex((n) => n.node_id === node) ?? -1;
  const selectedNode = nodeIndex >= 0 ? config!.thermal.nodes[nodeIndex] : config?.thermal.nodes[0];
  const actualNodeIndex = Math.max(0, nodeIndex);
  const controls = config ? (
    <div className="systems-controls">
      <div className="controls-title">
        <span className="eyebrow">
          {section === 'thermal' ? 'THERMAL NETWORK' : 'POWER & AVIONICS'}
        </span>
      </div>
      <div
        className="study-scope"
        title="Prescribed phase timing and Sun directions. This study does not yet use the Earth tab's orbit or physical controller."
      >
        Prescribed CONOPS study
      </div>
      {section === 'power' ? (
        <>
          <nav className="systems-subtabs" aria-label="Power inputs">
            {(['loads', 'arrays', 'battery', 'stages'] as const).map((id) => (
              <button key={id} aria-pressed={editor === id} onClick={() => setEditor(id)}>
                {id === 'loads'
                  ? 'Avionics'
                  : id === 'arrays'
                    ? 'Solar'
                    : id === 'battery'
                      ? 'Battery'
                      : 'CONOPS'}
              </button>
            ))}
          </nav>
          {editor === 'loads' && (
            <fieldset>
              <legend>PHASE LOADS</legend>
              <label className="field-row">
                <span>Phase</span>
                <select
                  value={phase}
                  onChange={(e) => setPhase(+e.target.value)}
                  aria-label="Load phase"
                >
                  {config.stages.map((s, i) => (
                    <option value={i} key={s.stage_id}>
                      {names[s.mode]} · {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              {selectedStage?.loads.map((load, i) => (
                <div className="study-component" key={load.component_id}>
                  <strong>{load.component_id.toUpperCase()}</strong>
                  <NumberInput
                    label="Electrical"
                    unit="W"
                    value={load.electrical_w}
                    min={0}
                    onChange={(v) =>
                      edit((d) => {
                        d.stages[phase].loads[i].electrical_w = v;
                      })
                    }
                  />
                  {(load.component_id === 'radio' || load.escaped_rf_w > 0) && (
                    <NumberInput
                      label="Escaped RF"
                      unit="W"
                      value={load.escaped_rf_w}
                      min={0}
                      onChange={(v) =>
                        edit((d) => {
                          d.stages[phase].loads[i].escaped_rf_w = v;
                        })
                      }
                    />
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {editor === 'arrays' && (
            <>
              {config.panels.map((panel, i) => (
                <fieldset key={panel.panel_id}>
                  <legend>{panel.panel_id}</legend>
                  <label className="spacecraft-follow">
                    <input
                      type="checkbox"
                      checked={panel.enabled}
                      onChange={(e) =>
                        edit((d) => {
                          d.panels[i].enabled = e.target.checked;
                        })
                      }
                    />
                    Enabled
                  </label>
                  <NumberInput
                    label="Active area"
                    unit="m²"
                    value={panel.active_area_m2}
                    min={0}
                    step={0.001}
                    onChange={(v) =>
                      edit((d) => {
                        d.panels[i].active_area_m2 = v;
                      })
                    }
                  />
                  <NumberInput
                    label="Efficiency"
                    unit="%"
                    value={panel.efficiency * 100}
                    min={0}
                    max={100}
                    onChange={(v) =>
                      edit((d) => {
                        d.panels[i].efficiency = v / 100;
                      })
                    }
                  />
                  <NumberInput
                    label="Electrical derate"
                    unit="%"
                    value={panel.electrical_derate * 100}
                    min={0}
                    max={100}
                    onChange={(v) =>
                      edit((d) => {
                        d.panels[i].electrical_derate = v / 100;
                      })
                    }
                  />
                </fieldset>
              ))}
              <small className="study-scope">Area is provisional; CAD mapping pending.</small>
              <NumberInput
                label="Regulator efficiency"
                unit="%"
                value={config.regulator_efficiency * 100}
                min={1}
                max={100}
                onChange={(v) =>
                  edit((d) => {
                    d.regulator_efficiency = v / 100;
                  })
                }
              />
            </>
          )}
          {editor === 'battery' && (
            <fieldset>
              <legend>NCR18650GA / PACK</legend>
              <label className="field-row">
                <span>Capacity basis</span>
                <select
                  aria-label="Battery capacity basis"
                  value={config.battery.cells ? 'cells' : 'energy'}
                  onChange={async (e) => {
                    if (e.target.value === 'energy') {
                      try {
                        const capacity = await api<{ capacity_wh: number }>(
                          '/api/power-lab/capacity',
                          {
                            method: 'POST',
                            body: JSON.stringify(config.battery),
                          },
                        );
                        edit((d) => {
                          d.battery.cells = null;
                          d.battery.total_capacity_wh = capacity.capacity_wh;
                        });
                      } catch (e) {
                        setError(e instanceof Error ? e.message : 'Capacity conversion failed');
                      }
                    } else
                      edit((d) => {
                        d.battery.total_capacity_wh = null;
                        d.battery.cells = {
                          cell_model: 'NCR18650GA',
                          cell_capacity_mah: 3350,
                          cell_nominal_voltage_v: 3.6,
                          series_count: 2,
                          parallel_count: 2,
                          capacity_basis: 'User-edited nominal capacity estimate',
                        };
                      });
                  }}
                >
                  <option value="cells">Cell configuration</option>
                  <option value="energy">Total Wh</option>
                </select>
              </label>
              {config.battery.cells ? (
                <>
                  <NumberInput
                    label="Cell capacity"
                    unit="mAh"
                    value={config.battery.cells.cell_capacity_mah}
                    min={1}
                    onChange={(v) =>
                      edit((d) => {
                        d.battery.cells!.cell_capacity_mah = v;
                      })
                    }
                  />
                  <NumberInput
                    label="Nominal voltage"
                    unit="V"
                    value={config.battery.cells.cell_nominal_voltage_v}
                    min={0.1}
                    onChange={(v) =>
                      edit((d) => {
                        d.battery.cells!.cell_nominal_voltage_v = v;
                      })
                    }
                  />
                  <NumberInput
                    label="Series"
                    value={config.battery.cells.series_count}
                    min={1}
                    step={1}
                    onChange={(v) =>
                      edit((d) => {
                        d.battery.cells!.series_count = v;
                      })
                    }
                  />
                  <NumberInput
                    label="Parallel"
                    value={config.battery.cells.parallel_count}
                    min={1}
                    step={1}
                    onChange={(v) =>
                      edit((d) => {
                        d.battery.cells!.parallel_count = v;
                      })
                    }
                  />
                </>
              ) : (
                <NumberInput
                  label="Total capacity"
                  unit="Wh"
                  value={config.battery.total_capacity_wh!}
                  min={0.01}
                  onChange={(v) =>
                    edit((d) => {
                      d.battery.total_capacity_wh = v;
                    })
                  }
                />
              )}
              <NumberInput
                label="Initial stored energy"
                unit="%"
                value={config.battery.initial_energy_fraction * 100}
                min={0}
                max={100}
                onChange={(v) =>
                  edit((d) => {
                    d.battery.initial_energy_fraction = v / 100;
                  })
                }
              />
              <NumberInput
                label="Charge limit"
                unit="W"
                value={config.battery.max_charge_bus_w}
                min={0}
                onChange={(v) =>
                  edit((d) => {
                    d.battery.max_charge_bus_w = v;
                  })
                }
              />
              <NumberInput
                label="Discharge limit"
                unit="W"
                value={config.battery.max_discharge_bus_w}
                min={0}
                onChange={(v) =>
                  edit((d) => {
                    d.battery.max_discharge_bus_w = v;
                  })
                }
              />
              <small className="study-scope">
                Nominal energy estimate. No voltage or cell-aging model.
              </small>
            </fieldset>
          )}
          {editor === 'stages' && (
            <fieldset>
              <legend>OPERATIONS</legend>
              {config.stages.map((stage, i) => (
                <div className="study-component" key={stage.stage_id}>
                  <label className="field-row">
                    <span>Stage {i + 1}</span>
                    <select
                      aria-label={`Stage ${i + 1} mode`}
                      value={stage.mode}
                      disabled={!templates[stage.mode]}
                      title="Applies the mode's provisional loads and Sun direction"
                      onChange={(e) =>
                        edit((d) => {
                          Object.assign(d.stages[i], structuredClone(templates[e.target.value]));
                        })
                      }
                    >
                      {Object.entries(names).map(([id, label]) => (
                        <option value={id} key={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberInput
                    label="Duration"
                    unit="s"
                    value={stage.end_s - stage.start_s}
                    min={1}
                    onChange={(v) =>
                      edit((d) => {
                        const delta = v - (d.stages[i].end_s - d.stages[i].start_s);
                        d.stages[i].end_s += delta;
                        for (let j = i + 1; j < d.stages.length; j++) {
                          d.stages[j].start_s += delta;
                          d.stages[j].end_s += delta;
                        }
                      })
                    }
                  />
                  <details>
                    <summary>Sun direction in body axes</summary>
                    {stage.sun_direction_body.map((value, j) => (
                      <NumberInput
                        key={j}
                        label={['X', 'Y', 'Z'][j]}
                        value={value}
                        min={-1}
                        max={1}
                        step={0.01}
                        onChange={(v) =>
                          edit((d) => {
                            d.stages[i].sun_direction_body[j] = v;
                          })
                        }
                      />
                    ))}
                  </details>
                </div>
              ))}
              <small className="study-scope">
                Mode presets set loads and Sun direction. Both remain editable.
              </small>
              <details>
                <summary>Manual imaging windows</summary>
                {config.imaging_windows.map((window, i) => (
                  <div className="study-component" key={window.stage_id}>
                    <NumberInput
                      label="Start"
                      unit="s"
                      value={window.start_s}
                      min={0}
                      onChange={(v) =>
                        edit((d) => {
                          d.imaging_windows[i].start_s = v;
                        })
                      }
                    />
                    <NumberInput
                      label="End"
                      unit="s"
                      value={window.end_s}
                      min={0}
                      onChange={(v) =>
                        edit((d) => {
                          d.imaging_windows[i].end_s = v;
                        })
                      }
                    />
                    <button
                      className="text-button"
                      onClick={() =>
                        edit((d) => {
                          d.imaging_windows.splice(i, 1);
                        })
                      }
                    >
                      Remove window
                    </button>
                  </div>
                ))}
                <button
                  className="text-button"
                  disabled={
                    !templates.imaging ||
                    (config.imaging_windows.at(-1)?.end_s ?? 0) >= config.stages.at(-1)!.end_s
                  }
                  onClick={() =>
                    edit((d) => {
                      const start = d.imaging_windows.at(-1)?.end_s ?? 0;
                      d.imaging_windows.push({
                        ...structuredClone(templates.imaging),
                        stage_id: `imaging_${Date.now()}`,
                        start_s: start,
                        end_s: Math.min(start + 60, d.stages.at(-1)!.end_s),
                      });
                    })
                  }
                >
                  Add imaging window
                </button>
              </details>
              <details>
                <summary>Prescribed eclipse windows</summary>
                {config.eclipse_windows.map((window, i) => (
                  <div className="study-component" key={i}>
                    <NumberInput
                      label="Start"
                      unit="s"
                      value={window.start_s}
                      min={0}
                      onChange={(v) =>
                        edit((d) => {
                          d.eclipse_windows[i].start_s = v;
                        })
                      }
                    />
                    <NumberInput
                      label="End"
                      unit="s"
                      value={window.end_s}
                      min={0}
                      onChange={(v) =>
                        edit((d) => {
                          d.eclipse_windows[i].end_s = v;
                        })
                      }
                    />
                    <NumberInput
                      label="Sun visible"
                      unit="%"
                      value={window.sun_visibility * 100}
                      min={0}
                      max={100}
                      onChange={(v) =>
                        edit((d) => {
                          d.eclipse_windows[i].sun_visibility = v / 100;
                        })
                      }
                    />
                    <button
                      className="text-button"
                      onClick={() =>
                        edit((d) => {
                          d.eclipse_windows.splice(i, 1);
                        })
                      }
                    >
                      Remove eclipse
                    </button>
                  </div>
                ))}
                <button
                  className="text-button"
                  disabled={
                    (config.eclipse_windows.at(-1)?.end_s ?? 0) >= config.stages.at(-1)!.end_s
                  }
                  onClick={() =>
                    edit((d) => {
                      const start = d.eclipse_windows.at(-1)?.end_s ?? 0;
                      d.eclipse_windows.push({
                        start_s: start,
                        end_s: Math.min(start + 60, d.stages.at(-1)!.end_s),
                        sun_visibility: 0,
                      });
                    })
                  }
                >
                  Add eclipse window
                </button>
              </details>
            </fieldset>
          )}
        </>
      ) : (
        selectedNode && (
          <fieldset>
            <legend>THERMAL NODE</legend>
            <label className="field-row">
              <span>Node</span>
              <select
                aria-label="Thermal node"
                value={selectedNode.node_id}
                onChange={(e) => setNode(e.target.value)}
              >
                {config.thermal.nodes.map((n) => (
                  <option key={n.node_id} value={n.node_id}>
                    {n.node_id}
                  </option>
                ))}
              </select>
            </label>
            <NumberInput
              label="Initial temperature"
              unit="°C"
              value={selectedNode.initial_temperature_k - 273.15}
              min={-273.14}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].initial_temperature_k = v + 273.15;
                })
              }
            />
            <NumberInput
              label="Heat capacity"
              unit="J/K"
              value={selectedNode.heat_capacity_j_k}
              min={0.01}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].heat_capacity_j_k = v;
                })
              }
            />
            <NumberInput
              label="Radiating area"
              unit="m²"
              value={selectedNode.radiating_area_m2}
              min={0}
              step={0.001}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].radiating_area_m2 = v;
                })
              }
            />
            <NumberInput
              label="Solar absorptivity"
              value={selectedNode.solar_absorptivity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].solar_absorptivity = v;
                  d.panels
                    .filter((p) => p.thermal_node_id === selectedNode.node_id)
                    .forEach((p) => {
                      p.solar_absorptivity = v;
                    });
                })
              }
            />
            <NumberInput
              label="IR emissivity"
              value={selectedNode.infrared_emissivity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].infrared_emissivity = v;
                })
              }
            />
            <NumberInput
              label="Space view factor"
              value={selectedNode.space_view_factor}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) =>
                edit((d) => {
                  d.thermal.nodes[actualNodeIndex].space_view_factor = v;
                })
              }
            />
            <details>
              <summary>Conductive connections</summary>
              {config.thermal.conductive_links.map((link, i) =>
                link.first === selectedNode.node_id || link.second === selectedNode.node_id ? (
                  <NumberInput
                    key={i}
                    label={link.first === selectedNode.node_id ? link.second : link.first}
                    unit="W/K"
                    value={link.conductance_w_k}
                    min={0}
                    step={0.01}
                    onChange={(v) =>
                      edit((d) => {
                        d.thermal.conductive_links[i].conductance_w_k = v;
                      })
                    }
                  />
                ) : null,
              )}
            </details>
          </fieldset>
        )
      )}
      <details>
        <summary>Numerics & assumptions</summary>
        <NumberInput
          label="Integration step"
          unit="s"
          value={config.integration_step_s}
          min={0.01}
          onChange={(v) =>
            edit((d) => {
              d.integration_step_s = v;
            })
          }
        />
        <NumberInput
          label="Output step"
          unit="s"
          value={config.output_step_s}
          min={0.01}
          onChange={(v) =>
            edit((d) => {
              d.output_step_s = v;
            })
          }
        />
        {config.provenance.map((s, i) => (
          <p key={i}>{s}</p>
        ))}
      </details>
      <button className="run-button" disabled={busy} onClick={run}>
        {busy ? 'Computing…' : 'Run power & thermal study'}
        {dirty ? ' · edited' : ''}
      </button>
      {error && (
        <div className="study-error" role="alert">
          {error}
        </div>
      )}
      {result && (
        <details>
          <summary>Energy closure & model limits</summary>
          <p>Energy residual {result.summary.first_law_residual_j.toExponential(2)} J</p>
          {result.manifest.limits.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </details>
      )}
    </div>
  ) : (
    <div className="control-loading">{error || 'Loading study inputs'}</div>
  );
  return (
    <section className="power-lab" aria-label="Power and thermal study">
      <div className="study-model">
        <Workbench
          variant={variant}
          asset={asset}
          preview={cutaway ? 'cutaway' : 'exterior'}
          starTrackerVisible={starTrackerVisible}
        />
        <span className="study-model-note">Geometry preview · prescribed study below</span>
      </div>
      <div className="study-status">
        <strong>{section === 'thermal' ? 'THERMAL' : 'POWER'}</strong>
        <span>
          {result
            ? `T+ ${display(times[index], 0)} s · ${names[samples!.mode[index]]}`
            : 'Run the study to compute histories'}
        </span>
        {dirty && <b>Unrun edits</b>}
      </div>
      <div className="study-plots">
        {plots.map((p) => (
          <TracePlot key={p.title} {...p} times={times} cursorTime={cursor} onScrub={setCursor} />
        ))}
        {!result && <div className="study-empty">Set phase loads and run the study.</div>}
      </div>
      {result && section === 'thermal' && (
        <div className="study-stage-summary">
          <table>
            <thead>
              <tr>
                <th>Node</th>
                <th>Minimum °C</th>
                <th>Maximum °C</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(result.summary.node_minimum_k).map((id) => (
                <tr key={id}>
                  <td>{id}</td>
                  <td>{display(result.summary.node_minimum_k[id] - 273.15)}</td>
                  <td>{display(result.summary.node_maximum_k[id] - 273.15)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && section === 'power' && (
        <div className="study-stage-summary">
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>PV bus W</th>
                <th>Load W</th>
                <th>Potential net W</th>
                <th>Battery ΔWh</th>
              </tr>
            </thead>
            <tbody>
              {result.stages.map((s) => (
                <tr key={s.stage_id}>
                  <td>{names[s.mode]}</td>
                  <td>{display(s.mean_generated_bus_w)}</td>
                  <td>{display(s.mean_requested_load_w)}</td>
                  <td>{display(s.mean_net_bus_w)}</td>
                  <td>{display(s.chemical_storage_delta_j / 3600)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inspectorTarget ? createPortal(controls, inspectorTarget) : controls}
    </section>
  );
}
function NumberInput({
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
          value={Number(value.toFixed(6))}
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
