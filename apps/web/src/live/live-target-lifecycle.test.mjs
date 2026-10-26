import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { LiveDisplayClock } from './liveDisplayClock.ts';
import { displayBracket } from '../graphics/displayInterpolation.ts';
import { unloadingStatusLabels } from '../mission/unloadingStatus.ts';

const source = await readFile(new URL('./LiveWorkspace.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const flush = () => new Promise(setImmediate);
function find(element, predicate) {
  if (!element || typeof element !== 'object') return;
  if (predicate(element)) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let now = 0;
  let animationId = 0;
  const animationFrames = new Map();
  const requests = [],
    commands = [];
  const changed = (before, after) =>
    !before || after.some((value, i) => !Object.is(value, before[i]));
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[index].value,
        (next) => {
          slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useMemo(compute, dependencies) {
      const index = cursor++;
      if (changed(slots[index]?.dependencies, dependencies))
        slots[index] = { dependencies, value: compute() };
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
  hooks.useLayoutEffect = hooks.useEffect;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    AbortController,
    Error,
    structuredClone,
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      const id = ++animationId;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === '../api')
        return {
          api: (path, options) =>
            new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
        };
      if (name === '../EarthView') return { EarthView: 'EarthView' };
      if (name === '../Resizer') return { PaneDivider: 'PaneDivider' };
      if (name === '../plots/PlotDock') return { PlotDock: 'PlotDock' };
      if (name === '../plots/TracePlot') return { closestIndex: () => 0, formatValue: () => '—' };
      if (name === '../graphics/displayInterpolation') return { displayBracket };
      if (name === '../mission/unloadingStatus') return { unloadingStatusLabels };
      if (name === '../mission/MissionPresetSelect')
        return { MissionPresetSelect: 'MissionPresetSelect' };
      if (name === '../mission/missionDuration') return { setMissionDuration() {} };
      if (name === './live.css') return {};
      if (name === './liveDisplayClock') return { LiveDisplayClock };
      throw new Error(`Unexpected component dependency: ${name}`);
    },
  });
  return {
    requests,
    commands,
    at(milliseconds) {
      now = milliseconds;
    },
    frame(milliseconds) {
      now = milliseconds;
      const frames = [...animationFrames.values()];
      animationFrames.clear();
      for (const frame of frames) frame(now);
    },
    live(id) {
      return {
        session: {
          live_id: id,
          initial_scenario: { name: id, clocks: { output_step_s: 10, dynamics_step_s: 1 } },
          computed_time_s: 0,
          requested_duration_s: 120,
          status: 'running',
          speed: 60,
          unapplied_command_ids: [],
          pending_commands: 0,
        },
        snapshot: null,
        active: true,
        pending: false,
        error: '',
        acknowledgments: [],
        historyGap: false,
        command: (intent) =>
          new Promise((resolve, reject) => commands.push({ id, intent, resolve, reject })),
      };
    },
    render(live) {
      cursor = 0;
      effects = [];
      const tree = exports.LiveWorkspace({
        live,
        config: null,
        assets: { variants: {} },
        busy: false,
        onPreset: async () => {},
        onOpenResults: async () => true,
        layout: {
          compact: false,
          panelWidth: 310,
          panelMax: 500,
          sceneFraction: 0.56,
          onPanelWidth() {},
          onSceneFraction() {},
        },
      });
      for (const effect of effects) effect();
      return tree;
    },
    dispose() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
const picker = (tree) => find(tree, (element) => element.type === 'EarthView').props.onGroundTarget;
const target = (tree) => find(tree, (element) => element.props?.className === 'live-target');
const alert = (tree) => find(tree, (element) => element.props?.role === 'alert');
const position = [6378137, 0, 0];

// A session replacement invalidates a pending map conversion, even if a server
// reply wins a transport abort race and resolves afterward.
const replaced = harness();
const first = replaced.live('first'),
  second = replaced.live('second');
picker(replaced.render(first))(position);
replaced.render(second);
assert.equal(replaced.requests[0].options.signal.aborted, true);
replaced.requests[0].resolve({ latitude_deg: 1, longitude_deg: 2 });
await flush();
assert.equal(replaced.commands.length, 0);
assert.equal(target(replaced.render(second)), undefined);

// Request order follows the latest pick, not network response order.
const ordered = harness();
const current = ordered.live('current');
picker(ordered.render(current))(position);
picker(ordered.render(current))(position);
assert.equal(ordered.requests[0].options.signal.aborted, true);
ordered.requests[1].resolve({ latitude_deg: 20, longitude_deg: 30 });
await flush();
assert.equal(ordered.commands.length, 1);
assert.equal(ordered.commands[0].intent.target_latitude_deg, 20);
ordered.requests[0].resolve({ latitude_deg: 10, longitude_deg: 15 });
await flush();
assert.equal(ordered.commands.length, 1);
ordered.commands[0].resolve(true);
await flush();
assert(target(ordered.render(current)));

// A late command acknowledgment must not paint an old target onto a new session.
const acknowledgment = harness();
const old = acknowledgment.live('old'),
  fresh = acknowledgment.live('fresh');
picker(acknowledgment.render(old))(position);
acknowledgment.requests[0].resolve({ latitude_deg: -10, longitude_deg: 40 });
await flush();
assert.equal(acknowledgment.commands.length, 1);
acknowledgment.render(fresh);
acknowledgment.commands[0].resolve(true);
await flush();
assert.equal(target(acknowledgment.render(fresh)), undefined);
assert.equal(alert(acknowledgment.render(fresh)), undefined);

// Unmount cancels ownership; a stale failure cannot report into a later view.
const unmounted = harness();
picker(unmounted.render(unmounted.live('gone')))(position);
unmounted.dispose();
assert.equal(unmounted.requests[0].options.signal.aborted, true);
unmounted.requests[0].reject(new Error('stale map conversion failure'));
await flush();
console.log(
  'LIVE target lifecycle passed: session replacement, out-of-order picks, late command acknowledgments and unmount aborts cannot send or display stale targets.',
);

const content = (tree) => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (Array.isArray(tree) ? tree : [tree?.props?.children])
    .flat(Infinity)
    .map(content)
    .join('');
};
const livePresentation = harness();
const presentation = livePresentation.live('presented');
presentation.session.speed = 1;
const statuses = [
  'disabled',
  'active',
  'hardware_unavailable',
  'controller_inactive',
  'field_unavailable',
];
const sampleModes = ['sun_pointing', 'ground_tracking', 'imaging', 'auto', 'sun_pointing'];
const snapshots = (last) => ({
  scenario: {},
  run: {
    run_id: 'presented',
    result: {
      samples: {
        time_s: Array.from({ length: last + 1 }, (_, i) => i),
        mode: sampleModes.slice(0, last + 1),
        gnc: { unloading_status: statuses.slice(0, last + 1) },
      },
    },
  },
});
for (let second = 0; second <= 3; second++) {
  livePresentation.at(second * 1000);
  presentation.snapshot = snapshots(second);
  livePresentation.render(presentation);
}
let shown = livePresentation.render(presentation);
const earth = (tree) => find(tree, (item) => item.type === 'EarthView');
const plots = (tree) => find(tree, (item) => item.type === 'PlotDock');
const unloading = (tree) =>
  find(tree, (item) => item.props?.['aria-label'] === 'Simulated wheel unloading');
const strip = (tree) => find(tree, (item) => item.props?.className === 'live-strip');
assert.equal(plots(shown).props.cursorTime, 1.5);
assert.equal(earth(shown).props.sampleIndex, 1);
assert.equal(earth(shown).props.displayTime.current, 1.5);
assert.match(content(strip(shown)), /ground tracking/);
assert.match(content(unloading(shown)), /Active controller/);
assert.doesNotMatch(content(unloading(shown)), /hardware/);
const originalSamples = JSON.stringify(presentation.snapshot);
livePresentation.frame(3200);
shown = livePresentation.render(presentation);
assert.ok(Math.abs(plots(shown).props.cursorTime - 1.7) < 1e-10);
assert.equal(earth(shown).props.sampleIndex, 1);
plots(shown).props.onScrub(2.75);
livePresentation.render(presentation);
shown = livePresentation.render(presentation);
assert.equal(plots(shown).props.cursorTime, 2.75);
assert.equal(earth(shown).props.displayTime.current, 2.75);
assert.equal(earth(shown).props.sampleIndex, 2);
assert.match(content(unloading(shown)), /Inactive · hardware/);
find(shown, (item) => item.type === 'button' && item.props.children === 'Now').props.onClick();
livePresentation.render(presentation);
shown = livePresentation.render(presentation);
assert.equal(plots(shown).props.cursorTime, 3);
assert.equal(earth(shown).props.displayTime.current, 3);
assert.match(content(unloading(shown)), /Inactive · controller \/ mode/);
assert.equal(JSON.stringify(presentation.snapshot), originalSamples);
presentation.snapshot = snapshots(4);
presentation.session.status = 'paused';
presentation.session.paused = true;
livePresentation.render(presentation);
shown = livePresentation.render(presentation);
assert.equal(plots(shown).props.cursorTime, 4);
assert.equal(earth(shown).props.displayTime.current, 4);
assert.match(content(unloading(shown)), /Inactive · field/);
livePresentation.dispose();
console.log(
  'LIVE cursor passed: scene, plots, mode and returned unloading readout share displayed time; scrub, Now and pause synchronize without changing history.',
);
