import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three';

interface NightMapAsset {
  url: string;
  runtime_bytes: number;
  runtime_sha256: string;
  runtime_dimensions: number[];
}

export async function loadDetailedNightMap(
  asset: NightMapAsset,
  maxAnisotropy: number,
  signal?: AbortSignal,
): Promise<DataTexture> {
  signal?.throwIfAborted();
  if (
    asset.runtime_dimensions.length !== 2 ||
    asset.runtime_dimensions.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)
  )
    throw new Error('Night map dimensions mismatch');
  const [width, height] = asset.runtime_dimensions;
  const response = await fetch(asset.url, { signal });
  if (!response.ok) throw new Error(`Night map HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  signal?.throwIfAborted();
  if (bytes.byteLength !== asset.runtime_bytes) throw new Error('Night map size mismatch');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  signal?.throwIfAborted();
  if (digest !== asset.runtime_sha256) throw new Error('Night map hash mismatch');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
    imageOrientation: 'flipY',
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  let canvas: OffscreenCanvas | undefined;
  try {
    signal?.throwIfAborted();
    if (bitmap.width !== width || bitmap.height !== height)
      throw new Error('Night map dimensions mismatch');
    const stripHeight = Math.min(128, height);
    canvas = new OffscreenCanvas(width, stripHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Night map decode unavailable');
    const grayscale = new Uint8Array(width * height);
    for (let y = 0; y < height; y += stripHeight) {
      signal?.throwIfAborted();
      const rows = Math.min(stripHeight, height - y);
      context.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);
      const rgba = context.getImageData(0, 0, width, rows).data;
      const offset = y * width;
      for (let i = 0; i < width * rows; i++) grayscale[offset + i] = rgba[i * 4];
      // Let camera input and cancellation run between bounded readbacks.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    const texture = new DataTexture(grayscale, width, height, RedFormat, UnsignedByteType);
    texture.internalFormat = 'R8';
    texture.colorSpace = NoColorSpace;
    // The decoded first row is south, matching v=0 in the Earth surface shader.
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Number.isFinite(maxAnisotropy)
      ? Math.min(16, Math.max(1, maxAnisotropy))
      : 1;
    texture.needsUpdate = true;
    return texture;
  } finally {
    try {
      bitmap.close();
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }
}
