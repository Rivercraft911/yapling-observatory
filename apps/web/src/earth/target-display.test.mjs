import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PerspectiveCamera, Vector3 } from 'three';
import { WGS84_A_M, WGS84_B_OVER_A, ecefToDisplay, isEarthOccluded } from './geodesy.ts';

async function moduleUrl(name, dependencies = {}) {
  let compiled = ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  compiled = compiled.replace(/from ['"]three['"]/g, `from '${import.meta.resolve('three')}'`);
  compiled = compiled.replace(
    /from ['"]\.\/geodesy['"]/g,
    `from '${new URL('./geodesy.ts', import.meta.url).href}'`,
  );
  for (const [path, url] of Object.entries(dependencies))
    compiled = compiled.replace(`from '${path}'`, `from '${url}'`);
  return `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
}
const { TargetDisplay, activeTargetAtSample } = await import(
  await moduleUrl('./TargetDisplay.ts', { './FollowLink': await moduleUrl('./FollowLink.ts') })
);
const { earthDepthRange } = await import(await moduleUrl('./geometry.ts'));
const a = WGS84_A_M;
const targets = [[a, 0, 0], null, [0, a, 0], [NaN, 0, 0], [1, 2]];
const saved = structuredClone(targets);
assert.equal(activeTargetAtSample(undefined, 0), null);
assert.equal(activeTargetAtSample(targets, -1), null);
assert.equal(activeTargetAtSample(targets, 10), null);
assert.deepEqual(activeTargetAtSample(targets, 0), [a, 0, 0]);
assert.equal(activeTargetAtSample(targets, 1), null);
assert.deepEqual(activeTargetAtSample(targets, 2), [0, a, 0]);
assert.equal(activeTargetAtSample(targets, 3), null);
assert.equal(activeTargetAtSample(targets, 4), null);
assert.deepEqual(targets, saved);

const rendered = [];
const renderer = {
  autoClear: true,
  render(scene, camera) {
    rendered.push({ scene, camera: camera.clone() });
  },
};
const display = new TargetDisplay(renderer);
assert.equal(display.group.visible, false);
const spacecraft = [a + 550000, 0, 0];
const target = [a, 0, 0];
const before = JSON.stringify([spacecraft, target]);
display.setTarget(spacecraft, target);
assert.equal(JSON.stringify([spacecraft, target]), before);
assert.equal(display.group.visible, true);
assert.deepEqual(display.marker.position.toArray(), ecefToDisplay(target));
const line = display.group.children.find((child) => child.isLine);
assert.equal(line.material.isLineDashedMaterial, true);
assert.equal(line.material.color.getHexString(), 'd8b77c');
assert.equal(line.material.depthTest, true);
assert.equal(line.material.depthWrite, false);
assert.equal(line.material.dashSize, 0.004);
assert.deepEqual(line.position.toArray(), ecefToDisplay(spacecraft));
const positions = line.geometry.getAttribute('position');
assert.equal(Math.hypot(positions.getX(0), positions.getY(0), positions.getZ(0)), 0);
assert.ok(Math.abs(positions.getX(1) + 550000 / a) < 1e-8);
assert.equal(line.geometry.getAttribute('lineDistance').getX(0), 0);
assert.ok(Math.abs(display.backgroundSegment[3] - 1) < 1e-12);
assert.ok(Math.abs(display.backgroundSegment[0] - spacecraft[0] / a) < 1e-12);

// A target across the Earth remains at its returned position; its ray stops at the limb.
for (const [sc, targetBehind] of [
  [spacecraft, [-a, 0, 0]],
  [
    [0, 0, a * WGS84_B_OVER_A + 550000],
    [0, 0, -a * WGS84_B_OVER_A],
  ],
  [spacecraft, [0, a, 0]],
]) {
  display.setTarget(sc, targetBehind);
  const endpoint = display.backgroundSegment.slice(3);
  const radiusSquared = endpoint[0] ** 2 + (endpoint[1] / WGS84_B_OVER_A) ** 2 + endpoint[2] ** 2;
  assert.ok(Math.abs(radiusSquared - 1) < 1e-12);
  assert.deepEqual(display.marker.position.toArray(), ecefToDisplay(targetBehind));
  assert.equal(isEarthOccluded(ecefToDisplay(sc), display.marker.position.toArray()), true);
}

// Close follow gets a clipped local ray; farther views fit the complete background segment.
display.setTarget(spacecraft, target);
let nearCount = 0;
for (const distanceM of [1, 5000, 10000, 50000, 100000, 500000, 1000000, 50000000]) {
  const local = new PerspectiveCamera(34, 1.5, 0.00005, Math.max(100, distanceM * 1.5));
  local.position.set(distanceM, 0, 0);
  local.lookAt(0, 0, 0);
  local.updateMatrixWorld();
  const before = local.toJSON();
  const earthPosition = new Vector3(...ecefToDisplay(spacecraft)).addScaledVector(
    local.position,
    1 / a,
  );
  let range = earthDepthRange(earthPosition, 34, 1.5, 1.32);
  let near = display.updateNear(local, range.near);
  if (!near) {
    range = earthDepthRange(earthPosition, 34, 1.5, 1.32, [display.backgroundSegment]);
    near = display.updateNear(local, range.near);
  }
  const count = rendered.length;
  display.renderNear();
  assert.deepEqual(local.toJSON(), before);
  assert.equal(renderer.autoClear, true);
  if (near) {
    nearCount++;
    assert.equal(rendered.length, count + 1);
    const pass = rendered.at(-1);
    assert.equal(pass.camera.far, range.near * a * 1.001);
    assert.deepEqual(pass.camera.quaternion.toArray(), local.quaternion.toArray());
    const visible = pass.scene.children.find((child) => child.visible);
    assert.equal(visible.material.isLineDashedMaterial, true);
    assert.equal(visible.material.color.getHexString(), 'd8b77c');
    const p = visible.geometry.getAttribute('position');
    for (const index of [0, 1]) {
      const projected = new Vector3().fromBufferAttribute(p, index).project(pass.camera);
      assert.ok(Math.abs(projected.x) < 1.000001 && Math.abs(projected.y) < 1.000001);
      assert.ok(projected.z > -1.000001 && projected.z < 1.000001);
    }
  } else {
    assert.equal(rendered.length, count);
    assert.ok(range.near < distanceM / a);
  }
}
assert.ok(nearCount >= 2);

for (const invalid of [null, [], [NaN, 0, 0], spacecraft]) {
  display.setTarget(spacecraft, invalid);
  assert.equal(display.group.visible, false);
  assert.deepEqual(display.backgroundSegment, []);
  assert.equal(display.updateNear(new PerspectiveCamera(), 0.1), false);
}
display.setTarget(spacecraft, target);
display.clear();
assert.equal(display.group.visible, false);
const count = rendered.length;
display.renderNear();
assert.equal(rendered.length, count);
display.dispose();

const earthSource = await readFile(new URL('./EarthScene.ts', import.meta.url), 'utf8');
assert.match(
  earthSource,
  /activeTargetAtSample\(samples\.pointing_target_ecef_m, bracket\?\.lower \?\? index\)/,
);
assert.match(
  earthSource,
  /this\.placeLabel\(this\.labels\.target, this\.targetDisplay\.marker\.position, activeCamera\)/,
);
assert.match(earthSource, /includeLos \? this\.targetDisplay\.backgroundSegment : \[\]/);
assert.match(
  earthSource,
  /this\.followLink\.render\(\);\s*this\.targetDisplay\.renderNear\(\);\s*this\.renderer\.clearDepth\(\);\s*this\.follow\.render\(\);/,
);
assert.doesNotMatch(
  await readFile(new URL('./TargetDisplay.ts', import.meta.url), 'utf8'),
  /active_direction|radio_delivery|receiver|groundTargetPicker/,
);
console.log(
  'Target display checks passed: returned guidance selection, null/invalid state, immutable input, distinct amber dashes, exact marker, WGS84 ray clipping, camera occlusion, close/far follow continuity, unchanged camera clipping and separate RF path. GPU appearance remains a browser QA check.',
);
