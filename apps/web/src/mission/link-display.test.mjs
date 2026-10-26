import assert from 'node:assert/strict';
import { linkDisplayState, visibleLinkMargins } from './linkDisplay.ts';
import { plotDefinitions } from '../plots/registry.ts';

const samples = {
  time_s: [0, 30, 60, 90, 120, 150, 180, 210],
  visible: [false, false, true, true, true, true, undefined, true],
  elevation_deg: [-2, -1, 25, 30, 35, 40, 45, 50],
  radio_active: [false, true, true, true, true, false, true, true],
  active_direction: Array(8).fill('downlink'),
  uplink: { margin_db: [11, 8, 3, 2, 1, 5, 7, 4] },
  downlink: { margin_db: [17, 0.5, 4, -2, null, 6, 9, 0] },
};
const before = JSON.stringify(samples);
assert.deepEqual(visibleLinkMargins(samples, 'downlink'), [null, null, 4, -2, null, 6, null, 0]);
assert.deepEqual(visibleLinkMargins(samples, 'uplink'), [null, null, 3, 2, 1, 5, null, 4]);
assert.equal(linkDisplayState(undefined, 0), 'NO RUN');
assert.deepEqual(
  samples.time_s.map((_, i) => linkDisplayState(samples, i)),
  [
    'BELOW MASK',
    'BELOW MASK',
    'RF OPPORTUNITY',
    'BELOW THRESHOLD',
    'RF UNRESOLVED',
    'RADIO IDLE',
    'GEOMETRY UNAVAILABLE',
    'RF OPPORTUNITY',
  ],
);
const margin = plotDefinitions.find((definition) => definition.id === 'margin');
assert.deepEqual(
  margin.read(samples).map((trace) => trace.values),
  [
    [null, null, 3, 2, 1, 5, null, 4],
    [null, null, 4, -2, null, 6, null, 0],
  ],
);
assert.equal(JSON.stringify(samples), before);
assert.equal(linkDisplayState({ ...samples, radio_active: undefined }, 2), 'RADIO UNRESOLVED');
assert.equal(linkDisplayState({ ...samples, visible: undefined }, 2), 'GEOMETRY UNAVAILABLE');
assert.deepEqual(
  visibleLinkMargins({ ...samples, visible: undefined }, 'downlink'),
  Array(8).fill(null),
);
const adaptive = {
  ...samples,
  radio_delivery: { downlink: { selected_margin_db: [null, null, -1, 3, null, 8, 4, 0] } },
};
assert.equal(linkDisplayState(adaptive, 2), 'BELOW THRESHOLD');
assert.equal(linkDisplayState(adaptive, 3), 'RF OPPORTUNITY');
assert.equal(linkDisplayState(adaptive, 4), 'RF UNRESOLVED');
assert.equal(linkDisplayState(adaptive, 7), 'RF OPPORTUNITY');
assert.equal(
  linkDisplayState({ ...samples, radio_delivery: { downlink: {} } }, 2),
  'RF UNRESOLVED',
);
assert.equal(linkDisplayState({ ...samples, radio_delivery: {} }, 2), 'RF UNRESOLVED');
assert.equal(linkDisplayState({ ...samples, elevation_deg: undefined }, 2), 'GEOMETRY UNAVAILABLE');
assert.equal(JSON.stringify(samples), before);
console.log(
  'Link display passed: hidden positive margins are gaps, visible negative/zero margins remain, radio idle is not an active link, adaptive badges use the selected-mode margin, unknown states stay unresolved, archives stay unchanged.',
);
