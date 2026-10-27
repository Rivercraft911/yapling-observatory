import assert from 'node:assert/strict';
import { eventTimeRange, groupVisibleEvents } from './eventNavigation.ts';

const event = (time, endTime) => ({ id: String(time), time, endTime, category: 'pass' });
const events = [event(10), event(10.001), event(25, 75), event(90), event(100)];
let groups = groupVisibleEvents(events, [0, 100], 260);
assert.equal(groups.length, 3);
assert.deepEqual(
  groups[0].events.map((item) => item.time),
  [10, 10.001],
);
assert.deepEqual(
  groups.at(-1).events.map((item) => item.time),
  [90, 100],
);
assert(groups.every((group) => group.position > 0 && group.position < 1));
assert.deepEqual(
  groupVisibleEvents(events, [50, 80], 520).flatMap((group) => group.events),
  [events[2]],
  'Include a pass that spans the window even when its entry lies outside',
);
assert.equal(groupVisibleEvents(events, [30, 30], 100).length, 0);
assert.equal(groupVisibleEvents(events, [0, 100], 0).length, 1);
const dense = Array.from({ length: 100000 }, (_, time) => event(time));
groups = groupVisibleEvents(dense, [0, 100000], 10000);
assert.equal(groups.length, 160, 'Bound rendered markers on month histories');
assert.equal(
  groups.reduce((sum, group) => sum + group.events.length, 0),
  dense.length,
  'Clustering never drops selectable events',
);
assert.deepEqual(
  eventTimeRange(event(100.125), { bounds: [0, 1000], minimumSpan: 1 }),
  [70.125, 130.125],
);
assert.deepEqual(
  eventTimeRange(event(200, 600), { bounds: [0, 1000], minimumSpan: 1 }),
  [160, 640],
);
assert.deepEqual(eventTimeRange(event(998), { bounds: [0, 1000], minimumSpan: 1 }), [940, 1000]);
assert.deepEqual(eventTimeRange(event(10), { bounds: [0, 1000], minimumSpan: 60 }), [0, 240]);
assert.deepEqual(eventTimeRange(event(0, 50), { bounds: [0, 50], minimumSpan: 1 }), [0, 50]);
console.log(
  'Event navigation passed: lossless bounded grouping, interval overlap, fractional timing and computed-range limits.',
);
