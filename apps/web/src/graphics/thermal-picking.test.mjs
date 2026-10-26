import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion as ThreeQuaternion,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
import { thermalNodeForPart } from './thermalOverlay.ts';
import { isVisiblePart } from '../spacecraft/previewVisibility.ts';

// Execute the actual Workbench handlers with real Three.js geometry and raycasting.
const source = await readFile(new URL('../Workbench.tsx', import.meta.url), 'utf8');
const start = source.indexOf('    let tap:');
const end = source.indexOf('    const visibility =', start);
assert.ok(start >= 0 && end > start);
const handlers = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();
function fixture(mode = 'orbit') {
  const root = new Group();
  root.name = 'SSI_BATTERY_CASSETTE';
  const part = new Mesh(geometry, material);
  part.name = 'Battery';
  root.add(part);
  root.updateMatrixWorld(true);
  const camera = new PerspectiveCamera(38, 800 / 600, 0.001, 100);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const picks = [];
  const env = {
    canvas: {
      focus() {},
      setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    },
    camera,
    root,
    thermalPick: { current: (node) => picks.push(node) },
    pointer: new Vector2(),
    raycaster: new Raycaster(),
    isVisiblePart,
    thermalNodeForPart,
    setSelection() {},
    frameObject() {
      assert.fail('Thermal selection must not frame the camera.');
    },
    Mesh,
    ThreeQuaternion,
    Vector3,
    mode,
  };
  const create = new Function(
    ...Object.keys(env),
    `
    let currentMode = mode, dragging = false, selected = null;
    const keys = new Set();
    ${handlers}
    return {pointerDown, pointerMove, pointerUp, blur};
  `,
  );
  return { ...create(...Object.values(env)), root, camera, picks };
}
const event = (pointerId = 1, x = 400, isPrimary = true, button = 0) => ({
  pointerId,
  clientX: x,
  clientY: 300,
  isPrimary,
  button,
  pointerType: 'touch',
});
const click = fixture();
const cameraBefore = click.camera.toJSON();
click.pointerDown(event());
click.pointerUp(event(1, 403));
assert.deepEqual(click.picks, ['battery']);
assert.deepEqual(click.camera.toJSON(), cameraBefore);

for (const sequence of [
  // A drag stays cancelled even when it returns to its starting point.
  [
    ['pointerDown', event()],
    ['pointerMove', event(1, 450)],
    ['pointerUp', event()],
  ],
  // Final displacement matters even if there was no delivered pointermove.
  [
    ['pointerDown', event()],
    ['pointerUp', event(1, 406)],
  ],
  // Adding and lifting a second finger cannot re-arm a drag as a selection.
  [
    ['pointerDown', event()],
    ['pointerMove', event(1, 450)],
    ['pointerDown', event(2, 500, false)],
    ['pointerUp', event(2, 500, false)],
    ['pointerUp', event(1, 450)],
  ],
  [
    ['pointerDown', event()],
    ['pointerDown', event(2, 500, false)],
    ['pointerUp', event()],
    ['pointerUp', event(2, 500, false)],
  ],
  [
    ['pointerDown', event(2, 400, false)],
    ['pointerUp', event(2, 400, false)],
  ],
  [
    ['pointerDown', event()],
    ['pointerUp', event(2)],
  ],
  [
    ['pointerDown', event(1, 400, true, 2)],
    ['pointerUp', event(1, 400, true, 2)],
  ],
  [['pointerDown', event()], ['blur'], ['pointerUp', event()]],
]) {
  const view = fixture();
  for (const [handler, input] of sequence) view[handler](input);
  assert.deepEqual(view.picks, []);
}
for (const kind of ['fly', 'hidden', 'unmapped']) {
  const view = fixture(kind === 'fly' ? 'fly' : 'orbit');
  if (kind === 'hidden') view.root.visible = false;
  if (kind === 'unmapped') view.root.name = 'Unknown';
  view.pointerDown(event());
  view.pointerUp(event());
  assert.deepEqual(view.picks, []);
}
geometry.dispose();
material.dispose();
console.log(
  'Thermal picking checks passed: actual handlers, real raycast, primary click with unchanged camera, drag/return, final displacement, secondary touches, cancellation, fly mode and hidden/unmapped parts.',
);
