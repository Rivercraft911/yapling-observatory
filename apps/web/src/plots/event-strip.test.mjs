import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as sourceEvents from './missionEvents.ts';
import * as navigation from './eventNavigation.ts';
import * as formatting from './traceFormatting.ts';

const source = await readFile(new URL('./EventStrip.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const jsx = (type, props) => ({ type, props });
const slots = [],
  listeners = new Map(),
  focused = [];
let cursor = 0,
  effects = [],
  normalizations = 0;
const changed = (before, after) =>
  !before || after.some((value, index) => !Object.is(value, before[index]));
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (value) => {
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    return (slots[index] ??= { current: initial });
  },
  useMemo(calculate, dependencies) {
    const index = cursor++;
    if (changed(slots[index]?.dependencies, dependencies))
      slots[index] = { dependencies, value: calculate() };
    return slots[index].value;
  },
  useEffect(setup, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (changed(previous?.dependencies, dependencies))
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: setup() };
      });
  },
};
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  document: {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  },
  require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './missionEvents')
      return {
        missionEvents: (result) => {
          normalizations++;
          return sourceEvents.missionEvents(result);
        },
      };
    if (name === './eventNavigation') return navigation;
    if (name === './traceFormatting') return formatting;
    if (name === './event-strip.css') return {};
    throw new Error(name);
  },
});
let result = {
  manifest: {},
  summary: {},
  samples: { time_s: [0, 10, 100] },
  events: Array.from({ length: 65 }, (_, index) => ({
    type: 'radio_delivery',
    direction: 'downlink',
    state: 'reconfiguring',
    cause: 'adaptive_mode_change',
    time_s: 1 + index / 100,
    mode_id: `mode-${index}`,
  })),
};
function render() {
  cursor = 0;
  effects = [];
  const tree = exports.EventStrip({
    result,
    range: [0, 100],
    domain: { bounds: [0, 100], minimumSpan: 1 },
    onFocus: (...args) => focused.push(args),
  });
  effects.forEach((effect) => effect());
  return tree;
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return (Array.isArray(node) ? node : [node.props?.children]).map(text).join('');
}
const button = (tree, label) =>
  nodes(tree, (node) => node.type === 'button' && text(node) === label)[0];
const choices = (tree) =>
  nodes(
    nodes(tree, (node) => node.props?.className === 'event-picker-list')[0],
    (node) => node.type === 'button',
  );
let tree = render();
render();
assert.equal(normalizations, 1, 'Playback-only renders reuse normalization');
const marker = nodes(tree, (node) => node.props?.className === 'event-marker')[0];
assert.match(marker.props['aria-label'], /65 events/);
marker.props.onClick();
tree = render();
assert.equal(focused.length, 0, 'Opening a group never moves the simulation');
assert.equal(choices(tree).length, 30, 'Bound the picker DOM');
button(tree, 'Next').props.onClick();
tree = render();
assert.match(text(choices(tree)[0]), /mode-30/);
result = structuredClone(result);
tree = render();
assert.equal(choices(tree).length, 30, 'Keep the captured group stable during live polling');
choices(tree)[0].props.onClick();
tree = render();
assert.equal(choices(tree).length, 0);
assert.equal(focused[0][0], 1.3, 'Keep fractional recorded event times');
assert.deepEqual(focused[0][1], [0, 60]);
assert.equal(focused.length, 1);
nodes(tree, (node) => node.props?.className === 'event-marker')[0].props.onClick();
render();
listeners.get('wheel')({ target: {} });
assert.equal(choices(render()).length, 0, 'Scrolling outside the picker closes stale groups');
nodes(render(), (node) => node.props?.className === 'event-marker')[0].props.onClick();
render();
listeners.get('keydown')({ key: 'Escape' });
assert.equal(choices(render()).length, 0);
nodes(render(), (node) => node.props?.className === 'event-marker')[0].props.onClick();
render();
button(render(), 'Radio').props.onClick();
render();
result = { ...result, events: [] };
render();
tree = render();
assert.equal(
  button(tree, 'All').props['aria-pressed'],
  true,
  'Reset filters when a gap removes their category',
);
assert.equal(
  choices(tree).length,
  0,
  'Missing captured records close the picker after a gap/reset',
);
assert.equal(focused.length, 1, 'Closing, polling and empty histories never seek');
console.log(
  'Event strip passed: stable live picker, pagination, fractional seek, outside/escape dismissal, memoization and history reset.',
);
