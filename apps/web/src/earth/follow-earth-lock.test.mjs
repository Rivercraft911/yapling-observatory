import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof BUNDLED_EARTH_LOCK_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-follow-earth-lock-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: { BUNDLED_EARTH_LOCK_TEST: 'true' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: output,
      logLevel: 'warning',
    });
    await import(pathToFileURL(output).href);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  const assert = (await import('node:assert/strict')).default;
  const { Vector3 } = await import('three');
  const { SpacecraftFollow } = await import('./SpacecraftFollow.ts');
  const { EarthScene } = await import('./EarthScene.ts');
  class Canvas extends EventTarget {
    style = {};
    dataset = {};
    ownerDocument = new EventTarget();
    clientWidth = 1200;
    clientHeight = 800;
    height = 800;
    getRootNode() {
      return this.ownerDocument;
    }
  }
  class Follow extends SpacecraftFollow {
    createEarthEnvironment() {
      return { pmrem: { dispose() {} }, environment: { texture: {}, dispose() {} } };
    }
  }
  const canvas = new Canvas();
  const follow = new Follow({ domElement: canvas });
  follow.setEnabled(true);
  follow.controls.enableDamping = false;
  follow.setSize(1200, 800);
  const radius = 6928137;
  const position = (angle) =>
    Object.freeze([radius * Math.cos(angle), radius * Math.sin(angle), 0]);
  const display = (ecef) => new Vector3(ecef[0], ecef[2], -ecef[1]);
  let current = position(0);
  follow.setPosition(current);
  follow.update(0);
  follow.controls.enableDamping = false;
  const bearing = () =>
    display(current)
      .negate()
      .sub(follow.camera.position)
      .normalize()
      .applyQuaternion(follow.camera.quaternion.clone().invert());
  const initialPosition = follow.camera.position.clone();
  const initialQuaternion = follow.camera.quaternion.clone();
  const initialDistance = follow.camera.position.length();
  const initialBearing = bearing();
  follow.setEarthLock(true);
  assert(follow.camera.position.distanceTo(initialPosition) < 1e-12);
  assert(follow.camera.quaternion.angleTo(initialQuaternion) < 1e-7);
  assert.equal(canvas.dataset.earthLock, 'true');
  follow.controls.enableDamping = false;
  const controls = follow.controls;
  const attitude = Object.freeze([Math.SQRT1_2, Math.SQRT1_2, 0, 0]);
  for (let step = 0; step <= 720; step++) {
    current = position((step * Math.PI) / 360);
    follow.setPosition(current);
    follow.setPose(attitude, step, 720, step / 200);
    follow.update(1 / 60);
    assert(Math.abs(follow.camera.position.length() - initialDistance) < 1e-10);
    assert(bearing().distanceTo(initialBearing) < 1e-10, 'Earth retains its camera bearing');
    assert.equal(follow.controls, controls, 'Transport cannot replace active drag controls');
    const spacecraft = new Vector3().project(follow.camera);
    assert(Math.hypot(spacecraft.x, spacecraft.y) < 1e-10, 'Spacecraft stays centered');
  }
  const lockedPosition = follow.camera.position.clone();
  const lockedQuaternion = follow.camera.quaternion.clone();
  for (const pose of [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0.5, 0.5, 0.5, 0.5],
  ]) {
    follow.setPose(Object.freeze(pose), 0, 1, 0);
    follow.update(0);
    assert(follow.camera.position.distanceTo(lockedPosition) < 1e-12);
    assert(follow.camera.quaternion.angleTo(lockedQuaternion) < 1e-7);
  }
  follow.controls.rotateLeft(0.15);
  follow.controls.rotateUp(0.04);
  follow.update(0);
  const adjustedBearing = bearing();
  assert(adjustedBearing.distanceTo(initialBearing) > 0.01, 'Orbit still adjusts the locked shot');
  follow.controls.dollyOut(1.2);
  follow.update(0);
  const adjustedDistance = follow.camera.position.length();
  const dollyBearing = bearing();
  assert(Math.abs(adjustedDistance - initialDistance) > 0.05, 'Dolly remains available');
  const adjustedControls = follow.controls;
  for (const ecef of [
    [0, 0, radius],
    [radius * 1e-9, 0, radius],
    [0, 0, -radius],
    [radius, 0, 0],
  ]) {
    current = Object.freeze(ecef);
    follow.setPosition(current);
    follow.update(0);
    assert(
      bearing().distanceTo(dollyBearing) < 1e-8,
      'Pole/seek transport remains finite and stable',
    );
    assert(Math.abs(follow.camera.position.length() - adjustedDistance) < 1e-9);
    assert.equal(follow.controls, adjustedControls);
  }
  // Import an adjustment by the external Earth collision gate before the next transport.
  follow.camera.position.multiplyScalar(0.8);
  follow.camera.lookAt(0, 0, 0);
  const clippedDistance = follow.camera.position.length();
  const clippedBearing = bearing();
  current = position(0.1);
  follow.setPosition(current);
  follow.update(0);
  assert(Math.abs(follow.camera.position.length() - clippedDistance) < 1e-9);
  assert(bearing().distanceTo(clippedBearing) < 1e-9);
  const beforeUnlock = follow.camera.position.clone();
  const beforeUnlockQuaternion = follow.camera.quaternion.clone();
  follow.setEarthLock(false);
  follow.controls.enableDamping = false;
  assert(follow.camera.position.distanceTo(beforeUnlock) < 1e-10);
  assert(follow.camera.quaternion.angleTo(beforeUnlockQuaternion) < 1e-7);
  current = position(0.8);
  follow.setPosition(current);
  follow.update(0);
  assert(
    follow.camera.position.distanceTo(beforeUnlock) < 1e-10,
    'Unlocked orbit keeps its original frame',
  );
  assert(bearing().distanceTo(clippedBearing) > 0.1);
  follow.setEarthLock(true);
  follow.setSize(600, 900);
  assert.equal(follow.camera.aspect, 2 / 3);
  follow.resetView();
  follow.controls.enableDamping = false;
  const resetBearing = bearing();
  current = position(0.9);
  follow.setPosition(current);
  follow.update(0);
  assert(bearing().distanceTo(resetBearing) < 1e-9, 'Frame SC retains the Earth lock');
  assert.deepEqual(attitude, [Math.SQRT1_2, Math.SQRT1_2, 0, 0]);
  follow.dispose();

  const clippedFollow = new Follow({ domElement: new Canvas() });
  clippedFollow.setPosition(Object.freeze([radius, 0, 0]));
  clippedFollow.setEarthLock(true);
  clippedFollow.controls.enableDamping = false;
  clippedFollow.camera.position.set(-2e6, 1e6, 0);
  clippedFollow.camera.lookAt(0, 0, 0);
  const earth = Object.create(EarthScene.prototype);
  earth.follow = clippedFollow;
  earth.satellite = { position: new Vector3(radius / 6378137, 0, 0) };
  earth.clipFollowCamera();
  const actualClippedPosition = clippedFollow.camera.position.clone();
  const actualClippedQuaternion = clippedFollow.camera.quaternion.clone();
  assert(actualClippedPosition.length() < Math.hypot(2e6, 1e6));
  clippedFollow.update(0);
  assert(clippedFollow.camera.position.distanceTo(actualClippedPosition) < 1e-7);
  assert(clippedFollow.camera.quaternion.angleTo(actualClippedQuaternion) < 1e-7);
  clippedFollow.setEarthLock(false);
  assert(clippedFollow.camera.position.distanceTo(actualClippedPosition) < 1e-7);
  clippedFollow.setEarthLock(true);
  assert(clippedFollow.camera.position.distanceTo(actualClippedPosition) < 1e-7);
  clippedFollow.dispose();
  console.log(
    'Earth lock passed: real OrbitControls, full orbit/body slews, stable Earth bearing and spacecraft distance, drag/dolly, pole/seek transport, actual Earth collision, toggle/reset/resize and immutable inputs.',
  );
}
