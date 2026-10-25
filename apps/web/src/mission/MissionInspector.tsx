import { useState } from 'react';
import { Field, Select, RadioControls } from '../controls/RadioControls';
import type { RadioCatalog } from '../types';
import { OrbitalElementsFields } from '../systems/OrbitalElementsFields';
import { MissionHardware } from './MissionHardware';
import { MissionArchiveControls } from './MissionArchiveControls';
import { MissionPowerControls } from './MissionPowerControls';
import { MissionConopsControls } from './MissionConopsControls';
import { MissionThermalControls } from './MissionThermalControls';
import type { MissionSession } from './useMission';
import './mission.css';

export function MissionInspector({
  mission,
  catalog,
  onRun,
  onInspect,
  canPin,
  hasBaseline,
  onPin,
}: {
  mission: MissionSession;
  catalog: RadioCatalog;
  onRun: () => void;
  onInspect: () => void;
  canPin: boolean;
  hasBaseline: boolean;
  onPin: () => void;
}) {
  const [section, setSection] = useState<'orbit' | 'link' | 'gnc' | 'power' | 'thermal' | 'conops'>(
    'orbit',
  );
  const { config, edit, resolveOrbit } = mission;
  if (!config)
    return (
      <div className="offline-note">
        <MissionArchiveControls mission={mission} />
        {mission.loading ? 'Loading mission' : 'Mission unavailable'}
        {!mission.loading && <button onClick={mission.reload}>Reconnect</button>}
      </div>
    );
  const orbit = config.orbit;
  return (
    <>
      <div className="controls-title">
        <span className="eyebrow">MISSION</span>
        <button
          className="text-button"
          onClick={mission.reload}
          disabled={mission.busy || mission.importing}
          title="Load the current starting mission"
        >
          Reset
        </button>
        <button className="text-button" onClick={onInspect}>
          Inputs ↗
        </button>
        <MissionArchiveControls mission={mission} />
      </div>
      <nav className="spacecraft-sections" aria-label="Mission controls">
        {(['orbit', 'link', 'gnc', 'power', 'thermal', 'conops'] as const).map((tab) => (
          <button key={tab} aria-pressed={section === tab} onClick={() => setSection(tab)}>
            {tab === 'gnc'
              ? 'GNC'
              : tab === 'conops'
                ? 'CONOPS'
                : tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      <div className="mission-controls-body">
        {section === 'orbit' && (
          <>
            <div className="mission-run-kinds" aria-label="Run scope">
              {[
                { id: 'long_mission', label: 'Mission', duration: 86400 },
                { id: 'single_pass', label: 'Short run', duration: 3600 },
                { id: 'targeted', label: 'Targeted', duration: 3600 },
              ].map((choice) => (
                <button
                  key={choice.id}
                  aria-pressed={config.run_kind === choice.id}
                  onClick={() => {
                    edit((d) => {
                      d.run_kind = choice.id as typeof config.run_kind;
                      d.duration_s = choice.duration;
                      d.conops.windows = d.conops.windows.filter((w) => w.end_s <= d.duration_s);
                      if (choice.id === 'targeted' && !d.conops.windows.length)
                        d.conops.windows.push({
                          window_id: 'target-example',
                          start_s: 0,
                          end_s: 300,
                          mode: 'imaging',
                          target_latitude_deg: d.station.latitude_deg,
                          target_longitude_deg: d.station.longitude_deg,
                        });
                    });
                    if (choice.id === 'targeted') setSection('conops');
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <Field
              label="Duration"
              unit="h"
              value={config.duration_s / 3600}
              min={1 / 3}
              max={168}
              step={1}
              onChange={(v) =>
                edit((d) => {
                  d.duration_s = v * 3600;
                })
              }
            />
            <OrbitalElementsFields
              value={orbit.elements}
              onChange={(elements) => void resolveOrbit({ ...orbit, elements, preset: null })}
            />
            <Field
              label="LTAN"
              unit="h"
              value={orbit.ltan_hours_at_epoch}
              min={0}
              max={23.999}
              step={0.25}
              onChange={(v) => void resolveOrbit(orbit, v)}
            />
            <div className="mission-presets" aria-label="Sun synchronous presets">
              <button onClick={() => void resolveOrbit(orbit, 18, true)}>Dusk 18:00</button>
              <button onClick={() => void resolveOrbit(orbit, 6, true)}>Dawn 06:00</button>
            </div>
            <details className="mission-details">
              <summary>Propagation</summary>
              <Select
                label="Integrator"
                value={orbit.method}
                options={[
                  { value: 'rk4', label: 'RK4' },
                  { value: 'velocity_verlet', label: 'Velocity Verlet' },
                ]}
                onChange={(v) =>
                  edit((d) => {
                    d.orbit.method = v as typeof orbit.method;
                  })
                }
              />
              <Select
                label="Gravity"
                value={orbit.force_model}
                options={[
                  { value: 'central', label: 'Central' },
                  { value: 'j2', label: 'Central + J2' },
                ]}
                onChange={(v) =>
                  edit((d) => {
                    d.orbit.force_model = v as typeof orbit.force_model;
                  })
                }
              />
              <Field
                label="Δt dynamics"
                unit="s"
                value={config.clocks.dynamics_step_s}
                min={0.02}
                max={10}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    d.clocks.dynamics_step_s = v;
                    d.clocks.fidelity = 'user-edited';
                  })
                }
              />
              <Field
                label="Δt controller"
                unit="s"
                value={config.clocks.controller_period_s}
                min={0.02}
                max={60}
                step={0.1}
                onChange={(v) =>
                  edit((d) => {
                    d.clocks.controller_period_s = v;
                    d.clocks.fidelity = 'user-edited';
                  })
                }
              />
              <Field
                label="Δt output"
                unit="s"
                value={config.clocks.output_step_s}
                min={0.02}
                max={600}
                step={10}
                onChange={(v) =>
                  edit((d) => {
                    d.clocks.output_step_s = v;
                  })
                }
              />
              <small>
                Osculating initial elements. SSO presets use first-order mean J2; LTAN uses mean
                solar time at epoch.
              </small>
            </details>
            <details className="mission-details">
              <summary>Ground station</summary>
              <Field
                label="φ"
                unit="deg"
                value={config.station.latitude_deg}
                min={-90}
                max={90}
                step={0.01}
                onChange={(v) =>
                  edit((d) => {
                    d.station.latitude_deg = v;
                  })
                }
              />
              <Field
                label="λ"
                unit="deg"
                value={config.station.longitude_deg}
                min={-180}
                max={180}
                step={0.01}
                onChange={(v) =>
                  edit((d) => {
                    d.station.longitude_deg = v;
                  })
                }
              />
              <Field
                label="h"
                unit="m"
                value={config.station.height_m}
                min={-500}
                max={10000}
                step={1}
                onChange={(v) =>
                  edit((d) => {
                    d.station.height_m = v;
                  })
                }
              />
              <Field
                label="Elevation mask"
                unit="deg"
                value={config.station.minimum_elevation_deg}
                min={0}
                max={90}
                step={1}
                onChange={(v) =>
                  edit((d) => {
                    d.station.minimum_elevation_deg = v;
                  })
                }
              />
            </details>
          </>
        )}
        {section === 'link' && (
          <>
            {(['uplink', 'downlink'] as const).map((direction) => (
              <RadioControls
                key={direction}
                direction={direction}
                link={config[direction]}
                antennaVariant={config.antenna_variant}
                catalog={catalog}
                onChange={(change) => edit((d) => change(d[direction]))}
              />
            ))}
            <Field
              label="Direction slot"
              unit="s"
              value={config.schedule.slot_duration_s}
              min={2}
              max={3600}
              step={2}
              onChange={(v) =>
                edit((d) => {
                  d.schedule.slot_duration_s = v;
                })
              }
            />
          </>
        )}
        {section === 'gnc' && <MissionHardware config={config} edit={edit} />}
        {section === 'power' && <MissionPowerControls config={config} edit={edit} />}
        {section === 'thermal' && <MissionThermalControls config={config} edit={edit} />}
        {section === 'conops' && <MissionConopsControls config={config} edit={edit} />}
      </div>
      <div className="mission-run-actions">
        {mission.error && (
          <div className="mission-error" role="alert">
            {mission.error}
            <button aria-label="Dismiss mission error" onClick={mission.clearError}>
              ×
            </button>
          </div>
        )}
        <button
          className={`primary ${mission.busy ? 'cancel' : ''}`}
          disabled={
            mission.submitting || mission.orbitPending || mission.importing || mission.loading
          }
          onClick={mission.busy ? () => void mission.cancel() : onRun}
        >
          {mission.busy ? 'Cancel run' : 'Run mission'} <span>{mission.busy ? '■' : '↗'}</span>
        </button>
        {mission.busy && (
          <span className="eyebrow">
            {mission.run?.status || 'Submitting'}{' '}
            {mission.run?.progress ? `${(100 * mission.run.progress.fraction).toFixed(0)}%` : ''}
          </span>
        )}
        {mission.snapshot?.run.result?.summary.end_reason !== undefined &&
          mission.snapshot.run.result.summary.end_reason !== 'requested_duration' && (
            <span className="mission-error">
              Stopped at{' '}
              {Number(mission.snapshot.run.result.summary.computed_duration_s).toFixed(0)} s ·{' '}
              {String(mission.snapshot.run.result.summary.end_reason).replaceAll('_', ' ')}
            </span>
          )}
        <button className="text-button" disabled={!canPin} onClick={onPin}>
          {hasBaseline ? 'Clear comparison' : 'Pin comparison'}
        </button>
        {mission.dirty && <span className="eyebrow">UNRUN EDITS</span>}
      </div>
    </>
  );
}
