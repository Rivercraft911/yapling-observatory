import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';

const compiled = ts.transpileModule(
  await readFile(new URL('./previewVisibility.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  },
).outputText;
const {
  STAR_TRACKER_GROUP,
  OPTIONAL_MODULES,
  isVisiblePart,
  setStarTrackerVisibility,
  setModuleVisibility,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const root = new Group(),
  tracker = new Group(),
  carrier = new Group();
tracker.name = STAR_TRACKER_GROUP;
const lens = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), new MeshBasicMaterial());
root.add(tracker);
tracker.add(carrier);
carrier.add(lens);
const unrelated = new Group();
root.add(unrelated);
const originalMatrix = lens.matrix.toArray();
assert.equal(isVisiblePart(lens), true);
const hidden = setStarTrackerVisibility(root, false, lens);
assert.equal(hidden.found, true);
assert.equal(hidden.selected, null);
assert.equal(isVisiblePart(lens), false);
assert.equal(lens.visible, true); // Ancestry, not only the mesh's own flag, governs picking/collision.
assert.equal(setStarTrackerVisibility(root, false, unrelated).selected, unrelated);
assert.equal(setStarTrackerVisibility(root, true, null).found, true);
assert.equal(isVisiblePart(lens), true);
assert.deepEqual(lens.matrix.toArray(), originalMatrix);
const exterior = new Group();
assert.equal(setStarTrackerVisibility(exterior, false, unrelated).found, false);
assert.equal(setStarTrackerVisibility(exterior, false, unrelated).selected, unrelated);
const fixed = new Group();
fixed.name = 'SSI_GUIDES_FIXED';
root.add(fixed);
const wheels = OPTIONAL_MODULES.find((module) => module.label === 'Reaction wheels').groups.map(
  (name) => {
    const group = new Group();
    group.name = name;
    root.add(group);
    return group;
  },
);
for (const wheel of wheels)
  assert.equal(setModuleVisibility(root, wheel.name, false, wheel).selected, null);
assert(wheels.every((wheel) => !isVisiblePart(wheel)));
assert.equal(isVisiblePart(fixed), true);
assert.equal(isVisiblePart(lens), true);
for (const wheel of wheels) setModuleVisibility(root, wheel.name, true, null);
assert(wheels.every((wheel) => isVisiblePart(wheel)));
lens.geometry.dispose();
lens.material.dispose();
console.log(
  'Cutaway visibility checks passed: removable group, hidden selection fallback, ancestry-aware picking/collision, unchanged transforms and v03 no-op compatibility.',
);
