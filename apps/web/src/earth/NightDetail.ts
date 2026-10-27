import { ClampToEdgeWrapping } from 'three';
import type { Texture } from 'three';
import { loadDetailedNightMap } from './nightMap';
import type { NightMapAsset } from './nightMap';

export interface NightDetailAsset extends NightMapAsset {
  bounds_deg: { west: number; east: number; south: number; north: number };
}
export interface NightDetailView {
  texture: Texture | null;
  bounds: readonly number[];
  opacity: number;
}
export function nightDetailWeight(
  position: { x: number; y: number; z: number },
  bounds: NightDetailAsset['bounds_deg'],
) {
  const radius = Math.hypot(position.x, position.y, position.z);
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  const latitude = ((bounds.south + bounds.north) * Math.PI) / 360;
  const longitude = ((bounds.west + bounds.east) * Math.PI) / 360;
  const dot =
    (position.x * Math.cos(latitude) * Math.cos(longitude) +
      position.y * Math.sin(latitude) -
      position.z * Math.cos(latitude) * Math.sin(longitude)) /
    radius;
  const halfDiagonal =
    (Math.hypot(bounds.north - bounds.south, bounds.east - bounds.west) * Math.PI) / 360;
  // Conservative spherical visibility with a small ellipsoid/edge allowance.
  const horizon = Math.acos(Math.min(1, 1 / radius));
  if (dot < Math.cos(horizon + halfDiagonal + 0.03)) return 0;
  const close = Math.max(0, Math.min(1, (2.2 - radius) / 0.85));
  return close * close * (3 - 2 * close);
}
export async function readNightDetail(
  asset: NightDetailAsset,
  signal: AbortSignal,
  anisotropy: number,
) {
  const texture = await loadDetailedNightMap(asset, anisotropy, signal);
  texture.wrapS = ClampToEdgeWrapping;
  return texture;
}
export class NightDetailLayer {
  private texture: Texture | null = null;
  private pending: AbortController | null = null;
  private neededSince: number | null = null;
  private unusedSince: number | null = null;
  private failedAt = -Infinity;
  private disposed = false;
  private now = 0;
  private weight = 0;
  private opacity = 0;
  private readonly bounds: number[];
  constructor(
    private readonly asset: NightDetailAsset,
    private readonly onChange: (view: NightDetailView) => void,
    private readonly diagnostics: DOMStringMap,
    private readonly load: (asset: NightDetailAsset, signal: AbortSignal) => Promise<Texture>,
  ) {
    const b = asset.bounds_deg;
    this.bounds = [
      (b.west + 180) / 360,
      (b.south + 90) / 180,
      (b.east + 180) / 360,
      (b.north + 90) / 180,
    ];
  }
  update(position: { x: number; y: number; z: number }, enabled: boolean, now: number) {
    if (this.disposed) return;
    this.opacity = this.texture ? Math.min(1, this.opacity + Math.max(0, now - this.now) / 400) : 0;
    this.now = now;
    this.weight = enabled ? nightDetailWeight(position, this.asset.bounds_deg) : 0;
    if (this.weight <= 0.01) {
      this.weight = 0;
      this.neededSince = null;
      this.pending?.abort();
      this.unusedSince ??= now;
      if (this.texture && now - this.unusedSince >= 15000) this.release();
    } else {
      this.unusedSince = null;
      this.neededSince ??= now;
      if (
        !this.texture &&
        !this.pending &&
        now - this.neededSince >= 250 &&
        now - this.failedAt >= 30000
      )
        this.start();
    }
    this.publish();
  }
  private start() {
    const controller = new AbortController();
    this.pending = controller;
    void this.load(this.asset, controller.signal)
      .then((texture) => {
        if (this.disposed || controller.signal.aborted) texture.dispose();
        else {
          this.texture = texture;
          this.opacity = 0;
          this.failedAt = -Infinity;
          delete this.diagnostics.nightDetailError;
        }
      })
      .catch((error: unknown) => {
        if (!this.disposed && !controller.signal.aborted) {
          this.failedAt = this.now;
          this.diagnostics.nightDetailError =
            error instanceof Error ? error.message : 'Night detail unavailable';
        }
      })
      .finally(() => {
        if (this.pending === controller) this.pending = null;
        if (!this.disposed) this.publish();
      });
  }
  private release() {
    this.texture?.dispose();
    this.texture = null;
    this.opacity = 0;
  }
  private publish() {
    const opacity = this.weight * this.opacity;
    this.onChange({ texture: this.texture, bounds: this.bounds, opacity });
    this.diagnostics.nightDetailState = !this.weight
      ? 'global-only'
      : this.texture
        ? 'ready'
        : this.pending
          ? 'loading'
          : Number.isFinite(this.failedAt)
            ? 'unavailable'
            : 'waiting';
    this.diagnostics.nightDetailMix = opacity.toFixed(3);
    this.diagnostics.nightDetailResident = this.texture ? '1' : '0';
    this.diagnostics.nightDetailPending = this.pending ? '1' : '0';
  }
  suspend() {
    if (this.disposed) return;
    this.pending?.abort();
    this.neededSince = null;
    this.unusedSince = null;
    this.weight = 0;
    this.release();
    this.publish();
  }
  dispose() {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    this.diagnostics.nightDetailState = 'disposed';
    this.diagnostics.nightDetailPending = '0';
  }
}
