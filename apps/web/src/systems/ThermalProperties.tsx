import { useState } from 'react';
import type { PowerConfig } from './powerTypes';
import { NumberInput } from './StudyNumberInput';

export function ThermalProperties({
  config,
  edit,
}: {
  config: PowerConfig;
  edit: (change: (draft: PowerConfig) => void) => void;
}) {
  const [node, setNode] = useState('bus');
  const nodeIndex = config.thermal.nodes.findIndex((n) => n.node_id === node);
  const actualNodeIndex = Math.max(0, nodeIndex);
  const selectedNode = config.thermal.nodes[actualNodeIndex];
  return (
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
  );
}
