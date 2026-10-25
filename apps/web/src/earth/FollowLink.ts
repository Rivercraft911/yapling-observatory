import {
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';
import { WGS84_A_M, WGS84_B_OVER_A } from './geodesy';

export interface LocalLinkSegment {
  deltaDisplayM: [number, number, number];
  fullRangeM: number;
  shownRangeM: number;
  blockedByEarth: boolean;
}

/** View geometry only: subtract authoritative ECEF doubles before any Float32 upload. */
export function localLinkSegment(
  spacecraftEcefM: readonly number[],
  stationEcefM: readonly number[],
): LocalLinkSegment | null {
  if (
    spacecraftEcefM.length !== 3 ||
    stationEcefM.length !== 3 ||
    ![...spacecraftEcefM, ...stationEcefM].every(Number.isFinite)
  )
    return null;
  const delta = stationEcefM.map((value, i) => value - spacecraftEcefM[i]);
  const fullRangeM = Math.hypot(...delta);
  if (fullRangeM < 1e-6) return null;
  const axes = [WGS84_A_M, WGS84_A_M, WGS84_A_M * WGS84_B_OVER_A];
  const origin = spacecraftEcefM.map((value, i) => value / axes[i]);
  const direction = delta.map((value, i) => value / axes[i]);
  const a = direction.reduce((sum, value) => sum + value * value, 0);
  const b = 2 * origin.reduce((sum, value, i) => sum + value * direction[i], 0);
  const c = origin.reduce((sum, value) => sum + value * value, 0) - 1;
  let end = 1;
  if (c <= 0) end = 0;
  else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      // Stable quadratic roots; the first forward surface intersection hides
      // everything beyond it, including a station behind the opaque Earth.
      const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
      const roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
      const hit = roots.filter((value) => value >= 0).sort((x, y) => x - y)[0];
      if (hit !== undefined) end = Math.max(0, Math.min(1, hit));
    }
  }
  return {
    deltaDisplayM: [delta[0] * end, delta[2] * end, -delta[1] * end],
    fullRangeM,
    shownRangeM: fullRangeM * end,
    blockedByEarth: end < 1 - 1e-10,
  };
}

/** A conservative sphere contains this near frustum and excludes the WGS84 Earth. */
export function nearLinkOutsideEarth(
  spacecraftEcefM: readonly number[],
  camera: PerspectiveCamera,
  farM: number,
) {
  const tangent = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  const cornerRadius = farM * Math.sqrt(1 + tangent ** 2 + (camera.aspect * tangent) ** 2);
  return camera.position.length() + cornerRadius < Math.hypot(...spacecraftEcefM) - WGS84_A_M;
}

/** Clip the local ray in double precision to keep GPU vertices within the near frustum. */
export function clipLocalLinkToFrustum(
  deltaDisplayM: readonly number[],
  camera: PerspectiveCamera,
) {
  camera.updateMatrixWorld();
  const start = new Vector3().applyMatrix4(camera.matrixWorldInverse);
  const end = new Vector3(deltaDisplayM[0], deltaDisplayM[1], deltaDisplayM[2]).applyMatrix4(
    camera.matrixWorldInverse,
  );
  const tangentY = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  const tangentX = tangentY * camera.aspect;
  const planes = (point: Vector3) => {
    const depth = -point.z;
    return [
      depth - camera.near,
      camera.far - depth,
      depth * tangentX + point.x,
      depth * tangentX - point.x,
      depth * tangentY + point.y,
      depth * tangentY - point.y,
    ];
  };
  const a = planes(start),
    b = planes(end);
  let first = 0,
    last = 1;
  for (let i = 0; i < a.length; i++) {
    const change = b[i] - a[i];
    if (Math.abs(change) < 1e-14) {
      if (a[i] < 0) return null;
      continue;
    }
    const crossing = -a[i] / change;
    if (change > 0) first = Math.max(first, crossing);
    else last = Math.min(last, crossing);
    if (first > last) return null;
  }
  const length = Math.hypot(...deltaDisplayM);
  return {
    start: deltaDisplayM.map((value) => value * first),
    end: deltaDisplayM.map((value) => value * last),
    startDistanceM: length * first,
    endDistanceM: length * last,
  };
}

/** Independent near-link pass. It never widens the spacecraft camera's depth range. */
export class FollowLink {
  readonly camera = new PerspectiveCamera();
  private readonly scene = new Scene();
  private readonly geometry = new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3))
    .setAttribute('lineDistance', new Float32BufferAttribute([0, 0], 1));
  private readonly solidMaterial = new LineBasicMaterial({
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  private readonly dashedMaterial: LineDashedMaterial;
  private readonly solid: Line;
  private readonly dashed: Line;
  private readonly renderer: WebGLRenderer;
  private segment: LocalLinkSegment | null = null;
  private spacecraftEcefM: readonly number[] = [];
  private solidStyle = false;
  private active = false;

  constructor(renderer: WebGLRenderer, dashSizeM: number, gapSizeM: number) {
    this.renderer = renderer;
    this.dashedMaterial = new LineDashedMaterial({
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      dashSize: dashSizeM,
      gapSize: gapSizeM,
    });
    this.solid = new Line(this.geometry, this.solidMaterial);
    this.dashed = new Line(this.geometry, this.dashedMaterial);
    this.scene.add(this.solid, this.dashed);
  }

  setLink(
    spacecraftEcefM: readonly number[],
    stationEcefM: readonly number[],
    color: string,
    solid: boolean,
  ) {
    this.spacecraftEcefM = [...spacecraftEcefM];
    this.segment = localLinkSegment(spacecraftEcefM, stationEcefM);
    this.solidStyle = solid;
    this.solidMaterial.color.set(color);
    this.dashedMaterial.color.set(color);
    return this.segment;
  }

  clear() {
    this.segment = null;
    this.active = false;
  }

  update(localCamera: PerspectiveCamera, earthNearNormalized: number) {
    this.active = false;
    const farM = earthNearNormalized * WGS84_A_M * 1.001;
    if (
      !this.segment ||
      localCamera.position.length() >= farM ||
      !nearLinkOutsideEarth(this.spacecraftEcefM, localCamera, farM)
    )
      return false;
    this.camera.copy(localCamera, false);
    this.camera.far = farM;
    this.camera.updateProjectionMatrix();
    const clipped = clipLocalLinkToFrustum(this.segment.deltaDisplayM, this.camera);
    if (!clipped) return false;
    const positions = this.geometry.getAttribute('position'),
      distances = this.geometry.getAttribute('lineDistance');
    positions.setXYZ(0, clipped.start[0], clipped.start[1], clipped.start[2]);
    positions.setXYZ(1, clipped.end[0], clipped.end[1], clipped.end[2]);
    positions.needsUpdate = true;
    distances.setX(0, clipped.startDistanceM);
    distances.setX(1, clipped.endDistanceM);
    distances.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.solid.visible = this.solidStyle;
    this.dashed.visible = !this.solidStyle;
    this.active = true;
    return true;
  }

  render() {
    if (!this.active) return;
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.solidMaterial.dispose();
    this.dashedMaterial.dispose();
    this.scene.clear();
  }
}
