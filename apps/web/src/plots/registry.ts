import type { RunSnapshot, Samples, Scalar } from '../types';
import type { Trace } from './TracePlot';

export type PlotId = 'pointing'|'margin'|'rate'|'elevation'|'range'|'doppler'|'polarization'|'tracking'|'capacity';
export interface PlotDefinition {
  id: PlotId;
  title: string;
  unit: string;
  description: string;
  minimumSpan?: number;
  stepped?: boolean;
  read: (samples: Samples) => {label: string; values: Scalar[]}[];
}
const scale = (values: Scalar[]|undefined, divisor: number) => (values||[]).map(value=>value==null?null:value/divisor);
const paired = (samples: Samples, key: keyof Samples['uplink'], divisor=1) => ['uplink','downlink'].map(direction=>({
  label: direction==='uplink'?'UL':'DL', values: scale(samples[direction as 'uplink'|'downlink'][key],divisor),
}));

// This registry selects returned data and display units. Equations stay in Python.
export const plotDefinitions: PlotDefinition[] = [
  {id:'pointing',title:'Pointing error',unit:'deg',minimumSpan:1,description:'Patch +Y boresight to station. Current attitude is prescribed.',read:s=>[{label:'Patch → GS',values:s.attitude_angle_deg||[]}]},
  {id:'margin',title:'Link margin',unit:'dB',description:'Separate counterfactual uplink and downlink margins.',read:s=>paired(s,'margin_db')},
  {id:'rate',title:'Ideal rate',unit:'kb/s',stepped:true,description:'Scheduled ideal threshold rate. Receiver lock and packet losses are not modeled.',read:s=>paired(s,'ideal_rate_bps',1000)},
  {id:'elevation',title:'Elevation',unit:'deg',description:'Geodetic station elevation from the numerical Run.',read:s=>[{label:'GS',values:s.elevation_deg}]},
  {id:'range',title:'Range',unit:'km',description:'Station-to-spacecraft slant range.',read:s=>[{label:'GS ↔ SC',values:scale(s.range_m,1000)}]},
  {id:'doppler',title:'Doppler',unit:'kHz',description:'Returned first-order Doppler at each configured carrier; approach is positive.',read:s=>paired(s,'doppler_hz',1000)},
  {id:'polarization',title:'Polarization coupling',unit:'ratio',minimumSpan:1,description:'Vector power coupling, from zero to one. Undefined at a pattern null.',read:s=>paired(s,'polarization_coupling')},
  {id:'tracking',title:'LOS angular rate',unit:'deg/s',description:'Inertial line-of-sight angular speed. This is not ground-mount motor speed.',read:s=>[{label:'LOS',values:s.tracking_rate_deg_s||[]}]},
  {id:'capacity',title:'Ideal capacity',unit:'MB',description:'Cumulative ideal scheduled data, decimal megabytes. No packet or queue model.',read:s=>paired(s,'cumulative_ideal_bits',8e6)},
];
export function plotTraces(definition: PlotDefinition, snapshot: RunSnapshot|null, pinned=false): Trace[] {
  const samples=snapshot?.run.result?.samples;
  if(!samples)return [];
  return definition.read(samples).map(series=>({
    ...series,
    values: series.values.length===samples.time_s.length?series.values:samples.time_s.map(()=>null),
    color: series.label==='UL'?(pinned?'#94515a':'#ef6771'):series.label==='DL'?(pinned?'#827c75':'#e6e1d9'):(pinned?'#6b6865':'#c9c4bd'),
    dash: pinned?(series.label==='DL'?[2,5]:[5,4]):series.label==='DL'?[7,3]:undefined,
  }));
}
