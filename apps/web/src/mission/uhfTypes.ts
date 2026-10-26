export interface UhfBeaconConfig {
  thermal_node_id: string;
  frequency_hz: number;
  tx_power_dbm: number;
  tx_feed_loss_db: number | null;
  idle_electrical_w: number;
  tx_electrical_w: number | null;
  interval_s: number;
  phase_s: number;
  antenna_variant: 'dipole' | 'turnstile' | 'v45';
  antenna_orientation_deg: [number, number, number];
  radiation_efficiency: number;
  ground_peak_gain_dbi: number;
  ground_feed_roll_deg: number;
  rx_system_noise_temperature_k: number | null;
  receiver_threshold_dbm: number | null;
  modulation: {
    spreading_factor: number;
    bandwidth_hz: number;
    coding_rate_denominator: number;
    payload_bytes: number;
    preamble_symbols: number;
    explicit_header: boolean;
    payload_crc: boolean;
    low_data_rate_optimization: boolean | null;
  };
}
