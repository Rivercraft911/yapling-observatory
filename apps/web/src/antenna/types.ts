export type AntennaModel =
  | 'dipole'
  | 'turnstile'
  | 'patch'
  | 'v45'
  | 'bent_v_up_45'
  | 'bent_v_out_45';
export type RadiusMode = 'linear' | 'db';
export interface Probe {
  direction_body: number[];
  azimuth_deg: number;
  elevation_deg: number;
  gain_linear: number | null;
  gain_dbi: number | null;
  field_real: number[] | null;
  field_imag: number[] | null;
  linear_analyzer_body: number[];
  linear_coupling: number | null;
  source: string;
  polarization_status: string;
}
export interface Pattern {
  model: AntennaModel;
  identity: string;
  model_version: string;
  status: 'analytical' | 'unresolved';
  definition: { label: string; axes: string; limits: string; function: string | null };
  frame: string;
  orientation: string;
  field_convention: string;
  source: { path: string; function: string | null; evidence: string };
  grid: {
    polar_steps: number;
    azimuth_steps: number;
    directions_body: number[][];
    gain_linear: number[];
    gain_dbi: (number | null)[];
    field_real: (number[] | null)[];
    field_imag: (number[] | null)[];
  } | null;
  cuts: Record<
    'azimuth' | 'elevation',
    {
      angle_deg: number[];
      gain_linear: number[];
      gain_dbi: (number | null)[];
      fixed_angle_deg: number;
      half_power?: {
        lower_deg: number | null;
        upper_deg: number | null;
        width_deg: number | null;
        threshold_gain_dbi: number;
        relative_level_db: number;
        peak_search_step_deg: number;
      } | null;
    }
  > | null;
  peak_gain_linear: number | null;
  peak_gain_dbi: number | null;
  sphere_mean_gain: number | null;
  expected_sphere_mean_gain?: number;
  probe: Probe;
}
