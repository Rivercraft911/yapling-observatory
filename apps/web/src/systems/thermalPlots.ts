import type { PowerResult } from './powerTypes';

export const thermalPlotChoices = [
  { id: 'bus_temperature', label: 'Bus temperature', node: 'bus', metric: 'temperature' },
  {
    id: 'battery_temperature',
    label: 'Battery temperature',
    node: 'battery',
    metric: 'temperature',
  },
  { id: 'panel_temperature', label: 'Array temperature', node: 'panel', metric: 'temperature' },
  { id: 'radio_temperature', label: 'Radio temperature', node: 'radio', metric: 'temperature' },
  { id: 'bus_heat', label: 'Bus net heat', node: 'bus', metric: 'net' },
  { id: 'bus_dissipation', label: 'Bus dissipation', node: 'bus', metric: 'internal' },
  { id: 'radio_heat', label: 'Radio dissipation', node: 'radio', metric: 'internal' },
  { id: 'panel_emission', label: 'Array radiation', node: 'panel', metric: 'emitted' },
] as const;

export function thermalPlot(id: string, samples: PowerResult['samples']) {
  const choice = thermalPlotChoices.find((item) => item.id === id) || thermalPlotChoices[0];
  const temperature = choice.metric === 'temperature';
  const values = temperature
    ? (samples.node_temperature_k[choice.node] || []).map((value) => value - 273.15)
    : (choice.metric === 'net'
        ? samples.node_net_heat_w
        : choice.metric === 'internal'
          ? samples.node_internal_heat_w
          : samples.node_emitted_ir_w)[choice.node] || [];
  return {
    title: choice.label,
    unit: temperature ? '°C' : 'W',
    traces: [{ label: choice.node, color: temperature ? '#d9b092' : '#cf7582', values }],
  };
}
