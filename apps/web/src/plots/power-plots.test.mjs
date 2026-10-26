import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as registry from './registry.ts';
import * as preferences from './plotPreferences.ts';
import * as navigation from './timeWindow.ts';
import * as formatting from './traceFormatting.ts';

const power = {
  potential_bus_w: [4, 0],
  requested_load_w: [2, 2.5],
  net_bus_w: [2, -2.5],
  battery_soc: [0.6, 0.59],
  stored_energy_wh: [25, 24.9],
  battery_current_a: [0.2, -0.1],
  actuator_bus_w: [1.225, 1.304],
  actuator_heat_w: [1.1, 1.2],
  component_electrical_w: { wheels: [1.2, 1.3], magnetorquers: [0.025, 0.004] },
};
const samples = {
  time_s: [0, 30],
  visible: [false, false],
  uplink: { margin_db: [null, null] },
  downlink: { margin_db: [null, null] },
  power,
};
const snapshot = { run: { result: { samples } } };
const original = structuredClone(snapshot);
const definition = registry.plotDefinitions.find((plot) => plot.id === 'actuator_power');
assert.equal(definition.unit, 'W');
assert.deepEqual(
  definition.read(samples).map((trace) => trace.label),
  ['Total', 'Wheels', 'MTQ'],
);
for (const [index, values] of [
  power.actuator_bus_w,
  power.component_electrical_w.wheels,
  power.component_electrical_w.magnetorquers,
].entries()) {
  assert.equal(definition.read(samples)[index].values, values, 'Select returned W directly');
}
for (const legacy of [{}, { actuator_bus_w: [1.2, 1.2] }]) {
  const traces = registry.plotTraces(definition, {
    run: { result: { samples: { time_s: [0, 30], power: legacy } } },
  });
  assert(traces.slice(1).every((trace) => trace.values.every((value) => value === null)));
  if (legacy.actuator_bus_w) assert.deepEqual(traces[0].values, [1.2, 1.2]);
  else assert.deepEqual(traces[0].values, [null, null]);
}
const compiled = ts.transpileModule(
  await readFile(new URL('./PlotDock.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
const element = (type, props) => ({ type, props });
function createDock(layout) {
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value) => (slots[index] = typeof value === 'function' ? value(slots[index]) : value),
      ];
    },
    useRef: (value) => ({ current: value }),
    useMemo: (compute) => compute(),
    useEffect() {},
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    window: { localStorage: { getItem: () => null } },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime')
        return { jsx: element, jsxs: element, Fragment: 'fragment' };
      if (name === './registry') return registry;
      if (name === './plotPreferences') return preferences;
      if (name === './timeWindow') return navigation;
      if (name === './traceFormatting') return formatting;
      return new Proxy({}, { get: (_, key) => key });
    },
  });
  return () => {
    cursor = 0;
    const root = exports.PlotDock({ layout, snapshot, baseline: null, cursorTime: 0 });
    return root.type(root.props);
  };
}
function all(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...(Array.isArray(tree) ? tree : [tree.props?.children]).flatMap((child) =>
      all(child, predicate),
    ),
  ];
}
for (const layout of ['compact', 'results']) {
  const render = createDock(layout);
  all(
    render(),
    (node) => node.type === 'button' && node.props.children === 'Power',
  )[0].props.onClick();
  const plots = all(render(), (node) => node.type === 'TracePlot');
  const actuators = plots.find((plot) => plot.props.title === 'Actuator electrical power');
  assert(actuators, `${layout}: Power preset includes actuator electrical draw`);
  assert.equal(actuators.props.unit, 'W');
  assert.equal(actuators.props.description, definition.description);
  assert.deepEqual(
    actuators.props.traces.map((trace) => trace.values),
    [
      power.actuator_bus_w,
      power.component_electrical_w.wheels,
      power.component_electrical_w.magnetorquers,
    ],
  );
  assert(!plots.some((plot) => ['Battery current', 'Battery voltage'].includes(plot.props.title)));
  all(
    render(),
    (node) => node.type === 'button' && node.props.children === 'Battery',
  )[0].props.onClick();
  assert(
    all(render(), (node) => node.type === 'TracePlot' && node.props.title === 'Battery current')
      .length,
  );
}
assert.deepEqual(snapshot, original);
console.log(
  'Power plots passed: Power presets show returned total/wheel/MTQ electrical W, missing component telemetry stays unavailable, Battery retains current, and histories remain unchanged.',
);
