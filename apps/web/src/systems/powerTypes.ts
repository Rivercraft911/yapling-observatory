export interface PowerPanel {
  panel_id: string;
  thermal_node_id: string;
  active_area_m2: number;
  normal_body: number[];
  solar_absorptivity: number;
  efficiency: number;
  electrical_derate: number;
  self_visibility: number;
  enabled: boolean;
}
export interface PowerLoad {
  component_id: string;
  thermal_node_id: string;
  electrical_w: number;
  escaped_rf_w: number;
  other_export_w: number;
  stored_mechanical_w: number;
}
export interface PowerStage {
  stage_id: string;
  mode: 'sun_pointing' | 'ground_tracking' | 'imaging' | 'detumble';
  start_s: number;
  end_s: number;
  sun_direction_body: number[];
  loads: PowerLoad[];
}
export interface ThermalNode {
  node_id: string;
  heat_capacity_j_k: number;
  initial_temperature_k: number;
  radiating_area_m2: number;
  solar_absorptivity: number;
  infrared_emissivity: number;
  space_view_factor: number;
}
export interface PowerConfig {
  schema_version: string;
  name: string;
  output_step_s: number;
  integration_step_s: number;
  solar_irradiance_w_m2: number;
  panels: PowerPanel[];
  battery: {
    total_capacity_wh: number | null;
    cells: {
      cell_capacity_mah: number;
      cell_nominal_voltage_v: number;
      series_count: number;
      parallel_count: number;
      cell_model: string | null;
      capacity_basis: string;
    } | null;
    initial_energy_fraction: number;
    charge_efficiency: number;
    discharge_efficiency: number;
    max_charge_bus_w: number;
    max_discharge_bus_w: number;
  };
  thermal: {
    nodes: ThermalNode[];
    conductive_links: { first: string; second: string; conductance_w_k: number }[];
    radiative_links: unknown[];
    space_temperature_k: number;
  };
  stages: PowerStage[];
  imaging_windows: PowerStage[];
  eclipse_windows: { start_s: number; end_s: number; sun_visibility: number }[];
  environment: unknown[];
  regulator_efficiency: number;
  regulator_heat_node_id: string;
  storage_loss_heat_node_id: string;
  provenance: string[];
}
export interface PowerResult {
  manifest: {
    config: PowerConfig;
    config_hash: string;
    model_version: string;
    limits: string[];
    battery_capacity_wh: number;
    nominal_pack_voltage_v: number | null;
  };
  samples: {
    time_s: number[];
    stage_id: string[];
    mode: string[];
    generated_bus_w: number[];
    requested_load_w: number[];
    net_bus_w: number[];
    stored_energy_wh: number[];
    energy_fraction: number[];
    sun_visibility: number[];
    node_temperature_k: Record<string, number[]>;
    node_internal_heat_w: Record<string, number[]>;
    node_net_heat_w: Record<string, number[]>;
    node_emitted_ir_w: Record<string, number[]>;
    component_heat_w: Record<string, number[]>;
  };
  stages: {
    stage_id: string;
    mode: string;
    duration_s: number;
    mean_generated_bus_w: number;
    mean_requested_load_w: number;
    mean_net_bus_w: number;
    chemical_storage_delta_j: number;
  }[];
  summary: {
    first_law_residual_j: number;
    minimum_energy_fraction: number;
    node_minimum_k: Record<string, number>;
    node_maximum_k: Record<string, number>;
  };
}
export interface PowerSession {
  config: PowerConfig | null;
  result: PowerResult | null;
}
