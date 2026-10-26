import type { RadioDeliveryConfig } from './radioDeliveryTypes';
import type { Radio, Run, RunResult, Samples, Scenario, Variant } from '../types';
import type { WheelConfig, Vector3 } from '../systems/dynamicsTypes';
import type { PowerConfig, PowerLoad, PowerPanel } from '../systems/powerTypes';

export interface MissionElements {
  semi_major_axis_m: number;
  eccentricity: number;
  inclination_deg: number;
  raan_deg: number;
  argument_of_periapsis_deg: number;
  true_anomaly_deg: number;
  epoch_utc: string;
}
export type MissionMode = 'sun_pointing' | 'ground_tracking' | 'imaging' | 'detumble';
export interface MissionWindow {
  window_id: string;
  start_s: number;
  end_s: number;
  mode: MissionMode;
  target_latitude_deg: number | null;
  target_longitude_deg: number | null;
}
export interface MissionConfig {
  schema_version: string;
  radio_delivery?: RadioDeliveryConfig | null;
  magnetic_model?: 'igrf14_degree1' | 'igrf14_degree13' | null;
  name: string;
  run_kind: 'single_pass' | 'targeted' | 'long_mission';
  duration_s: number;
  orbit: {
    elements: MissionElements;
    force_model: 'central' | 'j2';
    method: 'rk4' | 'velocity_verlet';
    mu_m3_s2: number;
    reference_radius_m: number;
    j2: number;
    preset: string | null;
    ltan_hours_at_epoch: number | null;
    element_kind: 'osculating_initial';
  };
  clocks: {
    dynamics_step_s: number;
    orbit_substeps: number;
    controller_period_s: number;
    thermal_step_s: number;
    output_step_s: number;
    fidelity: string;
  };
  station: Scenario['station'];
  antenna_variant: Variant;
  uplink: Radio;
  downlink: Radio;
  schedule: Scenario['schedule'];
  spacecraft: {
    mass_kg: number;
    locked_inertia_kg_m2: [Vector3, Vector3, Vector3];
    initial_q_body_from_inertial_wxyz: [number, number, number, number];
    initial_omega_body_rad_s: Vector3;
    wheels: { enabled: boolean; spec: WheelConfig; initial_speed_rpm?: number }[];
    magnetorquer: {
      enabled: boolean;
      spec: { max_dipole_am2: number };
      full_axis_power_w: Vector3 | null;
      power_model: 'quadratic_dipole_example' | 'unresolved';
      thermal_node_id: string;
    } | null;
    controller: 'coast' | 'quaternion_pd';
    magnetic_unloading_enabled?: boolean;
    magnetic_unloading_time_constant_s?: number;
    proportional_nm_per_rad: Vector3;
    derivative_nm_s_per_rad: Vector3;
    body_boresight: Vector3;
    free_roll: boolean;
    pointing_reference?: 'instantaneous_zero_rate' | 'moving_boresight' | null;
    roll_rate_damping: boolean;
    bdot_gain_am2_s_t: number;
    actuator_heat_node_id: string;
  };
  conops: {
    auto_ground_tracking: boolean;
    ground_tracking_min_elevation_deg?: number | null;
    default_mode: 'sun_pointing' | 'detumble';
    windows: MissionWindow[];
  };
  power: {
    panels: PowerPanel[];
    battery: PowerConfig['battery'];
    thermal: PowerConfig['thermal'];
    surfaces: {
      surface_id: string;
      thermal_node_id: string;
      area_m2: number;
      normal_body: Vector3;
    }[];
    mode_loads: { mode: MissionMode; loads: PowerLoad[] }[];
    regulator_efficiency: number;
    regulator_heat_node_id: string;
    storage_loss_heat_node_id: string;
    radio_heat_node_id: string;
    spacecraft_tx_electrical_w: number;
    spacecraft_receive_w: number;
    radio_idle_w: number;
    transmit_radiation_efficiency: number;
    analytical_efficiency_semantics?: 'pattern_times_additional_v1' | null;
    solar_irradiance_w_m2: number;
    earth_radius_m: number;
    earth_albedo: number;
    earth_outgoing_ir_w_m2: number;
    earth_quadrature_rings: number;
    earth_quadrature_azimuths: number;
  };
  provenance: string[];
}
export interface MissionResult extends RunResult {
  samples: Samples;
}
export interface MissionRun extends Omit<Run, 'result'> {
  result: MissionResult | null;
  progress?: {
    fraction?: number;
    completed_time_s?: number;
    requested_duration_s?: number;
    state: string;
    reporting?: unknown;
  };
}
export interface MissionSnapshot {
  run: MissionRun;
  scenario: MissionConfig;
  presentation_id?: string;
  imported?: MissionArchiveMetadata & { filename: string; opened_at: string };
  raw_run_json?: string;
  original_archive_json?: string;
}
export interface MissionArchiveMetadata {
  format: 'ssi-coupled-mission';
  version: 1;
  sha256: string;
  validation: 'structural_and_integrity_only';
  source_identity: 'retained_not_recomputed';
}
export interface MissionArchiveImport {
  snapshot: Pick<MissionSnapshot, 'run' | 'scenario'>;
  import_metadata: MissionArchiveMetadata;
}
export const modeNames: Record<MissionMode, string> = {
  sun_pointing: 'Sun pointing',
  ground_tracking: 'Ground pass',
  imaging: 'Imaging',
  detumble: 'Detumble',
};
