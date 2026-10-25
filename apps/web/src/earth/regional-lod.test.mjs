import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof ASSET_DIR === 'undefined') {
  const { build } = await import('esbuild');
  const here = dirname(fileURLToPath(import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-earth-regional-test-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: { ASSET_DIR: JSON.stringify(resolve(here, '../../public/earth')) },
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
  const { readFile } = await import('node:fs/promises');
  const { EarthScene } = await import('./EarthScene.ts');
  const { createEarthAppearance } = await import('./atmosphereAdapter.ts');
  const { ecefToDisplay, geodeticToEcef } = await import('./geodesy.ts');
  const { Vector3, Texture, NoColorSpace, SRGBColorSpace } = await import('three');
  const metadata = {};
  const bytes = {};
  for (const [kind, file] of [
    ['day', 'regional-lod.json'],
    ['cloud', 'regional-cloud.json'],
  ]) {
    metadata[kind] = JSON.parse(await readFile(ASSET_DIR + '/../../src/earth/' + file));
    assert.deepEqual(metadata[kind], JSON.parse(await readFile(ASSET_DIR + '/' + file)));
    bytes[kind] = await readFile(ASSET_DIR + '/' + metadata[kind].file);
  }
  assert.deepEqual(metadata.day.bounds_deg, metadata.cloud.bounds_deg);
  const camera = {
    close: { position: new Vector3(...ecefToDisplay(geodeticToEcef(37.4275, -122.1697, 550000))) },
    far: {
      position: new Vector3(...ecefToDisplay(geodeticToEcef(37.4275, -122.1697, 550000))).setLength(
        4,
      ),
    },
    other: { position: new Vector3(1.086, 0, 0) },
  };
  const fetched = { day: 0, cloud: 0 },
    decoded = { day: 0, cloud: 0 },
    closed = { day: 0, cloud: 0 };
  let failKind = null;
  globalThis.document = { hidden: false };
  const normalFetch = async (url, { signal }) => {
    const kind = url === metadata.day.url ? 'day' : url === metadata.cloud.url ? 'cloud' : null;
    assert.ok(kind);
    assert.ok(signal);
    fetched[kind]++;
    return new Response(failKind === kind ? new Uint8Array(bytes[kind].length) : bytes[kind]);
  };
  globalThis.fetch = normalFetch;
  globalThis.createImageBitmap = async (blob, options) => {
    const kind = blob.type === 'image/png' ? 'cloud' : 'day';
    assert.equal(blob.size, bytes[kind].length);
    assert.equal(options.imageOrientation, 'flipY');
    assert.equal(options.colorSpaceConversion, 'none');
    decoded[kind]++;
    const [width, height] = metadata[kind].runtime_dimensions;
    return {
      width,
      height,
      close() {
        closed[kind]++;
      },
    };
  };
  function view() {
    const v = Object.create(EarthScene.prototype);
    Object.assign(v, {
      renderer: {
        capabilities: { maxTextureSize: 8192, getMaxAnisotropy: () => 16 },
        domElement: { dataset: {} },
      },
      appearance: {
        setRegionalMap(texture, bounds) {
          v.map = texture;
          v.bounds = bounds;
        },
        setRegionalOpacity(value) {
          v.mix = value;
        },
        setRegionalCloudMap(texture, bounds) {
          v.cloudMap = texture;
          v.cloudBounds = bounds;
        },
        setRegionalCloudOpacity(value) {
          v.cloudMix = value;
        },
      },
      host: { clientWidth: 1000, clientHeight: 600 },
      regionalTexture: null,
      regionalBitmap: null,
      regionalAbort: null,
      regionalFailed: false,
      regionalUnusedSince: 0,
      regionalNeededSince: 0,
      regionalCloudTexture: null,
      regionalCloudBitmap: null,
      regionalCloudAbort: null,
      regionalCloudFailed: false,
      regionalCloudUnusedSince: 0,
      regionalCloudNeededSince: 0,
      disposed: false,
    });
    const day = v.loadRegionalImagery.bind(v),
      cloud = v.loadRegionalClouds.bind(v);
    v.loadRegionalImagery = () => (v.dayPending = day());
    v.loadRegionalClouds = () => (v.cloudPending = cloud());
    return v;
  }
  const settle = async (v) => Promise.all([v.dayPending, v.cloudPending].filter(Boolean));
  let v = view();
  v.renderer.capabilities.maxTextureSize = 1024;
  v.updateRegionalImagery(camera.close, 1000);
  v.updateRegionalImagery(camera.close, 1400);
  assert.deepEqual(fetched, { day: 0, cloud: 0 });
  assert.equal(v.mix, 0);
  assert.equal(v.cloudMix, 0);
  v = view();
  v.updateRegionalImagery(camera.far, 1000);
  v.updateRegionalImagery(camera.far, 1500);
  v.updateRegionalImagery(camera.other, 2000);
  v.updateRegionalImagery(camera.other, 2500);
  document.hidden = true;
  v.updateRegionalImagery(camera.close, 3000);
  v.updateRegionalImagery(camera.close, 3500);
  assert.deepEqual(fetched, { day: 0, cloud: 0 });
  document.hidden = false;
  v.updateRegionalImagery(camera.close, 4000);
  v.updateRegionalImagery(camera.close, 4300);
  await settle(v);
  assert.deepEqual(fetched, { day: 1, cloud: 1 });
  assert.deepEqual(decoded, { day: 1, cloud: 1 });
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'ready');
  assert.equal(v.renderer.domElement.dataset.regionalCloudState, 'ready');
  assert.equal(v.regionalTexture.colorSpace, SRGBColorSpace);
  assert.equal(v.regionalCloudTexture.colorSpace, NoColorSpace);
  v.updateRegionalImagery(camera.close, 4400);
  assert.ok(v.mix > 0.999 && v.cloudMix > 0.999);
  assert.deepEqual(v.bounds, v.cloudBounds);
  const uv = [(-122.1697 + 180) / 360, (37.4275 + 90) / 180];
  const regionUv = [
    (uv[0] - v.bounds[0]) / (v.bounds[2] - v.bounds[0]),
    (uv[1] - v.bounds[1]) / (v.bounds[3] - v.bounds[1]),
  ];
  assert.ok(regionUv.every((value) => value > 0.45 && value < 0.55));
  v.updateRegionalImagery(camera.far, 5000);
  assert.equal(v.mix, 0);
  assert.equal(v.cloudMix, 0);
  v.updateRegionalImagery(camera.far, 20001);
  assert.equal(v.regionalTexture, null);
  assert.equal(v.regionalCloudTexture, null);
  assert.deepEqual(closed, { day: 1, cloud: 1 });
  // A2048px-capable GPU can use the mask without pretending the4096px day patch loaded.
  v = view();
  v.renderer.capabilities.maxTextureSize = 2048;
  v.updateRegionalImagery(camera.close, 1000);
  v.updateRegionalImagery(camera.close, 1400);
  await settle(v);
  assert.equal(v.regionalTexture, null);
  assert.ok(v.regionalCloudTexture);
  v.releaseRegionalClouds();
  // Failure of either source is independent of the other layer.
  for (const broken of ['day', 'cloud']) {
    failKind = broken;
    v = view();
    await Promise.all([v.loadRegionalImagery(), v.loadRegionalClouds()]);
    assert.equal(v[broken === 'day' ? 'regionalTexture' : 'regionalCloudTexture'], null);
    assert.ok(v[broken === 'day' ? 'regionalCloudTexture' : 'regionalTexture']);
    assert.match(
      v.renderer.domElement.dataset[
        broken === 'day' ? 'regionalImageryError' : 'regionalCloudError'
      ],
      /hash mismatch/,
    );
    v.releaseRegionalImagery();
    v.releaseRegionalClouds();
  }
  failKind = null;
  // Both in-flight requests abort when the close visible region is left.
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
    );
  v = view();
  v.updateRegionalImagery(camera.close, 1000);
  v.updateRegionalImagery(camera.close, 1400);
  v.updateRegionalImagery(camera.other, 1500);
  await settle(v);
  assert.equal(v.regionalFailed, false);
  assert.equal(v.regionalCloudFailed, false);
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'global-only');
  assert.equal(v.renderer.domElement.dataset.regionalCloudState, 'global-only');
  // Complete view disposal releases both GPU handles and decoded images.
  globalThis.fetch = normalFetch;
  v = view();
  await Promise.all([v.loadRegionalImagery(), v.loadRegionalClouds()]);
  const previous = { ...closed },
    noop = { dispose() {} };
  globalThis.cancelAnimationFrame = () => {};
  Object.assign(v, {
    observer: { disconnect() {} },
    controls: noop,
    follow: noop,
    followLink: noop,
    clearHistory() {},
    earthMeshes: [],
    textures: [],
    satelliteGeometry: noop,
    stationGeometry: noop,
    losGeometry: noop,
    satelliteMaterial: noop,
    stationMaterial: noop,
    losSolidMaterial: noop,
    losDashedMaterial: noop,
  });
  v.appearance.dispose = () => {};
  v.renderer.dispose = () => {};
  v.renderer.domElement.remove = () => {};
  v.dispose();
  assert.equal(closed.day, previous.day + 1);
  assert.equal(closed.cloud, previous.cloud + 1);
  assert.equal(v.regionalTexture, null);
  assert.equal(v.regionalCloudTexture, null);
  // Visible alpha and surface shadow share the exact same texture/bounds/weight objects.
  const day = new Texture(),
    globalCloud = new Texture(),
    ocean = new Texture(),
    regionalCloud = new Texture();
  const appearance = createEarthAppearance(day, globalCloud, ocean);
  for (const name of [
    'cloudMap',
    'regionalCloudMap',
    'regionalCloudBounds',
    'regionalCloudOpacity',
  ])
    assert.equal(appearance.surface.uniforms[name], appearance.clouds.uniforms[name]);
  appearance.setRegionalCloudMap(regionalCloud, [0.1, 0.2, 0.3, 0.4]);
  appearance.setRegionalCloudOpacity(0.7);
  assert.equal(appearance.surface.uniforms.regionalCloudMap.value, regionalCloud);
  assert.equal(appearance.clouds.uniforms.regionalCloudOpacity.value, 0.7);
  appearance.setRegionalCloudMap(null);
  assert.equal(appearance.surface.uniforms.regionalCloudMap.value, globalCloud);
  assert.equal(appearance.clouds.uniforms.regionalCloudOpacity.value, 0);
  appearance.dispose();
  for (const texture of [day, globalCloud, ocean, regionalCloud]) texture.dispose();
  console.log(
    'Regional imagery checks passed: native day/cloud hashes and orientation, matching Stanford bounds, independent GPU/load/error/cancel/release lifecycle, shared cloud-alpha/shadow source, unchanged global fallback.',
  );
}
