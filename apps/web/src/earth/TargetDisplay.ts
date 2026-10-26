import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineDashedMaterial,
  Points,
  PointsMaterial,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { FollowLink } from './FollowLink';
import { ecefToDisplay, WGS84_A_M } from './geodesy';

const TARGET_COLOR = '#d8b77c';
const DASH_SIZE = 0.004;
const GAP_SIZE = 0.003;

/** Guidance targets are discrete returned state, never interpolated between commands. */
export function activeTargetAtSample(
  targets: readonly (readonly number[] | null)[] | undefined,
  index: number,
): readonly number[] | null {
  const target = targets?.[index];
  return target?.length === 3 && target.every(Number.isFinite) ? target : null;
}

/** Display-only target ray. Radio station, RF state and camera controls are independent. */
export class TargetDisplay {
  readonly group = new Group();
  private readonly lineGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
  );
  private readonly lineMaterial = new LineDashedMaterial({
    color: TARGET_COLOR,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    dashSize: DASH_SIZE,
    gapSize: GAP_SIZE,
  });
  private readonly line = new Line(this.lineGeometry, this.lineMaterial);
  private readonly markerGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  );
  private readonly markerMaterial = new PointsMaterial({
    color: TARGET_COLOR,
    size: 5,
    sizeAttenuation: false,
    depthTest: true,
    depthWrite: false,
  });
  readonly marker = new Points(this.markerGeometry, this.markerMaterial);
  private readonly nearLink: FollowLink;
  backgroundSegment: number[] = [];

  constructor(renderer: WebGLRenderer) {
    this.nearLink = new FollowLink(renderer, DASH_SIZE * WGS84_A_M, GAP_SIZE * WGS84_A_M);
    this.group.add(this.line, this.marker);
    this.group.visible = false;
  }

  setTarget(spacecraftEcefM: readonly number[], targetEcefM: readonly number[] | null) {
    if (!targetEcefM) {
      this.clear();
      return;
    }
    const segment = this.nearLink.setLink(spacecraftEcefM, targetEcefM, TARGET_COLOR, false);
    if (!segment || segment.shownRangeM <= 0) {
      this.clear();
      return;
    }
    this.line.position.fromArray(ecefToDisplay(spacecraftEcefM));
    const delta = segment.deltaDisplayM.map((value) => value / WGS84_A_M);
    const positions = this.lineGeometry.getAttribute('position');
    positions.setXYZ(0, 0, 0, 0);
    positions.setXYZ(1, delta[0], delta[1], delta[2]);
    positions.needsUpdate = true;
    this.lineGeometry.computeBoundingSphere();
    this.line.computeLineDistances();
    this.backgroundSegment = [
      this.line.position.x,
      this.line.position.y,
      this.line.position.z,
      this.line.position.x + delta[0],
      this.line.position.y + delta[1],
      this.line.position.z + delta[2],
    ];
    this.marker.position.fromArray(ecefToDisplay(targetEcefM));
    this.group.visible = true;
  }

  clear() {
    this.group.visible = false;
    this.backgroundSegment = [];
    this.nearLink.clear();
  }

  updateNear(camera: PerspectiveCamera, earthNearNormalized: number) {
    return this.nearLink.update(camera, earthNearNormalized);
  }

  renderNear() {
    this.nearLink.render();
  }

  dispose() {
    this.nearLink.dispose();
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.group.clear();
  }
}
