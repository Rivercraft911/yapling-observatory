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
  const { ecefToDisplay, geodeticToEcef } = await import('./geodesy.ts');
  const { Vector3 } = await import('three');
  const bytes = await readFile(ASSET_DIR + '/earth-day-stanford-500m.jpg');
  const manifest = JSON.parse(await readFile(ASSET_DIR + '/regional-lod.json'));
  const cameras = {
    close: { position: new Vector3(...ecefToDisplay(geodeticToEcef(37.4275, -122.1697, 550000))) },
    far: {
      position: new Vector3(...ecefToDisplay(geodeticToEcef(37.4275, -122.1697, 550000))).setLength(
        4,
      ),
    },
    other: { position: new Vector3(1.086, 0, 0) },
  };
  let fetches = 0,
    decodes = 0,
    closed = 0;
  globalThis.document = { hidden: false };
  globalThis.fetch = async (url, { signal }) => {
    assert.equal(url, manifest.url);
    assert.ok(signal);
    fetches++;
    return new Response(bytes);
  };
  globalThis.createImageBitmap = async (blob, options) => {
    assert.equal(blob.size, bytes.length);
    assert.equal(options.imageOrientation, 'flipY');
    decodes++;
    return {
      width: 4096,
      height: 4096,
      close() {
        closed++;
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
      },
      host: { clientWidth: 1000, clientHeight: 600 },
      regionalTexture: null,
      regionalBitmap: null,
      regionalAbort: null,
      regionalFailed: false,
      regionalUnusedSince: 0,
      regionalNeededSince: 0,
      disposed: false,
    });
    const load = v.loadRegionalImagery.bind(v);
    v.loadRegionalImagery = () => (v.pending = load());
    return v;
  }
  let v = view();
  v.renderer.capabilities.maxTextureSize = 2048;
  v.updateRegionalImagery(cameras.close, 1000);
  v.updateRegionalImagery(cameras.close, 1400);
  assert.equal(fetches, 0);
  assert.equal(v.mix, 0);
  v = view();
  v.updateRegionalImagery(cameras.far, 1000);
  v.updateRegionalImagery(cameras.far, 1500);
  assert.equal(fetches, 0);
  assert.equal(v.mix, 0);
  v.updateRegionalImagery(cameras.other, 2000);
  v.updateRegionalImagery(cameras.other, 2500);
  assert.equal(fetches, 0);
  assert.equal(v.mix, 0);
  document.hidden = true;
  v.updateRegionalImagery(cameras.close, 3000);
  v.updateRegionalImagery(cameras.close, 3500);
  assert.equal(fetches, 0);
  document.hidden = false;
  v.updateRegionalImagery(cameras.close, 4000);
  v.updateRegionalImagery(cameras.close, 4300);
  await v.pending;
  assert.equal(fetches, 1);
  assert.equal(decodes, 1);
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'ready');
  v.updateRegionalImagery(cameras.close, 4400);
  assert.ok(v.mix > 0.999);
  assert.ok(v.map);
  const uv = [(-122.1697 + 180) / 360, (37.4275 + 90) / 180];
  const regionUv = [
    (uv[0] - v.bounds[0]) / (v.bounds[2] - v.bounds[0]),
    (uv[1] - v.bounds[1]) / (v.bounds[3] - v.bounds[1]),
  ];
  assert.ok(regionUv.every((x) => x > 0.45 && x < 0.55));
  v.updateRegionalImagery(cameras.far, 5000);
  assert.equal(v.mix, 0);
  v.updateRegionalImagery(cameras.far, 20001);
  assert.equal(v.regionalTexture, null);
  assert.equal(closed, 1);
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'global-only');
  // Full view teardown releases the regional GPU texture and decoded bitmap.
  v = view();
  await v.loadRegionalImagery();
  const noop = { dispose() {} };
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
  assert.equal(closed, 2);
  assert.equal(v.disposed, true);
  assert.equal(v.regionalTexture, null);
  // Bad identities retain the global map and never reach image decode.
  globalThis.fetch = async () => new Response(new Uint8Array(bytes.length));
  v = view();
  await v.loadRegionalImagery();
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'unavailable');
  assert.match(v.renderer.domElement.dataset.regionalImageryError, /hash mismatch/);
  assert.equal(v.regionalTexture, null);
  assert.equal(decodes, 2);
  // Leaving a close view aborts its in-flight local asset request.
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
    );
  v = view();
  v.updateRegionalImagery(cameras.close, 1000);
  v.updateRegionalImagery(cameras.close, 1400);
  v.updateRegionalImagery(cameras.other, 1500);
  await v.pending;
  assert.equal(v.regionalTexture, null);
  assert.equal(v.regionalFailed, false);
  assert.equal(v.renderer.domElement.dataset.regionalImageryState, 'global-only');
  console.log(
    'PASS: verified local texture load, ImageBitmap orientation, StanfordUV, GPU-limit/far/other-region/hidden fallback, delayed release, full disposal, hash failure, fetch cancellation.',
  );
}
