import { useState } from 'react';
import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import { MissionModeLoads } from './MissionModeLoads';
import { MissionConopsControls } from './MissionConopsControls';

export function MissionThermalControls({
  config,
  edit,
  nodeId: selectedNodeId,
  onNodeChange,
}: {
  config: MissionConfig;
  nodeId?: string;
  onNodeChange?: (node: string) => void;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const [localNodeId, setLocalNodeId] = useState('bus');
  const nodeId = selectedNodeId ?? localNodeId;
  const thermal = config.power.thermal;
  const nodeIndex = Math.max(
    0,
    thermal.nodes.findIndex((node) => node.node_id === nodeId),
  );
  const node = thermal.nodes[nodeIndex];
  if (!node) return null;
  return (
    <>
      <fieldset>
        <legend>
          THERMAL PROPERTIES <span>next run</span>
        </legend>
        <Select
          label="Node"
          value={node.node_id}
          onChange={onNodeChange ?? setLocalNodeId}
          options={thermal.nodes.map((item) => ({ value: item.node_id, label: item.node_id }))}
        />
        <Field
          label="Initial temperature"
          unit="°C"
          value={node.initial_temperature_k - 273.15}
          min={-273.14}
          max={1e6}
          step={1}
          onChange={(v) =>
            edit((d) => {
              d.power.thermal.nodes[nodeIndex].initial_temperature_k = v + 273.15;
            })
          }
        />
        <Field
          label="Heat capacity"
          unit="J/K"
          value={node.heat_capacity_j_k}
          min={0.000001}
          max={1e12}
          step={1}
          onChange={(v) =>
            edit((d) => {
              d.power.thermal.nodes[nodeIndex].heat_capacity_j_k = v;
            })
          }
        />
        <Field
          label="Solar absorptivity α"
          unit=""
          value={node.solar_absorptivity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) =>
            edit((d) => {
              d.power.thermal.nodes[nodeIndex].solar_absorptivity = v;
              d.power.panels
                .filter((panel) => panel.thermal_node_id === node.node_id)
                .forEach((panel) => {
                  panel.solar_absorptivity = v;
                });
            })
          }
        />
        <Field
          label="IR emissivity ε"
          unit=""
          value={node.infrared_emissivity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) =>
            edit((d) => {
              d.power.thermal.nodes[nodeIndex].infrared_emissivity = v;
            })
          }
        />
        <Field
          label="Radiating area"
          unit="m²"
          value={node.radiating_area_m2}
          min={0}
          max={1e6}
          step={0.001}
          onChange={(v) =>
            edit((d) => {
              d.power.thermal.nodes[nodeIndex].radiating_area_m2 = v;
            })
          }
        />
        <details className="mission-details">
          <summary>Conductive connections</summary>
          {thermal.conductive_links.filter(
            (link) => link.first === node.node_id || link.second === node.node_id,
          ).length ? (
            thermal.conductive_links.map((link, index) =>
              link.first === node.node_id || link.second === node.node_id ? (
                <Field
                  key={index}
                  label={link.first === node.node_id ? link.second : link.first}
                  unit="W/K"
                  value={link.conductance_w_k}
                  min={0}
                  max={1e9}
                  step={0.01}
                  onChange={(v) =>
                    edit((d) => {
                      d.power.thermal.conductive_links[index].conductance_w_k = v;
                    })
                  }
                />
              ) : null,
            )
          ) : (
            <small>No conductive connections.</small>
          )}
        </details>
        <details className="mission-details">
          <summary>Ambient space</summary>
          <Field
            label="Space view factor"
            unit=""
            value={node.space_view_factor}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) =>
              edit((d) => {
                d.power.thermal.nodes[nodeIndex].space_view_factor = v;
              })
            }
          />
          <small>
            Weights incident ambient-space IR. Exterior emission uses the declared radiating area.
          </small>
        </details>
        <small className="profile-evidence">
          Click a mapped part to inspect its node. Constant α/ε; finish and contacts are
          provisional. Edits apply to the next run.
        </small>
      </fieldset>
      <MissionModeLoads config={config} edit={edit} />
      <details className="mission-details">
        <summary>CONOPS</summary>
        <MissionConopsControls config={config} edit={edit} />
      </details>
    </>
  );
}
