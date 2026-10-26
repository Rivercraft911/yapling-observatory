import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { inspectionCameraPose, sphereFramingDistance } from './workbenchCamera.ts';

const near = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const camera = new PerspectiveCamera(38, 1.6, 0.0003, 100);
const cutaway = inspectionCameraPose('cutaway');
camera.position.copy(cutaway.position);
camera.up.copy(cutaway.up);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const center = new Vector3().project(camera);
const patch = new Vector3(0, 0, -0.05).project(camera);
const antennaDeck = new Vector3(0, 0, 0.05).project(camera);
near(patch.x, center.x);
near(antennaDeck.x, center.x);
assert.ok(patch.y > center.y, 'Patch deck must project above the body center.');
assert.ok(antennaDeck.y < center.y, 'Opposite antenna deck must project below the body.');
for (const openSide of [new Vector3(1, 0, 0), new Vector3(0, 1, 0)])
  assert.ok(openSide.dot(camera.position) > 0, 'Both removed side panels must face the viewer.');
const exterior = inspectionCameraPose('exterior');
assert.deepEqual(exterior.position.toArray(), [0.43, 0.3, -0.57]);
assert.deepEqual(exterior.up.toArray(), [0, 1, 0]);

// A full bounding sphere must fit the tighter viewport dimension, including portrait panes.
for (const aspect of [0.4, 1, 1.6, 2.8]) {
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const radius = 0.12;
  camera.position
    .copy(cutaway.position)
    .normalize()
    .multiplyScalar(sphereFramingDistance(camera, radius));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  for (let polar = 0; polar <= 60; polar++) {
    for (let azimuth = 0; azimuth < 120; azimuth++) {
      const point = new Vector3()
        .setFromSphericalCoords(radius, (polar * Math.PI) / 60, (azimuth * Math.PI) / 60)
        .project(camera);
      assert.ok(Math.abs(point.x) < 0.9 && Math.abs(point.y) < 0.9);
    }
  }
}
console.log(
  'Workbench camera checks passed: patch up, open-side visibility, exterior pose and landscape/portrait framing.',
);
