import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';
import cloudImagery from './cloud-tiles.json';

export interface CloudTileAsset {
  id: string;
  url: string;
  runtime_bytes: number;
  runtime_sha256: string;
  runtime_dimensions: number[];
  pixel_box: number[];
  bounds_uv: number[];
}
export interface CloudTileView {
  texture: Texture;
  bounds: readonly number[];
  opacity: number;
  featherEdges: readonly number[];
}
interface ResidentTile {
  asset: CloudTileAsset;
  texture: Texture;
  opacity: number;
  lastUsed: number;
}
interface CloudCapabilities {
  maxTextureSize: number;
  maxTextures: number;
  getMaxAnisotropy: () => number;
}
const assets = cloudImagery.tiles as CloudTileAsset[];
const byId = new Map(assets.map((asset) => [asset.id, asset]));
const { width, height, interior_pixels: interior, columns, rows } = cloudImagery.grid;
export const CLOUD_TILE_LIMIT = 9;
export function cloudCoverageByte(code: number) {
  const t = Math.min(1, Math.max(0, code / cloudImagery.display_transfer.toe_code));
  return Math.floor(code * t * t * (3 - 2 * t) + 0.5);
}
const coverageCodes = Uint8Array.from({ length: 256 }, (_, code) => cloudCoverageByte(code));
export function cloudTileBudget(capabilities: CloudCapabilities, reservedSamplers = 5) {
  // Reserve every surface sampler even while its detail opacity is zero.
  return capabilities.maxTextureSize >= 2048
    ? Math.max(0, Math.min(CLOUD_TILE_LIMIT, capabilities.maxTextures - reservedSamplers))
    : 0;
}
export function selectCloudTiles(position: { x: number; y: number; z: number }) {
  const longitude = Math.atan2(-position.z, position.x);
  const latitude = Math.atan2(position.y / 0.99330562, Math.hypot(position.x, position.z));
  const u = (((longitude / (2 * Math.PI) + 1.5) % 1) + 1) % 1;
  const x = Math.min(columns - 1, Math.floor((u * width) / interior));
  const y = Math.min(
    rows - 1,
    Math.max(0, Math.floor(((0.5 - latitude / Math.PI) * height) / interior)),
  );
  const selected: { asset: CloudTileAsset; distance: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    if (y + dy < 0 || y + dy >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const column = (x + dx + columns) % columns;
      const asset = byId.get(`${column}-${y + dy}`);
      if (asset) selected.push({ asset, distance: dx * dx + dy * dy });
    }
  }
  return selected.sort((a, b) => a.distance - b.distance).map(({ asset }) => asset);
}
export async function readCloudTile(
  asset: CloudTileAsset,
  signal: AbortSignal,
  anisotropy: number,
) {
  const response = await fetch(asset.url, { signal });
  if (!response.ok) throw new Error(`Cloud tile HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== asset.runtime_bytes) throw new Error('Cloud tile size mismatch');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== asset.runtime_sha256) throw new Error('Cloud tile hash mismatch');
  signal.throwIfAborted();
  // WebGL ImageBitmap uploads are RGBA. Extract the observed grayscale channel
  // once so each retained native tile uses one byte per texel, including mips.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), {
    imageOrientation: 'flipY',
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    signal.throwIfAborted();
    const [tileWidth, tileHeight] = asset.runtime_dimensions;
    if (bitmap.width !== tileWidth || bitmap.height !== tileHeight)
      throw new Error('Cloud tile dimensions mismatch');
    const canvas = new OffscreenCanvas(tileWidth, tileHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Cloud tile decode unavailable');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, tileWidth, tileHeight).data;
    const mask = new Uint8Array(tileWidth * tileHeight);
    // The image is display artwork, not linear fractional cloud coverage.
    // Remap native texels before mip filtering so sparse bright wisps retain their area average.
    for (let i = 0; i < mask.length; i++) mask[i] = coverageCodes[rgba[i * 4]];
    signal.throwIfAborted();
    const texture = new DataTexture(mask, tileWidth, tileHeight, RedFormat, UnsignedByteType);
    texture.colorSpace = NoColorSpace;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(anisotropy, 16);
    texture.needsUpdate = true;
    return texture;
  } finally {
    bitmap.close();
  }
}
export class CloudTileLayer {
  private readonly resident = new Map<string, ResidentTile>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Map<string, number>();
  private desired: CloudTileAsset[] = [];
  private desiredKey = '';
  private neededSince = 0;
  private disposed = false;
  private now = 0;
  private weight = 0;
  constructor(
    private readonly budget: number,
    private readonly onChange: (tiles: readonly CloudTileView[]) => void,
    private readonly diagnostics: DOMStringMap,
    private readonly load: (asset: CloudTileAsset, signal: AbortSignal) => Promise<Texture>,
  ) {}
  update(position: { x: number; y: number; z: number }, weight: number, now: number) {
    if (this.disposed) return;
    const fadeStep = Math.max(0, now - this.now) / 400;
    for (const item of this.resident.values()) {
      const wanted = this.desired.some((asset) => asset.id === item.asset.id);
      const opacity = Math.max(0, Math.min(1, item.opacity + (wanted ? fadeStep : -fadeStep)));
      item.opacity = opacity < 1e-12 ? 0 : opacity > 1 - 1e-12 ? 1 : opacity;
    }
    this.now = now;
    this.weight = weight;
    const desired =
      weight > 0.01 && this.budget > 0 ? selectCloudTiles(position).slice(0, this.budget) : [];
    const key = desired.map((asset) => asset.id).join(',');
    if (key !== this.desiredKey) {
      this.neededSince = now;
      this.desiredKey = key;
      this.desired = desired;
      for (const [id, controller] of this.pending)
        if (!desired.some((asset) => asset.id === id)) controller.abort();
    }
    for (const item of this.resident.values()) {
      if (desired.some((asset) => asset.id === item.asset.id)) item.lastUsed = now;
      else if (item.opacity === 0 && now - item.lastUsed > 15000) this.release(item.asset.id);
    }
    this.publish();
    this.pump();
  }
  private pump() {
    if (this.disposed || this.now - this.neededSince < 250) return;
    for (const asset of this.desired) {
      if (this.pending.size >= 2) break;
      if (this.resident.has(asset.id) || this.pending.has(asset.id)) continue;
      const failedAt = this.failed.get(asset.id);
      if (failedAt !== undefined && this.now - failedAt < 30000) continue;
      if (this.resident.size + this.pending.size >= this.budget) {
        const stale = [...this.resident.values()]
          .filter(
            (item) =>
              item.opacity === 0 && !this.desired.some((wanted) => wanted.id === item.asset.id),
          )
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!stale) break;
        this.release(stale.asset.id);
      }
      const controller = new AbortController();
      this.pending.set(asset.id, controller);
      void this.load(asset, controller.signal)
        .then((texture) => {
          if (this.disposed || controller.signal.aborted) texture.dispose();
          else {
            this.failed.delete(asset.id);
            this.resident.set(asset.id, {
              asset,
              texture,
              opacity: 0,
              lastUsed: this.now,
            });
          }
        })
        .catch((error: unknown) => {
          if (!this.disposed && !controller.signal.aborted) {
            this.failed.set(asset.id, this.now);
            this.diagnostics.cloudTileError =
              error instanceof Error ? error.message : 'Cloud tile unavailable';
          }
        })
        .finally(() => {
          this.pending.delete(asset.id);
          if (!this.disposed) {
            this.publish();
            this.pump();
          }
        });
    }
    this.diagnostics.cloudTilePending = String(this.pending.size);
  }
  private release(id: string) {
    this.resident.get(id)?.texture.dispose();
    this.resident.delete(id);
  }
  private publish() {
    const tiles = [...this.resident.values()]
      .filter(
        (item) =>
          (item.opacity > 0 && this.weight > 0) ||
          this.desired.some((asset) => asset.id === item.asset.id),
      )
      .sort((a, b) => (a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0));
    const loaded = this.desired.filter((asset) => this.resident.has(asset.id)).length;
    this.onChange(
      tiles.map((item) => ({
        texture: item.texture,
        bounds: item.asset.bounds_uv,
        featherEdges: (() => {
          const [x, y] = item.asset.id.split('-').map(Number);
          const opacity = (column: number, row: number) =>
            tiles.find((other) => other.asset.id === `${(column + columns) % columns}-${row}`)
              ?.opacity ?? 0;
          return [opacity(x - 1, y), opacity(x, y + 1), opacity(x + 1, y), opacity(x, y - 1)].map(
            (value) => 1 - value,
          );
        })(),
        opacity: this.weight * item.opacity,
      })),
    );
    this.diagnostics.cloudTileState = !this.desired.length
      ? 'global-only'
      : loaded === this.desired.length
        ? 'ready'
        : loaded
          ? 'partial'
          : this.desired.every((asset) => this.failed.has(asset.id))
            ? 'unavailable'
            : 'loading';
    this.diagnostics.cloudTileDesired = String(this.desired.length);
    this.diagnostics.cloudTileIds = tiles.map((item) => item.asset.id).join(',');
    this.diagnostics.cloudTileResident = String(this.resident.size);
    this.diagnostics.cloudTilePending = String(this.pending.size);
    this.diagnostics.cloudTileMix = String(this.weight);
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.pending.values()) controller.abort();
    for (const id of this.resident.keys()) this.release(id);
    this.onChange([]);
    this.diagnostics.cloudTileState = 'disposed';
    this.diagnostics.cloudTileResident = '0';
    this.diagnostics.cloudTilePending = '0';
  }
}
