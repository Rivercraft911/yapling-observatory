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
  spacecraft_antenna: 'patch' | 'wire';
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
  scenario: Scenario;
}
export interface AssetInfo {
  revision: string;
  url: string;
  label?: string;
  fallback?: boolean;
  sha256?: string;
  available?: boolean;
}
export type Assets = { variants: Partial<Record<Variant, AssetInfo>> };
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
