import assert from 'node:assert/strict';
import { plotDefinitions } from './registry.ts';
import {
  plotLayouts,
  readPlotPreferences,
  writePlotPreferences,
  togglePlotSelection,
  effectivePlotSelection,
  defaultPlotSelection,
  linkPlotSelection,
} from './plotPreferences.ts';

const ids = plotDefinitions.map((definition) => definition.id);
const saved = new Map();
const storage = {
  getItem: (key) => saved.get(key) ?? null,
  setItem: (key, value) => saved.set(key, value),
};
const earth = readPlotPreferences('compact', ids, storage);
const results = readPlotPreferences('results', ids, storage);
assert.deepEqual(earth.selection, ['pointing', 'margin', 'rate']);
assert.deepEqual(results.selection, [
  'margin',
  'rate',
  'pointing',
  'wheel_capacity',
  'power',
  'temperatures',
]);
assert.equal(results.columns, 'auto');
assert.equal(earth.selectionPreset, 'default');
assert.equal(results.selectionPreset, 'default');
assert.equal(plotLayouts.compact.maximum, 6);
assert.equal(plotLayouts.results.maximum, 12);
assert(earth.selection.every((id) => ids.includes(id)));
assert(results.selection.every((id) => ids.includes(id)));
assert.notEqual(plotLayouts.compact.storageKey, plotLayouts.results.storageKey);

// Existing Earth arrays remain compatible; Results has a versioned, independent record.
writePlotPreferences('compact', { selection: ['range', 'margin'], columns: 'auto' }, storage);
const earthSaved = storage.getItem(plotLayouts.compact.storageKey);
writePlotPreferences('results', { selection: ids.slice(0, 12), columns: 3 }, storage);
assert.equal(storage.getItem(plotLayouts.compact.storageKey), earthSaved);
assert.deepEqual(JSON.parse(earthSaved), ['range', 'margin']);
assert.deepEqual(readPlotPreferences('compact', ids, storage).selection, ['range', 'margin']);
assert.deepEqual(readPlotPreferences('results', ids, storage), {
  selection: ids.slice(0, 12),
  columns: 3,
});
writePlotPreferences('compact', { selection: ['pointing'], columns: 'auto' }, storage);
assert.equal(readPlotPreferences('results', ids, storage).selection.length, 12);

for (const layout of ['compact', 'results']) {
  const maximum = plotLayouts[layout].maximum;
  const full = ids.slice(0, maximum);
  const original = [...full];
  assert.deepEqual(togglePlotSelection(full, ids[maximum], layout), full);
  assert.deepEqual(full, original);
  assert.equal(togglePlotSelection(full, full[0], layout).length, maximum - 1);
  assert.equal(togglePlotSelection(full.slice(0, -1), ids[maximum], layout).length, maximum);
  assert.deepEqual(togglePlotSelection([ids[0]], ids[0], layout), [ids[0]]);
}

const resultKey = plotLayouts.results.storageKey;
for (const selection of [
  [],
  ['missing-telemetry'],
  ['pointing', 'pointing'],
  ids.slice(0, 13),
  null,
]) {
  saved.set(resultKey, JSON.stringify({ version: 1, selection, columns: 2 }));
  assert.deepEqual(
    readPlotPreferences('results', ids, storage).selection,
    plotLayouts.results.defaults,
  );
}
for (const record of [
  '{broken',
  JSON.stringify(['margin']),
  JSON.stringify({ version: 2, selection: ['margin'] }),
  'null',
]) {
  saved.set(resultKey, record);
  assert.deepEqual(readPlotPreferences('results', ids, storage), {
    selection: plotLayouts.results.defaults,
    columns: 'auto',
    selectionPreset: 'default',
  });
}
for (const columns of ['auto', 1, 2, 3]) {
  saved.set(resultKey, JSON.stringify({ version: 1, selection: ['margin'], columns }));
  assert.equal(readPlotPreferences('results', ids, storage).columns, columns);
}
for (const columns of [0, 4, '3', [], true]) {
  saved.set(resultKey, JSON.stringify({ version: 1, selection: ['margin'], columns }));
  assert.deepEqual(readPlotPreferences('results', ids, storage), {
    selection: ['margin'],
    columns: 'auto',
  });
}
const unavailable = {
  getItem() {
    throw new Error('storage unavailable');
  },
  setItem() {
    throw new Error('storage unavailable');
  },
};
assert.deepEqual(
  readPlotPreferences('results', ids, unavailable).selection,
  plotLayouts.results.defaults,
);
assert.doesNotThrow(() => writePlotPreferences('results', results, unavailable));
const independent = readPlotPreferences('results', ids);
independent.selection.pop();
assert.equal(readPlotPreferences('results', ids).selection.length, 6);

for (const layout of ['compact', 'results']) {
  const automatic = readPlotPreferences(layout, ids);
  writePlotPreferences(layout, automatic, storage);
  const restored = readPlotPreferences(layout, ids, storage);
  assert.equal(restored.selectionPreset, 'default');
  assert.deepEqual(
    effectivePlotSelection(restored, layout, true),
    defaultPlotSelection(layout, true),
  );
  assert.deepEqual(effectivePlotSelection(restored, layout, false), plotLayouts[layout].defaults);
  for (const adaptive of [false, true]) {
    const link = { ...restored, selectionPreset: 'link' };
    writePlotPreferences(layout, link, storage);
    assert.deepEqual(
      effectivePlotSelection(readPlotPreferences(layout, ids, storage), layout, adaptive),
      linkPlotSelection(layout, adaptive),
    );
  }
  const custom = { selection: ['margin', 'rate'], columns: 'auto' };
  assert.deepEqual(effectivePlotSelection(custom, layout, true), custom.selection);
}
console.log(
  'Plot preferences passed: independent Earth/Results storage, explicit legacy choices, adaptive-aware preset intent, twelve/six limits, columns, last-plot protection and malformed/unavailable storage.',
);
