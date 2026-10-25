import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PerspectiveCamera, Vector3 } from 'three';

const sourceUrl = new URL('./SpacecraftFollow.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
let compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
compiled = compiled.replace(
  /from ['"](three(?:\/[^'"]*)?)['"]/g,
  (_match, name) => `from '${import.meta.resolve(name)}'`,
);
compiled = compiled.replace(
  /from ['"]\.\.\/graphics\/spacecraftDisplay['"]/g,
  `from '${new URL('../graphics/spacecraftDisplay.ts', import.meta.url).href}'`,
);
const { spacecraftEarthQuaternion } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const { fixtures } = JSON.parse(
  await readFile(new URL('./fixtures/follow-frames.json', import.meta.url), 'utf8'),
);
const bodyAxes = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
let maximumError = 0;
for (const fixture of fixtures) {
  for (const angle of [undefined, fixture.exact_angle]) {
    const input = [...fixture.q];
    const pose = spacecraftEarthQuaternion(input, fixture.time_s, fixture.duration_s, angle);
    assert.deepEqual(input, fixture.q);
    bodyAxes.forEach((axis, index) => {
      const actual = new Vector3(...axis).applyQuaternion(pose);
      const error = actual.distanceTo(new Vector3(...fixture.expected[index]));
      maximumError = Math.max(maximumError, error);
      assert.ok(error < 3e-14, `${fixture.mode}, t=${fixture.time_s}, axis=${index}: ${error}`);
    });
  }
}
const satellite = new Vector3(-0.45, 0.61, 0.68);
const local = new PerspectiveCamera(34, 1.4, 0.00005, 100);
local.position.set(0.8, 1.1, -1.2);
local.lookAt(0, 0, 0);
local.updateMatrixWorld();
const earth = new PerspectiveCamera(34, 1.4, 0.00001, 100);
earth.position.copy(satellite).addScaledVector(local.position, 1 / 6378137);
earth.quaternion.copy(local.quaternion);
earth.updateMatrixWorld();
const screen = satellite.clone().project(earth);
assert.ok(Math.hypot(screen.x, screen.y) < 3e-9);
console.log(
  `Follow frame checks passed: ${fixtures.length} Python fixtures, exact/fallback angle, immutable input, aligned dual-pass projection. Maximum axis error ${maximumError}.`,
);
