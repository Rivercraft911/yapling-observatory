import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PerspectiveCamera, Vector3 } from 'three';
import { WGS84_A_M, WGS84_B_OVER_A } from './geodesy.ts';

let compiled = ts.transpileModule(
  await readFile(new URL('./FollowLink.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  },
).outputText;
compiled = compiled.replace(
  /from ['"](three)['"]/g,
  (_match, name) => `from '${import.meta.resolve(name)}'`,
);
compiled = compiled.replace(
  /from ['"]\.\/geodesy['"]/g,
  `from '${new URL('./geodesy.ts', import.meta.url).href}'`,
);
const { FollowLink, localLinkSegment, nearLinkOutsideEarth, clipLocalLinkToFrustum } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

const a = WGS84_A_M,
  b = a * WGS84_B_OVER_A;
const sc = [a + 550000, 0, 0],
  station = [a + 30, 0, 0];
const input = JSON.stringify([sc, station]);
const visible = localLinkSegment(sc, station);
assert.ok(visible.deltaDisplayM.every((value, index) => value === [-549970, 0, 0][index]));
assert.equal(visible.blockedByEarth, false);
const blocked = localLinkSegment(sc, [-a, 0, 0]);
assert.equal(blocked.blockedByEarth, true);
assert.ok(Math.abs(blocked.deltaDisplayM[0] + 550000) < 1e-8);
const polar = localLinkSegment([0, 0, b + 550000], [0, 0, -b]);
assert.ok(Math.abs(polar.deltaDisplayM[1] + 550000) < 1e-8);
assert.equal(polar.blockedByEarth, true);
assert.equal(localLinkSegment(sc, sc), null);
assert.equal(localLinkSegment([NaN, 0, 0], station), null);
assert.equal(JSON.stringify([sc, station]), input);

const camera = new PerspectiveCamera(34, 1.4, 0.2, 2);
camera.position.set(0.645, 1.29 * Math.sqrt(0.75), 0);
camera.up.set(1, 0, 0);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const originalNear = camera.near,
  originalFar = camera.far;
const renders = [];
const renderer = {
  autoClear: true,
  render: (scene, lineCamera) => renders.push({ scene, lineCamera }),
};
const link = new FollowLink(renderer, 0.018 * a, 0.012 * a);
link.setLink(sc, station, '#e6e1d9', false);
assert.equal(link.update(camera, 0.0001), true);
assert.equal(camera.near, originalNear);
assert.equal(camera.far, originalFar);
assert.ok(Math.abs(link.camera.far - 0.0001 * a * 1.001) < 1e-10);
assert.deepEqual(link.camera.quaternion.toArray(), camera.quaternion.toArray());
link.render();
assert.equal(renderer.autoClear, true);
const dashed = renders[0].scene.children.find((line) => line.visible);
const positions = dashed.geometry.getAttribute('position'),
  distances = dashed.geometry.getAttribute('lineDistance');
assert.equal(Math.hypot(positions.getX(0), positions.getY(0), positions.getZ(0)), 0);
assert.equal(distances.getX(0), 0); // A real dash begins at the spacecraft, not a station-anchored gap.
const startScreen = new Vector3().project(link.camera);
assert.ok(Math.hypot(startScreen.x, startScreen.y) < 1e-14);
const clip = clipLocalLinkToFrustum(visible.deltaDisplayM, link.camera);
assert.ok(Math.hypot(...clip.end) < 10); // Clip before Float32, not a ~550km absolute endpoint.
const endpoint = new Vector3(...clip.end).project(link.camera);
assert.ok(Math.max(Math.abs(endpoint.x), Math.abs(endpoint.y)) <= 1 + 1e-10);
const nearScreen = new Vector3(...clip.end).project(link.camera);
const samePose = new PerspectiveCamera(34, 1.4, 0.0001 * a, 40 * a);
samePose.position.copy(camera.position);
samePose.quaternion.copy(camera.quaternion);
samePose.updateMatrixWorld();
const farScreen = new Vector3(...clip.end).project(samePose);
assert.ok(Math.hypot(nearScreen.x - farScreen.x, nearScreen.y - farScreen.y) < 1e-13);
assert.equal(nearLinkOutsideEarth([a + 100, 0, 0], camera, link.camera.far), false);
camera.position.multiplyScalar(10000);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
assert.equal(link.update(camera, 0.0001), false); // Far follow uses the original Earth-pass line.
link.dispose();
console.log(
  'Follow link checks passed: exact local origin, WGS84 blocking/equator/pole, frustum clipping, dash anchor, aligned projection, outside-Earth gate, immutable input and independent spacecraft clipping.',
);
