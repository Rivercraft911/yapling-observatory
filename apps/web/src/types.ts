import type { SphericalHarmonicProfile } from './antenna/types';

export type Variant = 'dipole' | 'turnstile' | 'v45';
export type Direction = 'uplink' | 'downlink';
export type Scalar = number | null;
export type Quaternion = [number, number, number, number];
export interface RadioProfile {
  waveform: 'dvb_s2' | 'lora';
  symbol_rate_sps: number | null;
  modulation: 'QPSK' | '8PSK' | 'LoRa';
  code_rate: number;
  net_efficiency: number;
  information_rate_bps: number | null;
  threshold_metric: 'esn0' | 'cn0';
  threshold_db: number | null;
  threshold_status: string;
  engineering_reserve_db: number;
}
export interface Radio {
  spacecraft_antenna: 'patch' | 'wire' | 'spherical_harmonic';
  spherical_harmonic_profile?: SphericalHarmonicProfile | null;
  antenna_orientation_deg?: [number, number, number];
  frequency_hz: number;
  tx_power_w: number;
  tx_feed_loss_db: number;
  ground_peak_gain_dbi: number;
  spacecraft_peak_gain_dbi: number;
  rx_system_noise_temperature_k: number;
  extra_path_loss_db: number;
  ground_feed_roll_deg: number;
  profile: RadioProfile;
}
export interface Scenario {
  schema_version: string;
  name: string;
  epoch_utc: string;
  duration_s: number;
  step_s: number;
  station: {
    latitude_deg: number;
    longitude_deg: number;
    height_m: number;
    minimum_elevation_deg: number;
  };
  orbit: { altitude_m: number; ground_track_heading_deg: number };
  attitude: {
    mode: 'tracking' | 'tumble';
    spin_rate_deg_s: number;
    spin_axis_body: number[];
    pointing_error_deg: number;
  };
  antenna_variant: Variant;
  schedule: { slot_duration_s: number; first_direction: Direction };
  uplink: Radio;
  downlink: Radio;
  provenance: unknown[];
  [key: string]: unknown;
}
export interface LinkSamples {
  received_power_dbw: Scalar[];
  cn0_dbhz: Scalar[];
  esn0_db: Scalar[];
  margin_db: Scalar[];
  polarization_coupling: Scalar[];
  tx_gain_dbi: Scalar[];
  rx_gain_dbi: Scalar[];
  doppler_hz?: Scalar[];
  ideal_rate_bps: Scalar[];
  cumulative_ideal_bits: Scalar[];
}
export interface Samples {
  time_s: number[];
  mode?: string[];
  radio_active?: boolean[];
  sun_direction_ecef?: number[][];
  ecef_from_inertial_angle_rad?: number[];
  gnc?: {
    omega_body_rad_s: number[][];
    wheel_relative_speed_rad_s: number[][];
    wheel_speed_utilization?: number[][];
    wheel_absolute_axial_momentum_nms: number[][];
    wheel_momentum_body_nms?: number[][];
    wheel_momentum_norm_nms?: number[];
    unloading_requested_torque_body_nm?: number[][];
    unloading_allocated_torque_body_nm?: number[][];
    unloading_achieved_torque_body_nm?: number[][];
    unloading_command_time_s?: Scalar[];
    unloading_status?: (
      | 'disabled'
      | 'controller_inactive'
      | 'hardware_unavailable'
      | 'field_unavailable'
      | 'active'
    )[];
    requested_torque_body_nm: number[][];
    actual_torque_body_nm: number[][];
    residual_torque_body_nm: number[][];
    wheel_saturated: boolean[];
    magnetic_saturated: boolean[];
    controller_status: string[];
  };
  power?: {
    generated_bus_w: number[];
    potential_bus_w: number[];
    requested_load_w: number[];
    served_load_w: number[];
    net_bus_w: number[];
    stored_energy_wh: number[];
    energy_fraction: number[];
    battery_voltage_v: Scalar[];
    battery_current_a: Scalar[];
    battery_soc?: number[];
    battery_remaining_charge_ah?: number[];
    battery_open_circuit_voltage_v?: number[];
    battery_resistance_ohm?: number[];
    battery_terminal_power_w?: number[];
    battery_ohmic_heat_w?: number[];
    battery_mean_resistance_ohm?: number[];
    battery_temperature_outside_reference?: boolean[];
    actuator_bus_w: number[];
    actuator_heat_w: number[];
    component_electrical_w?: Record<string, number[]>;
    sun_visibility: number[];
  };
  thermal?: {
    node_temperature_k: Record<string, number[]>;
    node_internal_heat_w?: Record<string, number[]>;
    node_net_heat_w?: Record<string, number[]>;
  };
  satellite_position_m: number[][];
  station_position_m: number[][];
  satellite_position_ecef_m: number[][];
  q_body_from_inertial_wxyz: Quaternion[];
  attitude_angle_deg?: Scalar[];
  tracking_rate_deg_s?: Scalar[];
  range_m: Scalar[];
  range_rate_m_s?: Scalar[];
  elevation_deg: Scalar[];
  azimuth_deg: Scalar[];
  visible: boolean[];
  active_direction: Direction[];
  uplink: LinkSamples;
  downlink: LinkSamples;
}
export interface RunResult {
  events?: { time_s: number; type: string; mode?: string; [key: string]: unknown }[];
  manifest: Record<string, unknown>;
  summary: {
    ideal_capacity_bits: { uplink: number | null; downlink: number | null };
    capacity_available?: { uplink: boolean; downlink: boolean };
    max_elevation_deg?: number;
    [key: string]: unknown;
  };
  samples: Samples;
}
export interface Run {
  run_id: string;
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'failed' | 'complete';
  scenario_id: string;
  scenario_hash: string;
  result: RunResult | null;
  error: string | null;
}
export interface RunSnapshot {
  run: Run;
  scenario: Pick<
    Scenario,
    | 'name'
    | 'epoch_utc'
    | 'duration_s'
    | 'step_s'
    | 'station'
    | 'antenna_variant'
    | 'uplink'
    | 'downlink'
    | 'schedule'
    | 'provenance'
  >;
}
export interface AssetInfo {
  revision: string;
  url: string;
  label?: string;
  fallback?: boolean;
  sha256?: string;
  available?: boolean;
}
export type Assets = {
  variants: Partial<Record<Variant, AssetInfo>>;
  previews?: { cutaway?: AssetInfo; v45_outward?: AssetInfo };
};
export interface RadioPreset {
  id: string;
  label: string;
  frequency_hz: number;
  spacecraft_antenna: 'patch' | 'wire';
  spacecraft_peak_gain_dbi: number;
  ground_peak_gain_dbi?: number;
  rx_system_noise_temperature_k?: number;
  profile: RadioProfile;
}
export interface RadioCatalog {
  presets: RadioPreset[];
  notes?: string[];
}
