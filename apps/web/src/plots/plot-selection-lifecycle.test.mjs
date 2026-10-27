import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { plotDefinitions } from './registry.ts';
import * as preferences from './plotPreferences.ts';
import * as timeWindow from './timeWindow.ts';

const source = await readFile(new URL('./PlotDock.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const jsx = (type, props) => ({ type, props });
const snapshot = (adaptive = false) => ({
  run: {
    result: {
      samples: {
        time_s: [0, 10],
        ...(adaptive
          ? { radio_delivery: { downlink: { ready_payload_rate_bps: [0, 1000] } } }
          : {}),
      },
    },
  },
});
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function harness(layout, saved = new Map()) {
  const slots = [];
  let cursor = 0;
  let effects = [];
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
    window: {
      localStorage: {
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => saved.set(key, value),
      },
    },
    document: { addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './plotPreferences') return preferences;
      if (name === './timeWindow') return timeWindow;
      if (name === './registry') return { plotDefinitions, plotTraces: () => [] };
      if (name === './TracePlot') return { TracePlot: 'TracePlot' };
      if (name === '../mission/MissionReport') return { MissionReport: 'MissionReport' };
      if (name === './PowerStatus') return { PowerStatus: 'PowerStatus' };
      if (name === './LinkStatus') return { LinkStatus: 'LinkStatus' };
      if (name === './traceFormatting') return { formatElapsedSeconds: String };
      if (name === '../mission/missionReporting') return { missionReport: () => null };
      if (name === './plots.css') return {};
      throw new Error(name);
    },
  });
  return {
    saved,
    render(next) {
      cursor = 0;
      effects = [];
      const element = exports.PlotDock({
        snapshot: next,
        baseline: null,
        cursorTime: 0,
        onScrub() {},
        layout,
      });
      const tree = element.type(element.props);
      for (const effect of effects) effect();
      return tree;
    },
  };
}
const titles = (tree) =>
  nodes(tree, (node) => node.type === 'TracePlot').map((node) => node.props.title);
const button = (tree, label) =>
  nodes(tree, (node) => node.type === 'button' && text(node) === label)[0];
const fixed = snapshot();
const adaptive = snapshot(true);
for (const layout of ['compact', 'results']) {
  const app = harness(layout);
  assert(titles(app.render(null)).includes('Fixed-mode rate'));
  assert.equal(
    JSON.parse(app.saved.get(preferences.plotLayouts[layout].storageKey)).selectionPreset,
    'default',
    'Persist the automatic intent before telemetry arrives',
  );
  let tree = app.render(adaptive);
  assert(titles(tree).includes('Selected-mode margin'));
  assert(titles(tree).includes('Payload rate'));
  assert(!titles(tree).includes('Fixed-mode rate'));
  assert(titles(app.render(fixed)).includes('Fixed-mode rate'));
  assert(titles(app.render(adaptive)).includes('Payload rate'));
  const reloaded = harness(layout, app.saved);
  assert(titles(reloaded.render(adaptive)).includes('Payload rate'));

  button(tree, 'GNC').props.onClick();
  const gnc = titles(app.render(adaptive));
  assert.deepEqual(titles(app.render(fixed)), gnc, 'Keep the selected subsystem');
  tree = app.render(fixed);
  button(tree, 'Link').props.onClick();
  assert(titles(app.render(fixed)).includes('Fixed-mode margin'));
  assert(titles(app.render(adaptive)).includes('Selected-mode margin'));
  tree = app.render(adaptive);
  button(tree, layout === 'results' ? 'Overview' : 'Link').props.onClick();
  assert(!titles(app.render(adaptive)).includes('Fixed-mode rate'));
  tree = app.render(adaptive);
  button(tree, `Plots ${titles(tree).length}`).props.onClick();
  tree = app.render(adaptive);
  const choice = nodes(
    tree,
    (node) => node.type === 'label' && text(node) === 'Fixed-mode ratekb/s',
  )[0];
  nodes(choice, (node) => node.type === 'input')[0].props.onChange();
  const custom = titles(app.render(adaptive));
  assert(custom.includes('Fixed-mode rate'));
  assert.deepEqual(titles(app.render(fixed)), custom, 'Keep explicit custom channel choices');
  assert.deepEqual(titles(app.render(adaptive)), custom);
  assert.deepEqual(
    titles(harness(layout, app.saved).render(adaptive)),
    custom,
    'Preserve custom choices after reload',
  );
}
const legacyCompact = new Map([
  [
    preferences.plotLayouts.compact.storageKey,
    JSON.stringify(preferences.plotLayouts.compact.defaults),
  ],
]);
assert.deepEqual(titles(harness('compact', legacyCompact).render(adaptive)), [
  'Pointing error',
  'Fixed-mode margin',
  'Fixed-mode rate',
]);
const legacyResults = new Map([
  [
    preferences.plotLayouts.results.storageKey,
    JSON.stringify({ version: 1, selection: ['margin', 'rate'], columns: 2 }),
  ],
]);
assert.deepEqual(titles(harness('results', legacyResults).render(adaptive)), [
  'Fixed-mode margin',
  'Fixed-mode rate',
]);
console.log(
  'Plot selection lifecycle passed: asynchronous adaptive defaults, history changes, presets, pre-run persistence, explicit legacy/custom choices and subsystem preservation.',
);
