import type { RunSnapshot, Samples, Scalar } from '../types';
import type { Trace } from './TracePlot';
import { visibleLinkMargins } from '../mission/linkDisplay.ts';

export type PlotId =
  | 'pointing'
  | 'margin'
  | 'rate'
  | 'frame_rate'
  | 'selected_margin'
  | 'payload'
  | 'receiver_lock'
  | 'lost_frames'
  | 'elevation'
  | 'range'
  | 'doppler'
  | 'polarization'
  | 'antenna_gain'
  | 'tracking'
  | 'capacity'
  | 'body_rate'
  | 'wheel_speed'
  | 'wheel_capacity'
  | 'wheel_momentum'
  | 'unloading_torque'
  | 'coil_power'
  | 'magnetic_field'
  | 'magnetic_dipole'
  | 'control_torque'
  | 'control_residual'
  | 'saturation'
  | 'power'
  | 'energy'
  | 'charge'
  | 'battery_voltage'
  | 'battery_current'
  | 'battery_soc'
  | 'battery_remaining_charge'
  | 'battery_heat'
  | 'actuator_power'
  | 'temperatures'
  | 'bus_heat'
  | 'absorbed_heat'
  | 'radiated_heat'
  | 'internal_heat'
  | 'dissipation'
  | 'uhf_signal'
  | 'uhf_margin'
  | 'uhf_duty'
  | 'uhf_beacons'
  | 'uhf_power';
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
const electricalTrace = (values: Scalar[] | undefined, label: string) => [
  {
    label: values?.some((value) => value != null) ? label : 'Unavailable',
    values: values || [],
  },
];
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
    title: 'Fixed-mode margin',
    unit: 'dB',
    description:
      'Potential UL/DL margins above the station mask. Gaps mean no ground contact or unresolved RF. Scheduling and receiver lock are separate.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: visibleLinkMargins(s, direction),
      })),
  },
  {
    id: 'rate',
    title: 'Fixed-mode rate',
    unit: 'kb/s',
    stepped: true,
    description:
      'Ideal rate estimate for the fixed RF profile with its original net-efficiency assumption, gated by contact and transmit/receive windows. Zero during the other direction’s slot. Selected-frame readiness appears under Payload rate; completed-frame delivery is separate.',
    read: (s) => paired(s, 'ideal_rate_bps', 1000),
  },
  {
    id: 'frame_rate',
    title: 'Payload rate',
    unit: 'kb/s',
    stepped: true,
    description:
      'Nominal selected-frame useful payload rate while the modeled receiver is active, locked and above the decode threshold. Acquisition, reconfiguration and inactive windows return zero; unresolved inputs remain unavailable. This is a hard-threshold prediction, not measured throughput. Completed-frame delivery is separate; a pending frame can still be lost.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: scale(s.radio_delivery?.[direction].ready_payload_rate_bps, 1000),
      })),
  },
  {
    id: 'selected_margin',
    title: 'Selected-mode margin',
    unit: 'dB',
    description:
      'Margin against the active adaptive MODCOD threshold. Unavailable without an adaptive receiver model or ground contact.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: (s.radio_delivery?.[direction].selected_margin_db || []).map((value, index) =>
          s.visible[index] ? value : null,
        ),
      })),
  },
  {
    id: 'payload',
    title: 'Modeled frame payload',
    unit: 'MB',
    description:
      'Completed-frame application payload under the selected receiver assumptions. Unknown receiver intervals remain unavailable.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: (s.radio_delivery?.[direction].delivered_useful_bits || []).map((value, index) =>
          s.radio_delivery?.[direction].delivery_available[index] ? value / 8e6 : null,
        ),
      })),
  },
  {
    id: 'receiver_lock',
    title: 'Receiver lock',
    unit: '0 / 1',
    stepped: true,
    description:
      'Assumed receiver lock state, including any configured hold grace. Lock does not guarantee a complete successful frame.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: (s.radio_delivery?.[direction].locked || []).map(Number),
      })),
  },
  {
    id: 'lost_frames',
    title: 'Lost frames',
    unit: 'frames',
    stepped: true,
    description:
      'Modeled failed and aborted frames. Unresolved or still-pending frames are tracked separately in the run.',
    read: (s) =>
      (['uplink', 'downlink'] as const).map((direction) => ({
        label: direction === 'uplink' ? 'UL' : 'DL',
        values: s.radio_delivery?.[direction].lost_frames || [],
      })),
  },
  {
    id: 'uhf_signal',
    title: 'UHF received level',
    unit: 'dBm',
    description:
      'Conditional received level toward the station during contact, and sampled actual TX level. Unknown feed loss or antenna fields remain unavailable. This does not establish decoded beacons.',
    read: (s) => [
      { label: 'Available', values: s.uhf_beacon?.available_received_power_dbm || [] },
      { label: 'Beacon TX', values: s.uhf_beacon?.received_power_dbm || [] },
    ],
  },
  {
    id: 'uhf_margin',
    title: 'UHF beacon margin',
    unit: 'dB',
    description:
      'Margin during a visible beacon against the supplied receiver sensitivity for the selected LoRa mode. Unavailable until that threshold is specified.',
    read: (s) => [{ label: 'UHF', values: s.uhf_beacon?.margin_db || [] }],
  },
  {
    id: 'uhf_duty',
    title: 'UHF transmit duty',
    unit: '%',
    description:
      'Exact scheduled transmit fraction over each preceding output interval. This preserves burst occupancy when individual packets fall between plotted samples.',
    read: (s) => [
      {
        label: 'TX',
        values: (s.uhf_beacon?.output_interval_tx_fraction || []).map((value) => value * 100),
      },
    ],
  },
  {
    id: 'uhf_beacons',
    title: 'UHF beacons sent',
    unit: 'beacons',
    stepped: true,
    description:
      'Completed scheduled transmissions onboard. This is not the number decoded on the ground.',
    read: (s) => [{ label: 'Sent', values: s.uhf_beacon?.scheduled_beacons_completed || [] }],
  },
  {
    id: 'uhf_power',
    title: 'UHF power',
    unit: 'W',
    description:
      'Mean electrical input and heat over each preceding output interval. Battery integration resolves every TX/RX edge before these display averages; this does not display the instantaneous pulse height.',
    read: (s) => [
      { label: 'Electrical', values: s.uhf_beacon?.output_interval_electrical_w || [] },
      { label: 'Heat', values: s.uhf_beacon?.output_interval_heat_w || [] },
    ],
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
    id: 'antenna_gain',
    title: 'Spacecraft gain',
    unit: 'dBi',
    description: 'Returned spacecraft gain toward the station, before polarization coupling.',
    read: (s) => [
      { label: 'UL receive', values: s.uplink.rx_gain_dbi },
      { label: 'DL transmit', values: s.downlink.tx_gain_dbi },
    ],
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
    id: 'magnetic_field',
    title: 'Magnetic field',
    unit: 'µT',
    description: 'Modeled Earth magnetic field along the spacecraft body axes.',
    read: (s) =>
      [0, 1, 2].map((axis) => ({
        label: 'xyz'[axis],
        values: (s.gnc?.magnetic_field_body_t || []).map((v) => v[axis] * 1e6),
      })),
  },
  {
    id: 'magnetic_dipole',
    title: 'Coil dipole',
    unit: 'A·m²',
    description: 'Applied magnetorquer dipole along body axes after authority limits.',
    read: (s) =>
      [0, 1, 2].map((axis) => ({
        label: 'xyz'[axis],
        values: (s.gnc?.magnetic_dipole_body_am2 || []).map((v) => v[axis]),
      })),
  },
  {
    id: 'control_torque',
    title: 'Control torque',
    unit: 'µN·m',
    description:
      'Requested and achieved spacecraft control torque, body axes. Achieved torque includes wheel and magnetic limits.',
    read: (s) => [
      ...[0, 1, 2].map((axis) => ({
        label: `Requested ${'xyz'[axis]}`,
        values: (s.gnc?.requested_torque_body_nm || []).map((v) => v[axis] * 1e6),
      })),
      ...[0, 1, 2].map((axis) => ({
        label: `Achieved ${'xyz'[axis]}`,
        values: (s.gnc?.actual_torque_body_nm || []).map((v) => v[axis] * 1e6),
      })),
    ],
  },
  {
    id: 'control_residual',
    title: 'Torque residual',
    unit: 'µN·m',
    description:
      'Requested minus achieved spacecraft control torque, returned by the dynamics model in body axes.',
    read: (s) =>
      [0, 1, 2].map((axis) => ({
        label: 'xyz'[axis],
        values: (s.gnc?.residual_torque_body_nm || []).map((v) => v[axis] * 1e6),
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
    id: 'wheel_momentum',
    title: 'Wheel momentum',
    unit: 'µN·m·s',
    description:
      'Absolute axial rotor momenta and norm of their vector sum. Opposing wheel momenta can cancel in the sum.',
    read: (s) => [
      ...Array.from(
        { length: s.gnc?.wheel_absolute_axial_momentum_nms[0]?.length || 0 },
        (_, index) => ({
          label: `W${index + 1}`,
          values: (s.gnc?.wheel_absolute_axial_momentum_nms || []).map(
            (entry) => entry[index] * 1e6,
          ),
        }),
      ),
      { label: '|Σh|', values: scale(s.gnc?.wheel_momentum_norm_nms, 1e-6) },
    ],
  },
  {
    id: 'unloading_torque',
    title: 'Unloading torque',
    unit: 'µN·m',
    description:
      'Actual sampled magnetic torque during momentum unloading, body axes. Zero when unloading is inactive.',
    read: (s) =>
      [0, 1, 2].map((axis) => ({
        label: 'xyz'[axis],
        values: (s.gnc?.unloading_achieved_torque_body_nm || []).map((entry) => entry[axis] * 1e6),
      })),
  },
  {
    id: 'coil_power',
    title: 'Coil power',
    unit: 'mW',
    description:
      'Returned magnetorquer electrical draw, averaged over the preceding dynamics interval.',
    read: (s) => [
      { label: 'MTQ', values: scale(s.power?.component_electrical_w?.magnetorquers, 0.001) },
    ],
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
    title: 'Power balance',
    unit: 'W',
    description:
      'Available solar power at the bus, requested draw and their difference over the preceding dynamics interval. Positive net is available surplus before battery limits and curtailment, not stored power.',
    read: (s) => [
      { label: 'Solar available', values: s.power?.potential_bus_w || [] },
      { label: 'Draw', values: s.power?.requested_load_w || [] },
      { label: 'Net', values: s.power?.net_bus_w || [] },
    ],
  },
  {
    id: 'energy',
    title: 'Stored energy',
    unit: 'Wh',
    description: 'Stored energy from the configured battery model.',
    read: (s) => [{ label: 'Battery', values: s.power?.stored_energy_wh || [] }],
  },
  {
    id: 'charge',
    title: 'Remaining energy',
    unit: '%',
    description:
      'Stored energy fraction. Electrical-reference runs use integrated OCV energy; charge SOC is available separately.',
    read: (s) => [
      { label: 'Battery', values: (s.power?.energy_fraction || []).map((v) => v * 100) },
    ],
  },
  {
    id: 'battery_voltage',
    title: 'Battery voltage',
    unit: 'V',
    description:
      'Battery terminal voltage averaged over the preceding accepted dynamics interval. Requires the electrical reference model.',
    read: (s) => electricalTrace(s.power?.battery_voltage_v, 'Terminal'),
  },
  {
    id: 'battery_current',
    title: 'Battery current',
    unit: 'A',
    description:
      'Battery terminal current over the preceding accepted dynamics interval. Positive discharges; requires the electrical reference model.',
    read: (s) => electricalTrace(s.power?.battery_current_a, 'Discharge +'),
  },
  {
    id: 'battery_soc',
    title: 'Battery charge SOC',
    unit: '%',
    description:
      'Charge state returned by the electrical reference model, independent of remaining energy fraction.',
    read: (s) =>
      electricalTrace(
        s.power?.battery_soc?.map((value) => value * 100),
        'Charge SOC',
      ),
  },
  {
    id: 'battery_remaining_charge',
    title: 'Battery remaining charge',
    unit: 'Ah',
    description: 'Remaining pack charge returned by the electrical reference model.',
    read: (s) => electricalTrace(s.power?.battery_remaining_charge_ah, 'Remaining'),
  },
  {
    id: 'battery_heat',
    title: 'Battery ohmic heat',
    unit: 'W',
    description:
      'Modeled resistive battery heat over the preceding accepted dynamics interval. Requires the electrical reference model.',
    read: (s) => electricalTrace(s.power?.battery_ohmic_heat_w, 'Ohmic heat'),
  },
  {
    id: 'actuator_power',
    title: 'Actuator electrical power',
    unit: 'W',
    description:
      'Returned combined, wheel and magnetorquer electrical draw over the preceding dynamics interval.',
    read: (s) => [
      { label: 'Total', values: s.power?.actuator_bus_w || [] },
      { label: 'Wheels', values: s.power?.component_electrical_w?.wheels || [] },
      { label: 'MTQ', values: s.power?.component_electrical_w?.magnetorquers || [] },
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
    id: 'dissipation',
    title: 'Total dissipation',
    unit: 'W',
    description:
      'Electrical and actuator heat produced inside the spacecraft, including radio/feed, regulator and storage losses. Absorbed sunlight/Earth radiation and extracted solar electricity are separate. Unavailable in older runs without this returned ledger.',
    read: (s) => [{ label: 'Spacecraft', values: s.power?.dissipated_power_w || [] }],
  },
  {
    id: 'internal_heat',
    title: 'Thermal sources',
    unit: 'W',
    description:
      'Internal forcing at each thermal node. Radio includes amplifier, feed and antenna losses. Panel forcing subtracts extracted PV electricity and can be negative. These values are not total spacecraft dissipation; absorbed sunlight and emitted infrared are separate.',
    read: (s) =>
      Object.entries(s.thermal?.node_internal_heat_w || {}).map(([label, values]) => ({
        label,
        values,
      })),
  },
  {
    id: 'absorbed_heat',
    title: 'Absorbed radiation',
    unit: 'W',
    description:
      'Returned absorbed sunlight, reflected sunlight and Earth/space infrared at each thermal node. Optical properties and orientation come from the archived mission.',
    read: (s) =>
      Object.entries(s.thermal?.node_absorbed_environment_w || {}).map(([label, values]) => ({
        label,
        values,
      })),
  },
  {
    id: 'radiated_heat',
    title: 'Emitted infrared',
    unit: 'W',
    description:
      'Returned outgoing thermal radiation at each node, using its emissivity, exterior area and computed temperature. Positive values remove heat.',
    read: (s) =>
      Object.entries(s.thermal?.node_emitted_ir_w || {}).map(([label, values]) => ({
        label,
        values,
      })),
  },
  {
    id: 'bus_heat',
    title: 'Bus node heat',
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
      definition.id === 'control_torque' && !pinned
        ? ['#c9c4bd', '#c89974', '#78a5b3'][index % 3]
        : series.label === 'UL'
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
        : definition.id === 'control_torque' && index < 3
          ? [3, 3]
          : undefined,
  }));
}
