import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof BUNDLED_ORBITAL_LIGHTING_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-orbital-lighting-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: { BUNDLED_ORBITAL_LIGHTING_TEST: 'true' },
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
  const {
    ACESFilmicToneMapping,
    SRGBColorSpace,
    HalfFloatType,
    UnsignedByteType,
    DirectionalLight,
    Group,
    Scene,
    Quaternion,
    Vector3,
  } = await import('three');
  const { EarthComposite, earthCompositeSize } = await import('./EarthComposite.ts');
  const { SpacecraftFollow, earthFillIntensity } = await import('./SpacecraftFollow.ts');
  for (const [width, height] of [
    [1, 1],
    [640, 480],
    [3840, 2160],
    [8000, 8000],
  ]) {
    const [w, h] = earthCompositeSize(width, height);
    assert.ok(w * h <= 4_000_000 && w >= 1 && h >= 1);
    assert.ok(w <= width && h <= height);
    assert.ok(Math.abs(w / h - width / height) < 0.002);
  }
  for (const hdr of [true, false]) {
    let target = null;
    const draws = [];
    const renderer = {
      extensions: { has: () => hdr },
      capabilities: { maxSamples: 4 },
      domElement: { dataset: {} },
      toneMapping: ACESFilmicToneMapping,
      toneMappingExposure: 1.08,
      outputColorSpace: SRGBColorSpace,
      getDrawingBufferSize: (size) => size.set(3840, 2160),
      getRenderTarget: () => target,
      setRenderTarget: (next) => {
        target = next;
      },
      render: (mesh) => draws.push({ target, material: mesh.material }),
    };
    const frame = new EarthComposite(renderer);
    frame.resize();
    assert.equal(frame.target.texture.type, hdr ? HalfFloatType : UnsignedByteType);
    assert.equal(frame.target.samples, 2);
    assert.ok(frame.target.width * frame.target.height <= 4_000_000);
    frame.render(() => assert.equal(target, frame.target));
    assert.equal(target, null);
    assert.equal(draws.length, 1);
    assert.equal(draws[0].target, null, 'Only the output pass writes to the canvas');
    assert.ok('ACES_FILMIC_TONE_MAPPING' in draws[0].material.defines);
    assert.ok('SRGB_TRANSFER' in draws[0].material.defines);
    assert.throws(
      () =>
        frame.render(() => {
          throw new Error('draw failed');
        }),
      /draw failed/,
    );
    assert.equal(target, null, 'Failed drawing restores the caller framebuffer');
    let targetDisposed = 0,
      outputDisposed = 0;
    frame.target.addEventListener('dispose', () => targetDisposed++);
    frame.output.material.addEventListener('dispose', () => outputDisposed++);
    frame.dispose();
    assert.equal(targetDisposed, 1);
    assert.equal(outputDisposed, 1);
  }
  assert.equal(earthFillIntensity(6928137, 1), 0.9);
  assert.ok(earthFillIntensity(6928137, -1) < 1e-15);
  assert.ok(Math.abs(earthFillIntensity(6928137, 0) - 0.9 / Math.PI) < 1e-15);
  assert.ok(earthFillIntensity(14e6, 1) < earthFillIntensity(7e6, 1));
  let previous = 0;
  for (let i = 0; i <= 2000; i++) {
    const value = earthFillIntensity(6928137, -1 + i / 1000);
    assert.ok(Number.isFinite(value) && value >= previous - 1e-14 && value <= 0.9);
    previous = value;
  }
  const follow = Object.create(SpacecraftFollow.prototype);
  Object.assign(follow, {
    scene: new Scene(),
    sun: new DirectionalLight(),
    sunDirection: new Vector3(1, 0, 0),
    radial: new Vector3(0, 1, 0),
    viewport: new Vector3(),
    earthRotation: new Quaternion(),
    orbitalRadiusM: 6928137,
    radius: 0.4,
    seededPosition: true,
    poseRoot: new Group(),
  });
  const position = [0, 0, 6928137];
  follow.setPosition(position);
  assert.deepEqual(position, [0, 0, 6928137]);
  const sourceAxis = new Vector3(0, 1, 0).applyEuler(follow.scene.environmentRotation);
  assert.ok(sourceAxis.distanceTo(follow.radial.clone().negate()) < 1e-14);
  follow.setSun([0, 1, 0], 0);
  assert.equal(follow.sun.intensity, 0, 'Returned eclipse extinguishes the directional Sun');
  const shadow = follow.sun.shadow;
  assert.ok(shadow.camera.near > 0 && shadow.camera.far > shadow.camera.near);
  assert.ok(shadow.camera.right >= follow.radius && shadow.camera.top >= follow.radius);
  assert.ok(shadow.camera.far - shadow.camera.near >= follow.radius * 2);
  shadow.needsUpdate = false;
  follow.setSun([0, 1, 0], 1);
  assert.equal(shadow.needsUpdate, false, 'Brightness-only updates reuse valid shadow geometry');
  assert.equal(follow.sun.intensity, 3.2);
  follow.setPose([Math.SQRT1_2, Math.SQRT1_2, 0, 0], 0, 0, 0);
  assert.equal(shadow.needsUpdate, true, 'Attitude changes invalidate the Sun shadow');
  shadow.dispose();

  // Exercise the actual constructor, event callback and disposal. Only the GPU
  // allocation and DOM-control boundaries are faked; unchanged replay inputs
  // must still replace the environment and invalidate the cached depth map.
  const generations = [];
  const listenerRemovals = [];
  const canvas = new EventTarget();
  const removeListener = canvas.removeEventListener.bind(canvas);
  canvas.removeEventListener = (...args) => {
    listenerRemovals.push(args);
    removeListener(...args);
  };
  class LifecycleFollow extends SpacecraftFollow {
    createEarthEnvironment() {
      const generation = { environmentDisposals: 0, pmremDisposals: 0 };
      generation.environment = {
        texture: {},
        dispose: () => generation.environmentDisposals++,
      };
      generation.pmrem = { dispose: () => generation.pmremDisposals++ };
      generations.push(generation);
      return generation;
    }
    makeControls(enabled) {
      return { enabled, target: new Vector3(), update() {}, dispose() {} };
    }
  }
  const restored = new LifecycleFollow({ domElement: canvas });
  restored.setPosition([0, 0, 6928137]);
  restored.setSun([0, 1, 0], 1);
  restored.setPose([1, 0, 0, 0], 0, 0, 0);
  const heldPose = restored.poseRoot.quaternion.clone();
  const heldSun = restored.sunDirection.clone();
  let shadowDisposals = 0;
  restored.sun.shadow.map = { dispose: () => shadowDisposals++ };
  restored.sun.shadow.mapPass = { dispose: () => shadowDisposals++ };
  restored.sun.shadow.needsUpdate = false;
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(generations.length, 2, 'Context restoration rebuilds the GPU environment');
  assert.equal(generations[0].environmentDisposals, 1);
  assert.equal(generations[0].pmremDisposals, 1);
  assert.equal(restored.scene.environment, generations[1].environment.texture);
  assert.equal(shadowDisposals, 2);
  assert.equal(restored.sun.shadow.map, null);
  assert.equal(restored.sun.shadow.mapPass, null);
  assert.equal(restored.sun.shadow.needsUpdate, true);
  assert.ok(restored.poseRoot.quaternion.equals(heldPose));
  assert.ok(restored.sunDirection.equals(heldSun));
  restored.root = new Group();
  restored.height = 1000;
  restored.camera.position.set(0, 0, 20e6);
  restored.update(0);
  assert.equal(restored.poseRoot.visible, false);
  restored.sun.shadow.needsUpdate = false;
  restored.camera.position.set(0, 0, 1);
  restored.update(0);
  assert.equal(restored.poseRoot.visible, true);
  assert.equal(restored.sun.shadow.needsUpdate, true, 'Paused far-to-near dolly refreshes shadows');
  restored.dispose();
  assert.equal(listenerRemovals.length, 1);
  assert.equal(listenerRemovals[0][0], 'webglcontextrestored');
  assert.equal(listenerRemovals[0][1], restored.contextRestored);
  assert.equal(generations[1].environmentDisposals, 1);
  assert.equal(generations[1].pmremDisposals, 1);
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  restored.dispose();
  assert.equal(generations.length, 2, 'Disposed followers cannot recreate GPU resources');
  assert.equal(generations[1].environmentDisposals, 1, 'Disposal is idempotent');
  console.log(
    'Orbital lighting checks passed: bounded linear frame, single display transform, failure/disposal cleanup, Earth-facing phase fill, returned eclipse, shadow extent/invalidation and paused context restoration. GPU appearance remains separately reviewed.',
  );
}
