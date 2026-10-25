import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof ASSET_DIR === 'undefined') {
  const { build } = await import('esbuild');
  const here = dirname(fileURLToPath(import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-earth-cloud-test-'));
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
  const { createHash } = await import('node:crypto');
  const { CloudTileLayer, cloudTileBudget, selectCloudTiles, readCloudTile } = await import(
    './CloudTiles.ts'
  );
  const {
    Texture,
    RedFormat,
    UnsignedByteType,
    NoColorSpace,
    LinearFilter,
    LinearMipmapLinearFilter,
    ClampToEdgeWrapping,
  } = await import('three');
  const manifest = JSON.parse(await readFile(ASSET_DIR + '/cloud-tiles.json'));
  assert.deepEqual(
    manifest,
    JSON.parse(await readFile(ASSET_DIR + '/../../src/earth/cloud-tiles.json')),
  );
  const {
    width,
    height,
    interior_pixels: interior,
    gutter_pixels: gutter,
    columns,
    rows,
  } = manifest.grid;
  assert.equal(manifest.tile_count, columns * rows);
  assert.equal(manifest.tile_count, manifest.tiles.length);
  assert.equal(manifest.published_nominal_resolution_m, 1000);
  assert.equal(manifest.angular_pixel_spacing_deg, 1 / 120);
  let total = 0;
  for (const tile of manifest.tiles) {
    const [x, y] = tile.id.split('-').map(Number);
    const box = [
      x * interior - gutter,
      y * interior - gutter,
      Math.min(width, (x + 1) * interior) + gutter,
      Math.min(height, (y + 1) * interior) + gutter,
    ];
    assert.deepEqual(tile.pixel_box, box);
    assert.deepEqual(tile.runtime_dimensions, [box[2] - box[0], box[3] - box[1]]);
    assert.ok(tile.runtime_dimensions.every((dimension) => dimension <= 2048));
    assert.deepEqual(tile.bounds_uv, [
      box[0] / width,
      1 - box[3] / height,
      box[2] / width,
      1 - box[1] / height,
    ]);
    const bytes = await readFile(ASSET_DIR + tile.url.replace('/earth', ''));
    assert.equal(bytes.length, tile.runtime_bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), tile.runtime_sha256);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    total += bytes.length;
  }
  assert.equal(total, manifest.runtime_total_bytes);
  assert.ok(total < 100_000_000);
  const capabilities = { maxTextureSize: 8192, maxTextures: 16, getMaxAnisotropy: () => 16 };
  assert.equal(cloudTileBudget(capabilities), 9);
  assert.equal(cloudTileBudget({ ...capabilities, maxTextureSize: 1024 }), 0);
  assert.equal(cloudTileBudget({ ...capabilities, maxTextures: 8 }), 4);
  const position = (latitude, longitude) => ({
    x: Math.cos((latitude * Math.PI) / 180) * Math.cos((longitude * Math.PI) / 180),
    y: Math.sin((latitude * Math.PI) / 180) * 0.99330562,
    z: -Math.cos((latitude * Math.PI) / 180) * Math.sin((longitude * Math.PI) / 180),
  });
  for (const latitude of [-90, -89, -45, 0, 37.4, 89, 90]) {
    for (const longitude of [-180, -179.999, -122.2, 0, 90, 179.999, 180]) {
      const selected = selectCloudTiles(position(latitude, longitude));
      assert.ok(selected.length >= 6 && selected.length <= 9);
      assert.equal(new Set(selected.map((tile) => tile.id)).size, selected.length);
      const core = selected[0].pixel_box;
      const u = ((((longitude + 180) % 360) + 360) % 360) / 360;
      const v = (90 - latitude) / 180;
      assert.ok(u * width >= core[0] + gutter - 1e-8 && u * width <= core[2] - gutter + 1e-8);
      assert.ok(v * height >= core[1] + gutter - 1e-8 && v * height <= core[3] - gutter + 1e-8);
    }
  }
  const atDateline = selectCloudTiles(position(0, 179.999)).map((tile) =>
    Number(tile.id.split('-')[0]),
  );
  assert.ok(atDateline.includes(0) && atDateline.includes(columns - 1));
  const stanford = position(37.4, -122.2),
    elsewhere = position(-20, 60);
  let active = 0,
    peak = 0,
    disposed = 0,
    failId = null;
  const requests = [];
  const diagnostics = {};
  let shown = [];
  const load = (asset, signal) =>
    new Promise((resolve, reject) => {
      active++;
      peak = Math.max(peak, active);
      let settled = false;
      const finish = (aborted = false) => {
        if (settled) return;
        settled = true;
        active--;
        if (aborted) return reject(new DOMException('Aborted', 'AbortError'));
        if (asset.id === failId) return reject(new Error('Deliberate independent failure'));
        const texture = new Texture();
        texture.addEventListener('dispose', () => disposed++);
        resolve(texture);
      };
      requests.push({ asset, signal, finish });
      signal.addEventListener('abort', () => finish(true));
    });
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      for (const request of requests) request.finish();
      await new Promise((resolve) => setImmediate(resolve));
      if (!active) break;
    }
  };
  const layer = new CloudTileLayer(9, (tiles) => (shown = tiles), diagnostics, load);
  layer.update(stanford, 1, 1000);
  assert.equal(requests.length, 0);
  layer.update(stanford, 1, 1251);
  assert.equal(active, 2);
  await drain();
  layer.update(stanford, 1, 1651);
  assert.equal(shown.length, 9);
  assert.equal(diagnostics.cloudTileState, 'ready');
  assert.ok(shown.every((tile) => tile.opacity === 1));
  assert.ok(shown.some((tile) => tile.featherEdges.every((edge) => edge === 0)));
  assert.ok(peak <= 2);
  assert.equal(Number(diagnostics.cloudTileResident), 9);
  // A completely different camera region evicts old masks before retaining new ones.
  failId = selectCloudTiles(elsewhere)[0].id;
  layer.update(elsewhere, 1, 2000);
  layer.update(elsewhere, 1, 2251);
  await drain();
  layer.update(elsewhere, 1, 2651);
  assert.equal(shown.length, 8);
  assert.equal(diagnostics.cloudTileState, 'partial');
  assert.match(diagnostics.cloudTileError, /independent failure/);
  assert.ok(Number(diagnostics.cloudTileResident) <= 9);
  assert.ok(disposed >= 8);
  failId = null;
  layer.update(elsewhere, 1, 32252);
  await drain();
  layer.update(elsewhere, 1, 32652);
  assert.equal(shown.length, 9);
  layer.update(elsewhere, 0, 33000);
  assert.equal(shown.length, 0);
  layer.update(elsewhere, 0, 48000);
  assert.equal(diagnostics.cloudTileResident, '0');
  // Cancellation and late decode completion cannot attach a no-longer-visible tile.
  layer.update(stanford, 1, 49000);
  layer.update(stanford, 1, 49251);
  assert.equal(active, 2);
  const pending = requests.slice(-2);
  layer.update(elsewhere, 1, 49300);
  assert.ok(pending.every((request) => request.signal.aborted));
  await drain();
  assert.equal(shown.length, 0);
  layer.dispose();
  assert.equal(active, 0);
  assert.equal(diagnostics.cloudTileState, 'disposed');
  // Dispose while a loader ignores cancellation; any eventual texture is released.
  let releaseLate,
    lateDisposed = false;
  const late = new CloudTileLayer(
    1,
    () => {},
    {},
    () => new Promise((resolve) => (releaseLate = resolve)),
  );
  late.update(stanford, 1, 1000);
  late.update(stanford, 1, 1300);
  late.dispose();
  const lateTexture = new Texture();
  lateTexture.addEventListener('dispose', () => (lateDisposed = true));
  releaseLate(lateTexture);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lateDisposed);
  // Validated bytes decode to a single-channel mask with the same orientation contract.
  const source = new Uint8Array([1, 2, 3]);
  const fixture = {
    ...manifest.tiles[0],
    runtime_bytes: 3,
    runtime_sha256: createHash('sha256').update(source).digest('hex'),
    runtime_dimensions: [2, 2],
  };
  globalThis.fetch = async () => new Response(source);
  let closed = 0,
    decodeOptions;
  globalThis.createImageBitmap = async (_blob, options) => {
    decodeOptions = options;
    return {
      width: 2,
      height: 2,
      close() {
        closed++;
      },
    };
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage() {},
        getImageData() {
          return {
            data: new Uint8ClampedArray([
              0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
            ]),
          };
        },
      };
    }
  };
  const texture = await readCloudTile(fixture, new AbortController().signal, 32);
  assert.equal(decodeOptions.imageOrientation, 'flipY');
  assert.equal(decodeOptions.colorSpaceConversion, 'none');
  assert.deepEqual([...texture.image.data], [0, 64, 128, 255]);
  assert.equal(texture.format, RedFormat);
  assert.equal(texture.type, UnsignedByteType);
  assert.equal(texture.colorSpace, NoColorSpace);
  assert.equal(texture.magFilter, LinearFilter);
  assert.equal(texture.minFilter, LinearMipmapLinearFilter);
  assert.equal(texture.wrapS, ClampToEdgeWrapping);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.flipY, false);
  assert.equal(texture.anisotropy, 16);
  assert.equal(closed, 1);
  texture.dispose();
  await assert.rejects(
    readCloudTile({ ...fixture, runtime_sha256: '0'.repeat(64) }, new AbortController().signal, 16),
    /hash mismatch/,
  );
  await assert.rejects(
    readCloudTile({ ...fixture, runtime_dimensions: [3, 3] }, new AbortController().signal, 16),
    /dimensions mismatch/,
  );
  assert.equal(closed, 2);
  console.log(
    `Native cloud checks passed: ${manifest.tile_count} byte identities, native grid/gutters, date/provenance, longitude wrap/poles, bounded nine-tile cache/two loads, eviction/cancellation/retry/disposal, validated R8 decode and mip/filter orientation.`,
  );
}
