export type AntennaModel =
  | 'dipole'
  | 'turnstile'
  | 'patch'
  | 'spherical_harmonic'
  | 'v45'
  | 'bent_v_up_45'
  | 'bent_v_out_45';
export type RadiusMode = 'linear' | 'db';
export interface SphericalHarmonicProfile {
  schema_version: 'vsh-1';
  name: string;
  revision: string;
  provenance: {
    status: 'analytical' | 'em_simulated' | 'measured' | 'illustrative';
    source: string;
    conditions: string;
  };
  frequency_hz: number;
  maximum_degree: number;
  radiation_efficiency: number;
  coefficients: {
    degree: number;
    order: number;
    psi: [number, number];
    x: [number, number];
  }[];
}
export interface AntennaCatalog {
  examples: { id: string; label: string; profile: SphericalHarmonicProfile }[];
  models?: Partial<Record<AntennaModel, Pattern['definition']>>;
}
export interface PatternRequest {
  model: AntennaModel;
  efficiency: number;
  frequency_hz: number;
  arm_length_m: number;
  patch_peak_gain_dbi: number;
  orientation_deg: [number, number, number];
  cut_azimuth_deg: number;
  spherical_harmonic_profile?: SphericalHarmonicProfile | null;
}
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
  request: PatternRequest;
  identity: string;
  model_version: string;
  status: 'analytical' | 'illustrative' | 'em_simulated' | 'measured' | 'unresolved';
  definition: {
    label: string;
    axes: string;
    limits: string;
    function: string | null;
    formula?: string;
    conventions?: string;
  };
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
