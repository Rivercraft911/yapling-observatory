import type { Quaternion } from '../types';

export type Vector3 = [number, number, number];
export type Controller = 'coast' | 'quaternion_pd' | 'magnetic_bdot';
export interface WheelConfig {
  axis_body: Vector3;
  spin_inertia_kg_m2: number;
  max_speed_rpm: number;
  max_motor_torque_nm: number;
  motor_torque_constant_nm_a: number;
  winding_resistance_ohm: number;
  non_ohmic_drive_efficiency: number;
  idle_power_w: number;
  constant_torque_until_rpm: number;
  regenerative_efficiency: number;
  viscous_friction_nm_s: number;
  max_bus_power_w: number | null;
}
export interface AttitudeConfig {
  body: {
    locked_inertia_kg_m2: [Vector3, Vector3, Vector3];
    wheels: WheelConfig[];
    magnetorquer: { max_dipole_am2: number } | null;
  };
  initial: {
    time_s: number;
    q_body_from_inertial_wxyz: Quaternion;
    omega_body_rad_s: Vector3;
    wheel_relative_speed_rad_s: number[];
  };
  duration_s: number;
  physics_step_s: number;
  controller_period_s: number;
  output_step_s: number;
  controller: Controller;
  pd_gains: {
    proportional_nm_per_rad: Vector3;
    derivative_nm_s_per_rad: Vector3;
    gyroscopic_compensation: boolean;
  } | null;
  body_boresight: Vector3;
  target_direction_inertial: Vector3;
  free_roll: boolean;
  damp_free_roll_rate: boolean;
  magnetic_field_inertial_t: Vector3;
  disturbance_torque_body_nm: Vector3;
  unloading_gain_s_inv: number;
  wheel_momentum_bias_body_nms: Vector3;
  bdot_gain_am2_s_t: number;
}
export interface OrbitConfig {
  initial: { time_s: number; position_m: Vector3; velocity_m_s: Vector3 };
  config: {
    mu_m3_s2: number;
    step_s: number;
    method: 'rk4' | 'velocity_verlet';
    minimum_radius_m: number;
    force_model: 'central' | 'j2';
    reference_radius_m: number;
    j2: number;
  };
  duration_s: number;
  output_step_s: number;
  initialization: 'cartesian' | 'elements';
  elements: OrbitElementsConfig | null;
  node_definition: 'raan' | 'ltan';
  local_mean_solar_time_hours: number;
}
export interface OrbitElementsConfig {
  semi_major_axis_m: number;
  eccentricity: number;
  inclination_deg: number;
  raan_deg: number;
  argument_of_periapsis_deg: number;
  true_anomaly_deg: number;
  epoch_utc: string;
}
export interface SolarNodeResult {
  raan_deg: number;
  local_mean_solar_time_hours: number;
  epoch_utc: string;
  mean_sun_ra_deg: number;
  solar_model_version: string;
}
export interface DynamicsDefaults {
  orbit: OrbitConfig;
  attitude: AttitudeConfig;
  scope: string;
  evidence: string;
  controllers: Controller[];
  orbit_methods: ('rk4' | 'velocity_verlet')[];
  force_models: ('central' | 'j2')[];
}
export interface WheelOutput {
  relative_speed_rad_s: number;
  absolute_axial_momentum_nms: number;
  relative_axial_momentum_nms: number;
  maximum_relative_axial_momentum_nms: number;
  requested_motor_torque_nm: number;
  motor_torque_nm: number;
  torque_saturated: boolean;
  power_saturated: boolean;
  at_speed_limit: boolean;
  overspeed: boolean;
  bus_power_w: number;
  dissipated_heat_w: number;
}
export interface AttitudeResult {
  request: AttitudeConfig;
  model_version: string;
  limits: string[];
  samples: {
    state: {
      time_s: number;
      q_body_from_inertial_wxyz: Quaternion;
      omega_body_rad_s: Vector3;
      wheel_absolute_axial_momentum_nms: number[];
    };
    pointing_error_rad: number;
    mechanics: { rotational_energy_j: number; wheel_relative_speed_rad_s: number[] };
    actuators: { wheels: WheelOutput[]; wheel_bus_power_w: number; wheel_heat_w: number };
    controller_dipole_saturated: boolean;
    energy_balance_residual_j: number;
  }[];
  summary: {
    physics_steps: number;
    controller_updates: number;
    wheel_overspeed: boolean;
    wheel_torque_saturation: boolean;
    wheel_power_saturation: boolean;
    dipole_saturation: boolean;
    wheel_bus_energy_j: number;
    wheel_heat_j: number;
  };
}
export interface OrbitResult {
  request: OrbitConfig;
  limits: string[];
  result: {
    model_version: string;
    states: OrbitConfig['initial'][];
    invariants: {
      specific_energy_j_kg: number;
      specific_angular_momentum_m2_s: Vector3;
      eccentricity_vector: Vector3;
    }[];
    diagnostics: {
      time_s: number;
      specific_energy_change_j_kg: number;
      relative_energy_change: number | null;
      angular_momentum_change_norm_m2_s: number;
      relative_angular_momentum_change: number | null;
      axial_angular_momentum_change_m2_s: number;
      scaled_axial_angular_momentum_change: number | null;
    }[];
    maximum_relative_energy_change: number | null;
    maximum_relative_angular_momentum_change: number | null;
    maximum_scaled_axial_angular_momentum_change: number | null;
    force_model: 'central' | 'j2';
    acceleration_evaluations: number;
    physics_step_s: number;
    method: string;
  };
  nodes: {
    inclination_deg: (number | null)[];
    raan_unwrapped_deg: (number | null)[];
    raan_drift_deg: (number | null)[];
    fitted_raan_rate_deg_day: number | null;
    defined_sample_count: number;
    convention: string;
  };
  resolved_initial_elements: OrbitElementsConfig | null;
}
export interface DynamicsSession {
  config: DynamicsDefaults | null;
  result: { attitude?: AttitudeResult; orbit?: OrbitResult } | null;
}
