import assert from 'node:assert/strict';
import {
  attachTimeWindowNavigation,
  clampTimeRange,
  fullRangeOrNull,
  keyTimeRange,
  panTimeRange,
  sampleTimeDomain,
  zoomTimeRange,
} from './timeWindow.ts';

const times = Object.freeze([500, 530, 560, 590, 605]);
const domain = sampleTimeDomain(times);
assert.deepEqual(domain, { bounds: [500, 605], minimumSpan: 15 });
for (const invalid of [[], [0], [0, 0], [NaN, 1], [0, Infinity], [2, 1]]) {
  assert.equal(sampleTimeDomain(invalid), null);
}
assert.deepEqual(sampleTimeDomain([0, 0, 5]), { bounds: [0, 5], minimumSpan: 5 });
assert.deepEqual(clampTimeRange(null, domain), [500, 605]);
assert.deepEqual(clampTimeRange([NaN, 600], domain), [500, 605]);
assert.deepEqual(clampTimeRange([600, 550], domain), [500, 605]);
assert.deepEqual(clampTimeRange([540, 541], domain), [533, 548]);
assert.deepEqual(clampTimeRange([400, 430], domain), [500, 530]);
assert.deepEqual(clampTimeRange([600, 630], domain), [575, 605]);
assert.deepEqual(clampTimeRange([0, 1000], domain), [500, 605]);

const current = Object.freeze([520, 580]);
const zoomed = zoomTimeRange(current, domain, 0.5, 0.25);
assert.deepEqual(zoomed, [527.5, 557.5]);
assert.equal(zoomed[0] + 0.25 * (zoomed[1] - zoomed[0]), 535);
assert.deepEqual(zoomTimeRange(current, domain, 0.5, 0), [520, 550]);
assert.deepEqual(zoomTimeRange(current, domain, 0.5, 1), [550, 580]);
assert.deepEqual(zoomTimeRange(current, domain, 1e-20), [542.5, 557.5]);
assert.deepEqual(zoomTimeRange(current, domain, 1e20), [500, 605]);
assert.deepEqual(zoomTimeRange(current, domain, NaN), current);
assert.deepEqual(zoomTimeRange(current, domain, -1), current);
assert.deepEqual(panTimeRange(current, domain, -100), [500, 560]);
assert.deepEqual(panTimeRange(current, domain, 100), [545, 605]);
assert.deepEqual(panTimeRange(current, domain, 0.25), [535, 595]);
assert.deepEqual(panTimeRange(current, domain, Infinity), current);
assert.equal(fullRangeOrNull([500, 605], domain), null);
assert.deepEqual(keyTimeRange(current, domain, '+'), [535, 565]);
assert.deepEqual(keyTimeRange(current, domain, 'ArrowRight'), [532, 592]);
assert.deepEqual(keyTimeRange(current, domain, 'Home'), [500, 605]);
assert.equal(keyTimeRange(current, domain, 'PageDown'), undefined);
assert.deepEqual(times, [500, 530, 560, 590, 605]);

class Overlay extends EventTarget {
  getBoundingClientRect() {
    return { left: 100, width: 600, height: 200 };
  }
}
const element = new Overlay();
let context = { domain, range: null };
const changes = [];
const detach = attachTimeWindowNavigation(
  element,
  () => context,
  (range) => {
    changes.push(range);
    context = { ...context, range };
  },
);
const send = (type, props = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 250, ...props });
  element.dispatchEvent(event);
  return event;
};
assert.equal(
  send('wheel', { deltaY: 100 }).defaultPrevented,
  false,
  'Full-range zoom-out permits page scroll',
);
assert.equal(send('wheel', { deltaY: -120 }).defaultPrevented, true);
let shown = clampTimeRange(context.range, domain);
assert(Math.abs(shown[0] + 0.25 * (shown[1] - shown[0]) - 526.25) < 1e-12);
const width = shown[1] - shown[0];
assert.equal(send('wheel', { deltaX: 60 }).defaultPrevented, true);
assert(Math.abs(context.range[0] - shown[0] - width * 0.1) < 1e-12);
shown = context.range;
assert.equal(send('wheel', { deltaY: -60, shiftKey: true }).defaultPrevented, true);
assert(Math.abs(context.range[0] - shown[0] + width * 0.1) < 1e-12);
assert.equal(send('keydown', { key: 'Home' }).defaultPrevented, true);
assert.equal(context.range, null);
assert.equal(send('keydown', { key: '+' }).defaultPrevented, true);
assert.deepEqual(context.range, [526.25, 578.75]);
const count = changes.length;
assert.equal(send('keydown', { key: '+', ctrlKey: true }).defaultPrevented, false);
assert.equal(send('wheel', { deltaY: NaN }).defaultPrevented, false);
assert.equal(changes.length, count);
context = null;
assert.equal(
  send('wheel', { deltaY: -100 }).defaultPrevented,
  false,
  'Missing data or active scrubbing leaves the wheel untouched',
);
context = { domain, range: null };
send('wheel', { deltaY: -2, deltaMode: 1 });
const lineZoom = context.range;
context = { domain, range: null };
send('wheel', { deltaY: -32 });
assert.deepEqual(
  context.range,
  lineZoom,
  'Line-mode wheel deltas use the same display-space units',
);
detach();
const afterDetach = changes.length;
send('wheel', { deltaY: -100 });
send('keydown', { key: 'Home' });
assert.equal(changes.length, afterDetach, 'Cleanup removes both listeners');
console.log(
  'Time-window checks passed: actual-sample bounds/minimum, pointer anchor, pan limits, null/full reset, keyboard, wheel units, page-scroll boundary and listener cleanup.',
);
