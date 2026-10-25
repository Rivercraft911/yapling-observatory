import type { RunSnapshot, Samples, Scalar } from '../types';
import type { Trace } from './TracePlot';

export type PlotId =
  | 'pointing'
  | 'margin'
  | 'rate'
  | 'elevation'
  | 'range'
  | 'doppler'
  | 'polarization'
  | 'tracking'
  | 'capacity'
  | 'body_rate'
  | 'wheel_speed'
  | 'wheel_capacity'
  | 'saturation'
  | 'power'
  | 'energy'
  | 'charge'
  | 'battery_voltage'
  | 'battery_current'
  | 'actuator_power'
  | 'temperatures'
  | 'bus_heat';
export interface PlotDefinition {
  id: PlotId;
  title: string;
  unit: string;
  description: string;
  minimumSpan?: number;
  stepped?: boolean;
  read: (samples: Samples) => { label: string; values: Scalar[] }[];
}
const scale = (values: Scalar[] | undefined, divisor: number) =>
  (values || []).map((value) => (value == null ? null : value / divisor));
const paired = (samples: Samples, key: keyof Samples['uplink'], divisor = 1) =>
  ['uplink', 'downlink'].map((direction) => ({
    label: direction === 'uplink' ? 'UL' : 'DL',
    values: scale(samples[direction as 'uplink' | 'downlink'][key], divisor),
  }));

// This registry selects returned data and display units. Equations stay in Python.
export const plotDefinitions: PlotDefinition[] = [
  {
    id: 'pointing',
    title: 'Pointing error',
    unit: 'deg',
    minimumSpan: 1,
    description: 'Returned body-boresight error to the active guidance target.',
    read: (s) => [{ label: 'Boresight → target', values: s.attitude_angle_deg || [] }],
  },
  {
    id: 'margin',
    title: 'Link margin',
    unit: 'dB',
    description: 'Separate counterfactual uplink and downlink margins.',
    read: (s) => paired(s, 'margin_db'),
  },
  {
    id: 'rate',
    title: 'Ideal rate',
    unit: 'kb/s',
    stepped: true,
    description: 'Scheduled ideal threshold rate. Receiver lock and packet losses are not modeled.',
    read: (s) => paired(s, 'ideal_rate_bps', 1000),
  },
  {
    id: 'elevation',
    title: 'Elevation',
    unit: 'deg',
    description: 'Geodetic station elevation from the numerical Run.',
    read: (s) => [{ label: 'GS', values: s.elevation_deg }],
  },
  {
    id: 'range',
    title: 'Range',
    unit: 'km',
    description: 'Station-to-spacecraft slant range.',
    read: (s) => [{ label: 'GS ↔ SC', values: scale(s.range_m, 1000) }],
  },
  {
    id: 'doppler',
    title: 'Doppler',
    unit: 'kHz',
    description: 'Returned first-order Doppler at each configured carrier; approach is positive.',
    read: (s) => paired(s, 'doppler_hz', 1000),
  },
  {
    id: 'polarization',
    title: 'Polarization coupling',
    unit: 'ratio',
    minimumSpan: 1,
    description: 'Vector power coupling, from zero to one. Undefined at a pattern null.',
    read: (s) => paired(s, 'polarization_coupling'),
  },
  {
    id: 'tracking',
    title: 'LOS angular rate',
    unit: 'deg/s',
    description: 'Inertial line-of-sight angular speed. This is not ground-mount motor speed.',
    read: (s) => [{ label: 'LOS', values: s.tracking_rate_deg_s || [] }],
  },
  {
    id: 'capacity',
    title: 'Ideal capacity',
    unit: 'MB',
    description: 'Cumulative ideal scheduled data, decimal megabytes. No packet or queue model.',
    read: (s) => paired(s, 'cumulative_ideal_bits', 8e6),
  },

  {
    id: 'body_rate',
    title: 'Body rate',
    unit: 'deg/s',
    description: 'Actual rigid-body angular velocity, body axes.',
    read: (s) =>
      [0, 1, 2].map((axis) => ({
        label: 'xyz'[axis],
        values: (s.gnc?.omega_body_rad_s || []).map((v) => (v[axis] * 180) / Math.PI),
      })),
  },
  {
    id: 'wheel_speed',
    title: 'Wheel speed',
    unit: 'rpm',
    description: 'Rotor speed relative to the spacecraft.',
    read: (s) =>
      Array.from({ length: s.gnc?.wheel_relative_speed_rad_s[0]?.length || 0 }, (_, i) => ({
        label: `W${i + 1}`,
        values: (s.gnc?.wheel_relative_speed_rad_s || []).map((v) => (v[i] * 60) / (2 * Math.PI)),
      })),
  },
  {
    id: 'wheel_capacity',
    title: 'Wheel capacity',
    unit: '%',
    minimumSpan: 100,
    description: 'Absolute rotor speed as a fraction of the configured speed limit.',
    read: (s) =>
      Array.from({ length: s.gnc?.wheel_speed_utilization?.[0]?.length || 0 }, (_, i) => ({
        label: `W${i + 1}`,
        values: (s.gnc?.wheel_speed_utilization || []).map((v) => 100 * v[i]),
      })),
  },
  {
    id: 'saturation',
    title: 'Actuator limits',
    unit: 'flag',
    stepped: true,
    minimumSpan: 1,
    description: 'One indicates an active torque, speed, power or dipole limit.',
    read: (s) => [
      { label: 'Wheel', values: (s.gnc?.wheel_saturated || []).map(Number) },
      { label: 'MTQ', values: (s.gnc?.magnetic_saturated || []).map(Number) },
    ],
  },
  {
    id: 'power',
    title: 'Bus power',
    unit: 'W',
    description:
      'Available solar generation and requested loads, averaged over preceding dynamics interval.',
    read: (s) => [
      { label: 'Solar available', values: s.power?.potential_bus_w || [] },
      { label: 'Load', values: s.power?.requested_load_w || [] },
      { label: 'Net', values: s.power?.net_bus_w || [] },
    ],
  },
  {
    id: 'energy',
    title: 'Stored energy',
    unit: 'Wh',
    description: 'Computed chemical-energy storage, capacity model.',
    read: (s) => [{ label: 'Battery', values: s.power?.stored_energy_wh || [] }],
  },
  {
    id: 'charge',
    title: 'Remaining energy',
    unit: '%',
    description: 'Stored energy fraction. This is not a charge-based electrochemical SOC model.',
    read: (s) => [
      { label: 'Battery', values: (s.power?.energy_fraction || []).map((v) => v * 100) },
    ],
  },
  {
    id: 'battery_voltage',
    title: 'Battery voltage',
    unit: 'V',
    description: 'Unresolved until a terminal-voltage model is configured.',
    read: (s) => [{ label: 'Unresolved', values: s.power?.battery_voltage_v || [] }],
  },
  {
    id: 'battery_current',
    title: 'Battery current',
    unit: 'A',
    description: 'Unresolved until a terminal-voltage/current model is configured.',
    read: (s) => [{ label: 'Unresolved', values: s.power?.battery_current_a || [] }],
  },
  {
    id: 'actuator_power',
    title: 'Actuator power',
    unit: 'W',
    description: 'Actual actuator electrical input and dissipated heat.',
    read: (s) => [
      { label: 'Electrical', values: s.power?.actuator_bus_w || [] },
      { label: 'Heat', values: s.power?.actuator_heat_w || [] },
    ],
  },
  {
    id: 'temperatures',
    title: 'Temperature',
    unit: '°C',
    description: 'Computed lumped-node temperature.',
    read: (s) =>
      ['bus', 'battery', 'panel', 'radio'].map((node) => ({
        label: node,
        values: (s.thermal?.node_temperature_k[node] || []).map((v) => v - 273.15),
      })),
  },
  {
    id: 'bus_heat',
    title: 'Bus heat',
    unit: 'W',
    description: 'Returned internal dissipation and net heat at the bus thermal node.',
    read: (s) => [
      { label: 'Internal', values: s.thermal?.node_internal_heat_w?.bus || [] },
      { label: 'Net', values: s.thermal?.node_net_heat_w?.bus || [] },
    ],
  },
];
export function plotTraces(
  definition: PlotDefinition,
  snapshot: RunSnapshot | null,
  pinned = false,
): Trace[] {
  const samples = snapshot?.run.result?.samples;
  if (!samples) return [];
  return definition.read(samples).map((series, index) => ({
    ...series,
    values:
      series.values.length === samples.time_s.length
        ? series.values
        : samples.time_s.map(() => null),
    color:
      series.label === 'UL'
        ? pinned
          ? '#94515a'
          : '#ef6771'
        : series.label === 'DL'
          ? pinned
            ? '#827c75'
            : '#e6e1d9'
          : pinned
            ? '#6b6865'
            : ['#c9c4bd', '#c89974', '#78a5b3', '#bd7184'][index % 4],
    dash: pinned
      ? series.label === 'DL'
        ? [2, 5]
        : [5, 4]
      : series.label === 'DL'
        ? [7, 3]
        : undefined,
  }));
}
