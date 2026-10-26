import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import { MissionModeLoads } from './MissionModeLoads';
import { MissionConopsControls } from './MissionConopsControls';

interface MaterialProfile {
  profile_id: string;
  label: string;
  status: 'unverified_assumption' | 'historical_reference';
  solar_absorptivity: number;
  infrared_emissivity: number;
  source: string;
  source_locator: string;
  conditions: string;
  limitations: string[];
}

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
  const [profiles, setProfiles] = useState<MaterialProfile[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    api<{ profiles: MaterialProfile[] }>('/api/mission/thermal-materials', { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setProfiles(result.profiles);
      })
      .catch(() => {});
    return () => abort.abort();
  }, []);
  const nodeId = selectedNodeId ?? localNodeId;
  const thermal = config.power.thermal;
  const nodeIndex = Math.max(
    0,
    thermal.nodes.findIndex((node) => node.node_id === nodeId),
  );
  const node = thermal.nodes[nodeIndex];
  if (!node) return null;
  const minimumAbsorptivity = Math.max(
    0,
    ...config.power.panels
      .filter((panel) => panel.thermal_node_id === node.node_id)
      .map((panel) => (panel.efficiency ?? 0) * (panel.electrical_derate ?? 1)),
  );
  const provenancePrefix = `Thermal optics for ${node.node_id}:`;
  const recordOptics = (draft: MissionConfig, source?: string) => {
    draft.provenance = draft.provenance.filter((line) => !line.startsWith(provenancePrefix));
    if (source) draft.provenance.push(`${provenancePrefix} ${source}`);
  };
  const selectedReference = config.provenance.find((line) => line.startsWith(provenancePrefix));
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
        {profiles.length > 0 && node.radiating_area_m2 > 0 && (
          <Select
            label="Optical preset"
            value=""
            options={[
              { value: '', label: 'Choose reference…' },
              ...profiles.map((profile) => ({
                value: profile.profile_id,
                label: profile.label,
                disabled: profile.solar_absorptivity < minimumAbsorptivity,
              })),
            ]}
            onChange={(id) => {
              const profile = profiles.find((item) => item.profile_id === id);
              if (!profile || profile.solar_absorptivity < minimumAbsorptivity) return;
              edit((draft) => {
                const target = draft.power.thermal.nodes[nodeIndex];
                target.solar_absorptivity = profile.solar_absorptivity;
                target.infrared_emissivity = profile.infrared_emissivity;
                draft.power.panels
                  .filter((panel) => panel.thermal_node_id === node.node_id)
                  .forEach((panel) => {
                    panel.solar_absorptivity = profile.solar_absorptivity;
                  });
                recordOptics(
                  draft,
                  `${profile.profile_id}; α=${profile.solar_absorptivity}, ε=${profile.infrared_emissivity}. ${profile.source} ${profile.source_locator}. ${profile.conditions} ${profile.limitations.join(' ')}`,
                );
              });
            }}
          />
        )}
        {node.node_id === config.spacecraft?.actuator_heat_node_id && (
          <small className="profile-evidence">
            Wheel/driver heat shares this node; no separate motor temperature.
          </small>
        )}
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
          min={minimumAbsorptivity}
          max={1}
          step={0.01}
          onChange={(v) =>
            edit((d) => {
              recordOptics(d);
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
              recordOptics(d);
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
        {selectedReference && (
          <details className="mission-details">
            <summary>Optical source</summary>
            <small>{selectedReference}</small>
          </details>
        )}
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
