import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PerspectiveCamera, Vector3 } from 'three';

const source = await readFile(new URL('./SunDisplay.ts', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
compiled = compiled.replace(/from ['"]three['"]/g, `from '${import.meta.resolve('three')}'`);
compiled = compiled.replace(
  /from ['"]\.\/geodesy['"]/g,
  `from '${new URL('./geodesy.ts', import.meta.url).href}'`,
);
const { SunDisplay, projectSunCue, sunBehindEarth, SUN_DISPLAY_DIAMETER_DEG } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const near = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

const camera = new PerspectiveCamera(34, 1.5, 0.2, 4);
camera.position.set(0, 0, 3);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const forward = new Vector3(0, 0, -1);
const front = projectSunCue(camera, forward, 900, 600);
assert.equal(front.onScreen, true);
assert.equal(front.behindCamera, false);
assert.equal(front.behindEarth, true);
near(front.x, 450);
near(front.y, 319);

// An ellipsoid, including the polar flattening, occludes the camera's ray only.
assert.equal(sunBehindEarth(new Vector3(0, 0, 3), forward), true);
assert.equal(sunBehindEarth(new Vector3(0, 0, 3), forward.clone().negate()), false);
assert.equal(sunBehindEarth(new Vector3(1.01, 0, 3), forward), false);
assert.equal(sunBehindEarth(new Vector3(0, 0.998, 3), forward), false);
assert.equal(sunBehindEarth(new Vector3(0, 0.995, 3), forward), true);
assert.equal(sunBehindEarth(new Vector3(0, 0, 3), new Vector3()), false);
assert.equal(sunBehindEarth(new Vector3(0, 0, 1.00001), forward), true);

// A Sun behind the view must retain left/right sense instead of mirrored projection.
for (const z of [-0.1, 0, 0.1, 1]) {
  const right = projectSunCue(camera, new Vector3(1, 0, z).normalize(), 900, 600);
  const left = projectSunCue(camera, new Vector3(-1, 0, z).normalize(), 900, 600);
  assert.equal(right.onScreen, false);
  assert.ok(right.x > 450 && left.x < 450);
  near(right.x, 822);
  near(left.x, 78);
  assert.equal(right.behindCamera, z >= 0);
}
const rear = projectSunCue(camera, new Vector3(0, 0, 1), 900, 600);
assert.equal(rear.behindCamera, true);
near(rear.x, 822);
near(rear.bearingDeg, 0);
const up = projectSunCue(camera, new Vector3(0, 1, 0), 900, 600);
near(up.y, 80);
near(up.bearingDeg, -90);

// Direction/camera rotations preserve screen coordinates; translations do not move the Sun.
const direction = new Vector3(0.1, 0.05, -1).normalize();
const before = projectSunCue(camera, direction, 900, 600);
const rotated = camera.clone();
rotated.rotateY(0.9);
rotated.updateMatrixWorld();
const after = projectSunCue(
  rotated,
  direction.clone().applyQuaternion(rotated.quaternion),
  900,
  600,
);
near(after.x, before.x);
near(after.y, before.y);
rotated.position.set(1.086, 0, 0);
const translated = projectSunCue(
  rotated,
  direction.clone().applyQuaternion(rotated.quaternion),
  900,
  600,
);
near(translated.x, before.x);
near(translated.y, before.y);
for (const [width, height] of [
  [1, 1],
  [200, 160],
  [300, 900],
  [1800, 300],
]) {
  for (const vector of [forward, new Vector3(1, 1, 1), new Vector3(0, -1, 0)]) {
    const cue = projectSunCue(camera, vector, width, height);
    assert.ok(Number.isFinite(cue.x + cue.y + cue.bearingDeg));
    assert.ok(cue.x >= 0 && cue.x <= Math.max(2, width));
    assert.ok(cue.y >= 0 && cue.y <= Math.max(2, height));
  }
}

const detail = { textContent: '' };
const cue = {
  hidden: true,
  dataset: {},
  style: {
    setProperty(name, value) {
      this[name] = value;
    },
  },
  querySelector() {
    return detail;
  },
};
const sun = new SunDisplay(cue);
const input = [0, 0, -3];
sun.setDirection(input);
sun.updateCue(camera, 900, 600);
assert.deepEqual(input, [0, 0, -3]);
assert.equal(cue.hidden, false);
assert.equal(cue.dataset.occluded, 'true');
assert.equal(detail.textContent, 'behind Earth');
sun.setDirection([0, 0, 1]);
sun.updateCue(camera, 900, 600);
assert.equal(cue.dataset.behindView, 'true');
assert.equal(cue.dataset.edge, 'true');
assert.equal(detail.textContent, 'behind view');

const renders = [];
const renderer = {
  autoClear: true,
  render(scene, skyCamera) {
    renders.push({ scene, camera: skyCamera.clone() });
  },
};
const cameraBefore = camera.toJSON();
sun.setDirection([0, 0, -1]);
sun.renderBackground(renderer, camera);
assert.deepEqual(camera.toJSON(), cameraBefore);
assert.equal(renderer.autoClear, true);
const sky = renders[0];
assert.equal(sky.scene.background.getHexString(), '060709');
assert.equal(sky.scene.children.length, 1);
assert.deepEqual(sky.camera.position.toArray(), [0, 0, 0]);
assert.equal(sky.camera.near, 0.1);
assert.equal(sky.camera.far, 2);
assert.equal(sky.camera.fov, camera.fov);
assert.equal(sky.camera.aspect, camera.aspect);
assert.deepEqual(sky.camera.quaternion.toArray(), camera.quaternion.toArray());
const disk = sky.scene.children[0];
assert.equal(disk.material.depthTest, false);
assert.equal(disk.material.depthWrite, false);
near((Math.atan(disk.scale.x / 7) * 2 * 180) / Math.PI, SUN_DISPLAY_DIAMETER_DEG);
assert.ok(SUN_DISPLAY_DIAMETER_DEG > 0.53 && SUN_DISPLAY_DIAMETER_DEG < 0.54);

// Globe and metre-scale follow cameras retain exactly the same apparent solar disk.
for (const distance of [0.065, 2, 550000, 50000000]) {
  const local = camera.clone();
  local.position.set(0, 0, distance);
  local.near = distance * 0.5;
  local.far = distance * 1.5;
  sun.renderBackground(renderer, local);
  const last = renders.at(-1).camera;
  assert.deepEqual(last.projectionMatrix.elements, sky.camera.projectionMatrix.elements);
  assert.equal(local.near, distance * 0.5);
  assert.equal(local.far, distance * 1.5);
}
for (const bad of [[], [0, 0, 0], [NaN, 0, 1], [1, 0]]) {
  sun.setDirection(bad);
  sun.updateCue(camera, 900, 600);
  assert.equal(cue.hidden, true);
  assert.equal(disk.visible, false);
}
sun.setDirection([0, 0, -1]);
sun.updateCue(camera, 0, 600);
assert.equal(cue.hidden, true);
sun.clear();
assert.equal(disk.visible, false);
sun.dispose();

const earthSource = await readFile(new URL('./EarthScene.ts', import.meta.url), 'utf8');
assert.match(
  earthSource,
  /this\.appearance\?\.setSun\(sun\);[\s\S]*this\.follow\.setSun\(sun, sunVisibility\);\s*this\.sunDisplay\.setDirection\(sun\);/,
);
assert.doesNotMatch(earthSource, /this\.scene\.background\s*=/);
assert.ok(
  earthSource.indexOf('this.sunDisplay.renderBackground(') <
    earthSource.indexOf('this.renderer.render(this.scene, activeCamera)'),
);
assert.ok(
  earthSource.indexOf('this.renderer.render(this.scene, activeCamera)') <
    earthSource.indexOf('this.follow.render()'),
);
assert.match(
  earthSource,
  /this\.sunDisplay\.renderBackground\([^;]+;\s*this\.renderer\.autoClear = false;/,
);
assert.match(earthSource, /finally \{\s*this\.renderer\.autoClear = autoClear;/);
console.log(
  'Sun display checks passed: reference angular size, shared interpolated direction, screen/behind-camera cues, WGS84 camera occultation, immutable cameras/inputs, sky depth isolation, background/Earth/spacecraft pass ordering and unavailable-state cleanup. GPU appearance remains a browser QA check.',
);
