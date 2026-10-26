import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof NIGHT_DETAIL_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-night-detail-test-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: {
        NIGHT_DETAIL_TEST: 'true',
        NIGHT_ASSET_DIR: JSON.stringify(
          join(dirname(fileURLToPath(import.meta.url)), '../../public/earth'),
        ),
      },
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
  const { createHash } = await import('node:crypto');
  const { Texture } = await import('three');
  const { NightDetailLayer, nightDetailWeight } = await import('./NightDetail.ts');
  const { cloudTileBudget } = await import('./CloudTiles.ts');
  const manifest = JSON.parse(await readFile(join(NIGHT_ASSET_DIR, 'night-detail.json'), 'utf8'));
  assert.deepEqual(
    manifest,
    JSON.parse(await readFile(join(NIGHT_ASSET_DIR, '../../src/earth/night-detail.json'), 'utf8')),
  );
  const bytes = await readFile(join(NIGHT_ASSET_DIR, manifest.file));
  assert.equal(bytes.length, manifest.runtime_bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.runtime_sha256);
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8L', 'Native derivative is lossless WebP');
  assert.equal(manifest.angular_pixel_spacing_deg, 1 / 240);
  assert.deepEqual(manifest.runtime_dimensions, [4096, 4096]);
  const day = JSON.parse(await readFile(join(NIGHT_ASSET_DIR, 'regional-lod.json'), 'utf8'));
  assert.deepEqual(manifest.bounds_deg, day.bounds_deg);
  assert.deepEqual(manifest.crop_pixel_box, day.crop_pixel_box);
  const [x0, y0, x1, y1] = manifest.crop_pixel_box;
  const step = manifest.angular_pixel_spacing_deg;
  assert.equal(-180 + x0 * step, manifest.bounds_deg.west);
  assert.equal(-180 + x1 * step, manifest.bounds_deg.east);
  assert.ok(Math.abs(90 - y0 * step - manifest.bounds_deg.north) < 1e-12);
  assert.ok(Math.abs(90 - y1 * step - manifest.bounds_deg.south) < 1e-12);
  assert.deepEqual([x1 - x0, y1 - y0], manifest.runtime_dimensions);
  assert.equal(manifest.retained_cpu_bytes, 4096 ** 2);
  assert.equal(
    manifest.gpu_bytes_with_mipmaps,
    Array.from({ length: 13 }, (_, i) => (4096 >> i) ** 2).reduce((a, b) => a + b, 0),
  );
  for (const samplers of [6, 8, 16, 32]) {
    const cap = { maxTextureSize: 4096, maxTextures: samplers };
    assert.ok(cloudTileBudget(cap, 6) + 6 <= samplers);
  }
  const position = (radius, lat = 37.4275, lon = -122.1697) => {
    const phi = (lat * Math.PI) / 180,
      lambda = (lon * Math.PI) / 180;
    return {
      x: radius * Math.cos(phi) * Math.cos(lambda),
      y: radius * Math.sin(phi),
      z: -radius * Math.cos(phi) * Math.sin(lambda),
    };
  };
  assert.equal(nightDetailWeight(position(1.1), manifest.bounds_deg), 1);
  assert.equal(nightDetailWeight(position(3), manifest.bounds_deg), 0);
  assert.equal(nightDetailWeight(position(1.1, -37, 58), manifest.bounds_deg), 0);
  assert.equal(nightDetailWeight({ x: 0, y: 0, z: 0 }, manifest.bounds_deg), 0);
  let previous = 1;
  for (let r = 1.025; r < 3; r += 0.005) {
    const weight = nightDetailWeight(position(r), manifest.bounds_deg);
    assert.ok(Number.isFinite(weight) && weight >= 0 && weight <= previous + 1e-12);
    previous = weight;
  }
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const trackedTexture = () => {
    const texture = new Texture();
    texture.releases = 0;
    texture.addEventListener('dispose', () => texture.releases++);
    return texture;
  };
  function fixture() {
    const requests = [],
      views = [],
      diagnostics = {};
    const layer = new NightDetailLayer(
      manifest,
      (view) => views.push(view),
      diagnostics,
      (asset, signal) =>
        new Promise((resolve, reject) => requests.push({ asset, signal, resolve, reject })),
    );
    return { layer, requests, views, diagnostics };
  }
  const active = fixture();
  active.layer.update(position(1.1), true, 0);
  active.layer.update(position(1.1), true, 249);
  assert.equal(active.requests.length, 0);
  active.layer.update(position(1.1), true, 250);
  assert.equal(active.requests.length, 1);
  assert.equal(active.diagnostics.nightDetailState, 'loading');
  const native = trackedTexture();
  active.requests[0].resolve(native);
  await settle();
  assert.equal(active.views.at(-1).opacity, 0, 'A completed async load starts transparent');
  active.layer.update(position(1.1), true, 450);
  assert.equal(active.views.at(-1).opacity, 0.5);
  active.layer.update(position(1.1), true, 650);
  assert.equal(active.views.at(-1).opacity, 1);
  active.layer.update(position(3), true, 700);
  assert.equal(active.views.at(-1).opacity, 0);
  active.layer.update(position(3), true, 15699);
  assert.equal(native.releases, 0);
  active.layer.update(position(3), true, 15700);
  assert.equal(native.releases, 1);
  assert.equal(active.diagnostics.nightDetailResident, '0');
  active.layer.dispose();
  assert.equal(native.releases, 1);
  assert.equal(active.diagnostics.nightDetailState, 'disposed');
  const cancelled = fixture();
  cancelled.layer.update(position(1.1), true, 0);
  cancelled.layer.update(position(1.1), true, 250);
  cancelled.layer.update(position(1.1), false, 251);
  assert.equal(cancelled.requests[0].signal.aborted, true);
  const late = trackedTexture();
  cancelled.requests[0].resolve(late);
  await settle();
  assert.equal(late.releases, 1);
  assert.equal(cancelled.diagnostics.nightDetailResident, '0');
  cancelled.layer.update(position(1.1), true, 300);
  cancelled.layer.update(position(1.1), true, 550);
  assert.equal(cancelled.requests.length, 2, 'Cancellation does not poison later requests');
  cancelled.layer.dispose();
  const afterDispose = trackedTexture();
  cancelled.requests[1].resolve(afterDispose);
  await settle();
  assert.equal(afterDispose.releases, 1);
  assert.equal(cancelled.diagnostics.nightDetailState, 'disposed');
  cancelled.layer.update(position(1.1), true, 1000);
  assert.equal(cancelled.requests.length, 2);
  const failed = fixture();
  failed.layer.update(position(1.1), true, 0);
  failed.layer.update(position(1.1), true, 250);
  failed.requests[0].reject(new Error('hash mismatch'));
  await settle();
  assert.equal(failed.diagnostics.nightDetailState, 'unavailable');
  assert.equal(failed.views.at(-1).opacity, 0);
  failed.layer.update(position(1.1), true, 30249);
  assert.equal(failed.requests.length, 1);
  failed.layer.update(position(1.1), true, 30250);
  assert.equal(failed.requests.length, 2);
  const recovered = trackedTexture();
  failed.requests[1].resolve(recovered);
  await settle();
  assert.equal(failed.diagnostics.nightDetailError, undefined);
  failed.layer.dispose();
  assert.equal(recovered.releases, 1);
  console.log(
    'Native night detail checks passed: asset identity/native georeferencing, lossless codec, sampler/memory bounds, visible-region/distance selection, lazy load/fade, cancellation, retry, eviction and disposal.',
  );
}
