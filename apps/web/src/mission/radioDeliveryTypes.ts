export interface DeliveryMode {
  mode_id: string;
  modulation: 'QPSK' | '8PSK';
  code_rate: '1/4' | '1/3' | '2/5' | '1/2' | '3/5' | '2/3' | '3/4' | '4/5' | '5/6' | '8/9' | '9/10';
  symbol_rate_sps: number;
  frame_size: 'normal' | 'short';
  pilots: boolean;
  decode_threshold_esn0_db: number | null;
  threshold_status: 'illustrative' | 'ideal_awgn' | 'unresolved';
  threshold_source: string;
}
export interface DirectionDelivery {
  hardware_profile: 'generic_dvb_s2_reference' | 'esp32_s3_short_pair';
  assumptions: string;
  modes: DeliveryMode[];
  initial_mode_id: string;
  policy: 'fixed' | 'scheduled' | 'adaptive';
  schedule: { start_s: number; mode_id: string }[];
  acquisition_s: number;
  reacquisition_s: number;
  loss_hold_s: number;
  minimum_dwell_s: number;
  mode_change_s: number;
  acquisition_margin_db: number;
  hold_margin_db: number;
  application_overhead_bits_per_frame: number;
}
export interface RadioDeliveryConfig {
  schema_version: '0.1.0';
  uplink: DirectionDelivery;
  downlink: DirectionDelivery;
}
