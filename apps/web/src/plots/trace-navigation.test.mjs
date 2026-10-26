import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as formatting from './traceFormatting.ts';
import * as navigation from './timeWindow.ts';

// Exercise the component's effect lifetime with a narrow DOM/uPlot adapter.
const slots = [];
let position = 0;
let pending = [];
const changed = (before, after) => !before || after.some((value, index) => value !== before[index]);
const hooks = {
  useRef(value) {
    const index = position++;
    return (slots[index] ??= { current: value });
  },
  useState(value) {
    const index = position++;
    slots[index] ??= { value };
    return [
      slots[index].value,
      (next) => {
        slots[index].value = next;
      },
    ];
  },
  useMemo(compute, deps) {
    const index = position++;
    if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: compute() };
    return slots[index].value;
  },
  useEffect(effect, deps) {
    const index = position++;
    if (changed(slots[index]?.deps, deps))
      pending.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
  },
};
class Overlay extends EventTarget {
  tabIndex = -1;
  captured = null;
  getBoundingClientRect() {
    return { left: 100, width: 600, height: 200 };
  }
  setAttribute() {}
  focus() {}
  setPointerCapture(id) {
    this.captured = id;
  }
  hasPointerCapture(id) {
    return this.captured === id;
  }
  releasePointerCapture() {
    this.captured = null;
  }
}
let created = 0,
  destroyed = 0;
let chart;
class Chart {
  static paths = {};
  over = new Overlay();
  constructor(options, data) {
    created++;
    chart = this;
    this.data = data;
    this.range = [options.scales.x.min, options.scales.x.max];
  }
  batch(change) {
    change();
    if (this.pendingRange) this.range = this.pendingRange;
    this.pendingRange = null;
  }
  setScale(_key, { min, max }) {
    this.pendingRange = [min, max];
  }
  posToVal(x) {
    return this.range[0] + (x / 600) * (this.range[1] - this.range[0]);
  }
  valToPos(time) {
    return ((time - this.range[0]) / (this.range[1] - this.range[0])) * 600;
  }
  setCursor({ left }) {
    this.cursorLeft = left;
  }
  setSize() {}
  destroy() {
    destroyed++;
  }
}
const element = (type, props) => ({ type, props });
const host = { clientWidth: 650, clientHeight: 250 };
const bindHost = (node) => {
  if (!node) return;
  if (Array.isArray(node)) return node.forEach(bindHost);
  if (node.props?.className === 'plot-canvas') node.props.ref.current = host;
  bindHost(node.props?.children);
};
const source = await readFile(new URL('./TracePlot.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const exports = {};
new Function('require', 'exports', 'ResizeObserver', compiled)(
  (name) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element };
    if (name === 'uplot') return Chart;
    if (name === './traceFormatting') return formatting;
    if (name === './timeWindow') return navigation;
    throw new Error(`Unexpected dependency: ${name}`);
  },
  exports,
  class {
    observe() {}
    disconnect() {}
  },
);
const times = Object.freeze([0, 10, 30, 60, 100]);
const values = Object.freeze([1, null, 2, 3, 4]);
const traces = Object.freeze([{ label: 'Returned', color: '#fff', values }]);
const scrubbed = [];
const ranges = [];
let timeRange = null;
const props = {
  title: 'Test',
  unit: 'W',
  times,
  traces,
  cursorTime: 40,
  onScrub: (time) => scrubbed.push(time),
  onTimeRangeChange: (range) => {
    timeRange = range;
    ranges.push(range);
  },
};
const render = (extra = {}) => {
  position = 0;
  pending = [];
  bindHost(exports.TracePlot({ ...props, timeRange, ...extra }));
  pending.forEach((effect) => effect());
};
const send = (type, extra = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, {
    clientX: 250,
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    ...extra,
  });
  chart.over.dispatchEvent(event);
  return event;
};
render();
assert.equal(created, 1);
assert.strictEqual(chart.data[0], times);
assert.strictEqual(chart.data[1], values);
assert.equal(chart.over.tabIndex, 0);
send('wheel', { deltaY: -120 });
assert.equal(scrubbed.length, 0, 'Zoom must not scrub playback');
render();
assert.deepEqual(chart.range, timeRange);
assert.equal(
  chart.cursorLeft,
  chart.valToPos(props.cursorTime),
  'Scale commits before projecting a paused playback cursor',
);
assert.equal(created, 1, 'Changing the window retains the uPlot instance');
assert.equal(destroyed, 0);
const [left, right] = chart.range;
send('pointerdown', { clientX: 400 });
assert.equal(scrubbed.at(-1), left + 0.5 * (right - left));
send('pointermove', { clientX: 550 });
assert.equal(
  scrubbed.at(-1),
  left + 0.75 * (right - left),
  'Dragging scrubs within the visible window',
);
const beforeDragWheel = ranges.length;
assert.equal(send('wheel', { deltaY: -100 }).defaultPrevented, false);
assert.equal(ranges.length, beforeDragWheel, 'An active scrub owns the pointer interaction');
send('pointerup');
const beforePanScrub = scrubbed.length;
send('wheel', { deltaX: 60 });
render();
assert.equal(scrubbed.length, beforePanScrub, 'Pan must not scrub playback');
assert.equal(created, 1);
send('keydown', { key: 'Home' });
render();
assert.equal(timeRange, null);
assert.deepEqual(chart.range, [0, 100]);
assert.strictEqual(chart.data[1], values, 'Missing returned values remain missing');
render({ cursorTime: 80 });
assert.equal(created, 1, 'Playback does not rebuild the plot');
render({ times: [0, 5, 10], traces: [{ label: 'Other run', color: '#fff', values: [1, 2, 3] }] });
assert.equal(created, 2);
assert.equal(destroyed, 1);
assert.deepEqual(chart.range, [0, 10]);
for (const slot of slots) slot?.cleanup?.();
const beforeUnmount = ranges.length;
send('wheel', { deltaY: -100 });
assert.equal(ranges.length, beforeUnmount);
assert.equal(destroyed, 2);
console.log(
  'Trace navigation passed: scale-only updates, visible-window click/drag scrub, zoom/pan cursor independence, original null data, new sample range and unmount cleanup.',
);
