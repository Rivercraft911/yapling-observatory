import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof NIGHT_MAP_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-night-map-test-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: {
        NIGHT_MAP_TEST: 'true',
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
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(NIGHT_ASSET_DIR, 'night-map.json'), 'utf8'));
  assert.deepEqual(
    manifest,
    JSON.parse(await readFile(join(NIGHT_ASSET_DIR, '../../src/earth/night-map.json'), 'utf8')),
  );
  const assetBytes = await readFile(join(NIGHT_ASSET_DIR, manifest.file));
  assert.equal(manifest.url, `/earth/${manifest.file}`);
  assert.deepEqual(manifest.runtime_dimensions, [13500, 6750]);
  assert.deepEqual(manifest.runtime_dimensions, manifest.source_dimensions);
  assert.equal(assetBytes.length, manifest.runtime_bytes);
  assert.equal(manifest.runtime_bytes, manifest.source_bytes);
  assert.equal(createHash('sha256').update(assetBytes).digest('hex'), manifest.runtime_sha256);
  assert.equal(manifest.runtime_sha256, manifest.source_sha256);
  const { loadDetailedNightMap } = await import('./nightMap.ts');
  const {
    ClampToEdgeWrapping,
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    NoColorSpace,
    RedFormat,
    RepeatWrapping,
    UnsignedByteType,
  } = await import('three');

  const northPixel = (x, y) => (y * 7 + x * 31) % 251;
  function fixture(options = {}) {
    const width = options.width ?? 3;
    const height = options.height ?? 259;
    const bytes = new Uint8Array([255, 216, 1, 2, 3, 255, 217]);
    const asset = {
      url: '/earth/test-night.jpg',
      runtime_bytes: bytes.length,
      runtime_sha256: createHash('sha256').update(bytes).digest('hex'),
      runtime_dimensions: [width, height],
      runtime_mime: options.mime,
    };
    const state = { fetches: 0, decodes: 0, closed: 0, canvases: [], draws: [], reads: [] };
    const bitmap = {
      width: options.bitmapWidth ?? width,
      height: options.bitmapHeight ?? height,
      close() {
        state.closed++;
      },
    };
    globalThis.fetch = async (url, init) => {
      state.fetches++;
      assert.equal(url, asset.url);
      state.fetchSignal = init.signal;
      options.onFetch?.();
      return new Response(bytes, { status: options.status ?? 200 });
    };
    globalThis.createImageBitmap = async (blob, decodeOptions) => {
      state.decodes++;
      state.decodeOptions = decodeOptions;
      assert.equal(blob.type, options.mime || 'image/jpeg');
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
      if (options.decodeError) throw new Error('Independent decode failure');
      await options.onDecode?.();
      return bitmap;
    };
    globalThis.OffscreenCanvas = class {
      constructor(canvasWidth, canvasHeight) {
        this.width = canvasWidth;
        this.height = canvasHeight;
        state.canvases.push(this);
        assert.equal(canvasWidth, width);
        assert.ok(canvasHeight <= 128, 'Temporary RGBA canvas must stay within 128 rows');
      }
      getContext(kind, settings) {
        assert.equal(kind, '2d');
        assert.equal(settings.willReadFrequently, true);
        if (options.noContext) return null;
        let sourceRectangle;
        return {
          drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
            assert.equal(source, bitmap);
            assert.deepEqual([sx, sw, dx, dy, dw, dh], [0, width, 0, 0, width, sh]);
            assert.ok(sh <= 128 && sh <= height - sy, 'Crop must preserve native resolution');
            sourceRectangle = { y: sy, height: sh };
            state.draws.push(sourceRectangle);
          },
          getImageData(x, y, readWidth, readHeight) {
            assert.deepEqual([x, y, readWidth, readHeight], [0, 0, width, sourceRectangle.height]);
            state.reads.push(readHeight);
            if (options.readError) throw new Error('Independent readback failure');
            const data = new Uint8ClampedArray(readWidth * readHeight * 4);
            for (let row = 0; row < readHeight; row++) {
              const bitmapY = sourceRectangle.y + row;
              const sourceY =
                state.decodeOptions.imageOrientation === 'flipY' ? height - 1 - bitmapY : bitmapY;
              for (let column = 0; column < readWidth; column++) {
                const offset = 4 * (row * readWidth + column);
                data[offset] = northPixel(column, sourceY);
                data[offset + 1] = 255;
                data[offset + 2] = 123;
                data[offset + 3] = 255;
              }
            }
            options.onRead?.(state.reads.length);
            return { data };
          },
        };
      }
    };
    return { asset, state };
  }
  function assertReleased(state, expectedCanvases = 1) {
    assert.equal(state.closed, 1, 'Owned bitmap must close exactly once');
    assert.equal(state.canvases.length, expectedCanvases);
    for (const canvas of state.canvases) {
      assert.equal(canvas.width, 0);
      assert.equal(canvas.height, 0);
    }
  }

  // Tagged north-first source rows establish both hemisphere and strip-boundary orientation.
  const valid = fixture();
  const controller = new AbortController();
  const texture = await loadDetailedNightMap(valid.asset, 32, controller.signal);
  assert.equal(valid.state.fetchSignal, controller.signal);
  assert.deepEqual(valid.state.decodeOptions, {
    imageOrientation: 'flipY',
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  assert.ok(texture instanceof DataTexture);
  assert.deepEqual([texture.image.width, texture.image.height], [3, 259]);
  assert.equal(texture.image.data.byteLength, 3 * 259);
  for (const row of [0, 1, 127, 128, 255, 256, 258]) {
    for (const column of [0, 1, 2])
      assert.equal(texture.image.data[row * 3 + column], northPixel(column, 258 - row));
  }
  assert.deepEqual(valid.state.draws, [
    { y: 0, height: 128 },
    { y: 128, height: 128 },
    { y: 256, height: 3 },
  ]);
  assert.deepEqual(valid.state.reads, [128, 128, 3]);
  assert.equal(texture.format, RedFormat);
  assert.equal(texture.type, UnsignedByteType);
  assert.equal(texture.internalFormat, 'R8');
  assert.equal(texture.colorSpace, NoColorSpace);
  assert.equal(texture.flipY, false);
  assert.equal(texture.unpackAlignment, 1);
  assert.equal(texture.wrapS, RepeatWrapping);
  assert.equal(texture.wrapT, ClampToEdgeWrapping);
  assert.equal(texture.magFilter, LinearFilter);
  assert.equal(texture.minFilter, LinearMipmapLinearFilter);
  assert.equal(texture.generateMipmaps, true);
  assert.equal(texture.anisotropy, 16);
  assert.ok(texture.version > 0);
  assertReleased(valid.state);
  const retained = texture.image.data;
  texture.onUpdate?.(texture);
  assert.equal(texture.image.data, retained, 'Context restoration retains the CPU texels');
  let disposed = 0;
  texture.addEventListener('dispose', () => disposed++);
  texture.dispose();
  assert.equal(disposed, 1, 'Caller owns the returned texture lifetime');

  const webp = fixture({ width: 2, height: 2, mime: 'image/webp' });
  const { readNightDetail } = await import('./NightDetail.ts');
  const webpTexture = await readNightDetail(webp.asset, new AbortController().signal, 16);
  assert.equal(webpTexture.wrapS, ClampToEdgeWrapping);
  assertReleased(webp.state);
  webpTexture.dispose();

  for (const cap of [4, 0, NaN]) {
    const small = fixture({ width: 2, height: 2 });
    const result = await loadDetailedNightMap(small.asset, cap);
    assert.equal(result.anisotropy, Number.isFinite(cap) ? Math.max(1, cap) : 1);
    assertReleased(small.state);
    result.dispose();
  }

  for (const failure of ['http', 'size', 'hash']) {
    const invalid = fixture({ status: failure === 'http' ? 503 : 200 });
    if (failure === 'size') invalid.asset.runtime_bytes++;
    if (failure === 'hash') invalid.asset.runtime_sha256 = '0'.repeat(64);
    await assert.rejects(
      loadDetailedNightMap(invalid.asset, 16),
      failure === 'http' ? /HTTP 503/ : new RegExp(`${failure} mismatch`),
    );
    assert.equal(invalid.state.decodes, 0);
    assert.equal(invalid.state.canvases.length, 0);
  }

  for (const dimensions of [
    [2, 2, 1],
    [0, 2],
    [2.5, 2],
  ]) {
    const invalid = fixture({ width: 2, height: 2 });
    invalid.asset.runtime_dimensions = dimensions;
    await assert.rejects(loadDetailedNightMap(invalid.asset, 16), /dimensions mismatch/);
    assert.equal(invalid.state.fetches, 0);
  }
  const wrongDimensions = fixture({ bitmapWidth: 4 });
  await assert.rejects(loadDetailedNightMap(wrongDimensions.asset, 16), /dimensions mismatch/);
  assertReleased(wrongDimensions.state, 0);

  const beforeFetch = fixture();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(loadDetailedNightMap(beforeFetch.asset, 16, alreadyAborted.signal), {
    name: 'AbortError',
  });
  assert.equal(beforeFetch.state.fetches, 0);
  const fetching = new AbortController();
  const afterFetch = fixture({ onFetch: () => fetching.abort() });
  await assert.rejects(loadDetailedNightMap(afterFetch.asset, 16, fetching.signal), {
    name: 'AbortError',
  });
  assert.equal(afterFetch.state.decodes, 0);

  let releaseDecode, startedDecode;
  const decoding = new Promise((resolve) => (startedDecode = resolve));
  const release = new Promise((resolve) => (releaseDecode = resolve));
  const abortDecode = new AbortController();
  const pending = fixture({
    onDecode: () => {
      startedDecode();
      return release;
    },
  });
  const loading = loadDetailedNightMap(pending.asset, 16, abortDecode.signal);
  await decoding;
  abortDecode.abort();
  releaseDecode();
  await assert.rejects(loading, { name: 'AbortError' });
  assertReleased(pending.state, 0);

  const reading = new AbortController();
  const interrupted = fixture({ onRead: () => setTimeout(() => reading.abort(), 0) });
  await assert.rejects(loadDetailedNightMap(interrupted.asset, 16, reading.signal), {
    name: 'AbortError',
  });
  assert.equal(interrupted.state.reads.length, 1, 'Strip readbacks yield to browser cancellation');
  assertReleased(interrupted.state);

  for (const options of [{ noContext: true }, { readError: true }]) {
    const failed = fixture(options);
    await assert.rejects(
      loadDetailedNightMap(failed.asset, 16),
      /decode unavailable|readback failure/,
    );
    assertReleased(failed.state);
  }
  const decodeFailure = fixture({ decodeError: true });
  await assert.rejects(loadDetailedNightMap(decodeFailure.asset, 16), /decode failure/);
  assert.equal(decodeFailure.state.closed, 0);
  assert.equal(decodeFailure.state.canvases.length, 0);
  console.log(
    'Night-map checks passed: validated bytes/dimensions, south-first R8 native strips, bounded RGBA readbacks, mip/filter/wrap state, retained CPU texels, cancellation and temporary-resource cleanup.',
  );
}
