import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PerspectiveCamera, Vector3 } from 'three';
import { WGS84_A_M } from './geodesy.ts';

async function loadLocal(name) {
  let compiled = ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  compiled = compiled.replace(/from ['"]three['"]/g, `from '${import.meta.resolve('three')}'`);
  compiled = compiled.replace(
    /from ['"]\.\/geodesy['"]/g,
    `from '${new URL('./geodesy.ts', import.meta.url).href}'`,
  );
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
const { earthDepthRange, distanceToSegments, earthGeometry } = await loadLocal('./geometry.ts');
const { FollowLink } = await loadLocal('./FollowLink.ts');
const a = WGS84_A_M;
const cloudHeight = 8000 / a;
const depth = (z, near, far) => far / (far - near) - (far * near) / ((far - near) * z);
const depthSteps = (radius, range) =>
  Math.abs(
    depth(radius - 1, range.near, range.far) -
      depth(radius - 1 - cloudHeight, range.near, range.far),
  ) *
  (2 ** 24 - 1);
const before = depthSteps(9, { near: 0.0001, far: 40 });
const after = depthSteps(9, earthDepthRange({ x: 9, y: 0, z: 0 }, 34, 3, 1.32));
assert.ok(before < 1);
assert.ok(after > 500);
for (const radius of [1.025, 1.086, 1.4, 2, 4, 9, 10, 20]) {
  for (const aspect of [0.4, 1, 3, 6]) {
    const range = earthDepthRange({ x: radius, y: 0, z: 0 }, 34, aspect, 1.32);
    assert.ok(range.near > 0 && range.far > range.near);
    assert.ok(range.near < radius - 1.013);
    assert.ok(range.far > radius + 1.32);
    assert.ok(depthSteps(radius, range) > 100);
  }
}
// Nearby segments, not just endpoint bounds, constrain the near plane.
const line = [2, -1, 0, 2, 1, 0];
assert.ok(Math.abs(distanceToSegments({ x: 2.01, y: 0, z: 0 }, line) - 0.01) < 1e-12);
const fitted = earthDepthRange({ x: 2.01, y: 0, z: 0 }, 34, 2, 1.32, [line]);
assert.ok(fitted.near < 0.01 / 4);
const pointFitted = earthDepthRange(
  { x: 2.01, y: 0, z: 0 },
  34,
  2,
  1.32,
  [],
  [{ x: 2, y: 0, z: 0 }],
);
assert.equal(fitted.near, pointFitted.near);
// No discrete LOD step while dollying through the useful globe range.
let previous = earthDepthRange({ x: 1.025, y: 0, z: 0 }, 34, 3).near;
for (let radius = 1.026; radius < 10; radius += 0.001) {
  const current = earthDepthRange({ x: radius, y: 0, z: 0 }, 34, 3).near;
  assert.ok(current >= previous && current - previous < 0.0003);
  previous = current;
}
// Sweep intermediate follow distances and retain the exact local/background LOS join.
const sc = [a + 550000, 0, 0],
  station = [a + 30, 0, 0];
const satelliteDisplay = new Vector3(sc[0] / a, 0, 0);
const renderer = { autoClear: true, render() {} };
const link = new FollowLink(renderer, 0.018 * a, 0.012 * a);
const segment = link.setLink(sc, station, '#e6e1d9', false);
const los = [satelliteDisplay.x, 0, 0, station[0] / a, 0, 0];
let bridgeCount = 0;
for (const distanceM of [2, 5000, 10000, 50000, 100000, 250000, 550000, 1000000, 50000000]) {
  const local = new PerspectiveCamera(34, 3, 0.00005, 1e8);
  local.position.set(distanceM, 0, 0);
  local.up.set(0, 1, 0);
  local.lookAt(0, 0, 0);
  local.updateMatrixWorld();
  const earthPosition = satelliteDisplay.clone().addScaledVector(local.position, 1 / a);
  // The nearby history is intentionally hidden only within the existing5.1km threshold.
  const history =
    distanceM < 0.0008 * a ? [] : [satelliteDisplay.x, 0, -0.01, satelliteDisplay.x, 0, 0.01];
  let range = earthDepthRange(earthPosition, 34, 3, 1.32, [history]);
  let active = link.update(local, range.near);
  if (!active) {
    range = earthDepthRange(earthPosition, 34, 3, 1.32, [history, los]);
    active = link.update(local, range.near);
  }
  if (active) {
    bridgeCount++;
    assert.equal(link.camera.far, range.near * a * 1.001);
    assert.equal(link.camera.near, local.near);
    assert.deepEqual(link.camera.quaternion.toArray(), local.quaternion.toArray());
    // Both cameras share direction/FOV; the1.001 overlap leaves no depth gap.
    assert.ok(link.camera.far > range.near * a);
  } else {
    // Background clip cannot omit any in-view part of this nearby SC-to-GS ray.
    assert.ok(range.near < distanceM / a);
  }
  assert.ok(depthSteps(earthPosition.length(), range) > 1);
  assert.deepEqual(sc, [a + 550000, 0, 0]);
  assert.ok(segment.deltaDisplayM[0] < 0);
}
assert.ok(bridgeCount >= 2);
link.dispose();
// Actual WGS84 meshes have outward faces, a closed UV seam and an8km shell gap.
const ground = earthGeometry(),
  cloud = earthGeometry(8000);
const p = ground.getAttribute('position'),
  c = cloud.getAttribute('position'),
  n = ground.getAttribute('normal');
for (const index of [1, 128, 512, 10000, 20000, 30000]) {
  const pv = new Vector3().fromBufferAttribute(p, index),
    cv = new Vector3().fromBufferAttribute(c, index);
  assert.ok(Math.abs(pv.distanceTo(cv) - 8000 / a) < 2e-7);
  assert.ok(Math.abs(new Vector3().fromBufferAttribute(n, index).length() - 1) < 1e-7);
}
for (const row of [1, 32, 64, 96, 127]) {
  const first = row * 257,
    last = first + 256;
  assert.ok(
    new Vector3()
      .fromBufferAttribute(p, first)
      .distanceTo(new Vector3().fromBufferAttribute(p, last)) < 1e-12,
  );
}
for (const triangle of [6 * (17 * 256 + 30), 6 * (64 * 256 + 128), 6 * (103 * 256 + 214)]) {
  const indices = ground.getIndex();
  const va = new Vector3().fromBufferAttribute(p, indices.getX(triangle));
  const vb = new Vector3().fromBufferAttribute(p, indices.getX(triangle + 1));
  const vc = new Vector3().fromBufferAttribute(p, indices.getX(triangle + 2));
  assert.ok(vb.sub(va).cross(vc.sub(va)).dot(va) > 0);
}
ground.dispose();
cloud.dispose();
console.log(
  `PASS: adaptive Earth depth, visible segment/point bounds, continuous dolly, intermediate FollowLink joins and WGS84 shell geometry. At 9a cloud/surface separation: old ${before.toFixed(3)} vs new ${after.toFixed(0)} depth steps (24-bit).`,
);
