import {
  AdditiveBlending,
  Color,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';
import { WGS84_B_OVER_A } from './geodesy';

// Fixed 1 AU display size, not an ephemeris or eclipse model. NASA Sun Fact Sheet,
// “Sun Observational Parameters”: 1919 arcsec diameter, checked 2026-10-25.
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html
export const SUN_DISPLAY_DIAMETER_DEG = 1919 / 3600;
const SUN_RADIUS_RAD = (SUN_DISPLAY_DIAMETER_DEG * Math.PI) / 360;
const GLOW_RADII = 7;
const PLANE_NORMAL = new Vector3(0, 0, 1);

/** Camera-ray intersection for the direction label only, never mission eclipse state. */
export function sunBehindEarth(cameraPosition: Vector3, direction: Vector3): boolean {
  const origin = cameraPosition.clone();
  const ray = direction.clone();
  origin.y /= WGS84_B_OVER_A;
  ray.y /= WGS84_B_OVER_A;
  const a = ray.lengthSq();
  const b = origin.dot(ray);
  const c = origin.lengthSq() - 1;
  return a > 0 && b < 0 && b * b > a * c;
}

export interface SunCue {
  x: number;
  y: number;
  bearingDeg: number;
  onScreen: boolean;
  behindCamera: boolean;
  behindEarth: boolean;
}

/** Project a direction, without a fictitious solar distance or a scene-camera mutation. */
export function projectSunCue(
  camera: PerspectiveCamera,
  direction: Vector3,
  width: number,
  height: number,
): SunCue {
  const local = direction.clone().applyQuaternion(camera.quaternion.clone().invert());
  const behindCamera = local.z >= 0;
  const tangent = Math.tan((camera.getEffectiveFOV() * Math.PI) / 360);
  const depth = Math.max(1e-9, Math.abs(local.z));
  const ndcX = local.x / (depth * tangent * camera.aspect);
  const ndcY = local.y / (depth * tangent);
  const onScreen = !behindCamera && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;
  const halfWidth = Math.max(1, width / 2);
  const halfHeight = Math.max(1, height / 2);
  // Insets keep the locator clear of the heading and bottom camera controls.
  const limitX = Math.max(1, halfWidth - Math.min(78, halfWidth * 0.45));
  const limitY = Math.max(1, halfHeight - Math.min(80, halfHeight * 0.45));
  let x = ndcX * halfWidth;
  let y = -ndcY * halfHeight;
  if (behindCamera && Math.hypot(x, y) < 1e-6) x = 1;
  const bearingDeg = (Math.atan2(y, x) * 180) / Math.PI;
  if (!onScreen) {
    const edge = Math.max(Math.abs(x) / limitX, Math.abs(y) / limitY, 1e-12);
    x /= edge;
    y /= edge;
  } else {
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y + 19));
  }
  return {
    x: x + halfWidth,
    y: y + halfHeight,
    bearingDeg,
    onScreen,
    behindCamera,
    behindEarth: sunBehindEarth(camera.position, direction),
  };
}

/** A separate sky camera preserves Earth and metre-scale spacecraft depth precision. */
export class SunDisplay {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly direction = new Vector3();
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly material = new ShaderMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 solarUv;
      void main() {
        solarUv = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 solarUv;
      void main() {
        float radius = length(solarUv) * ${GLOW_RADII.toFixed(1)};
        float edge = max(fwidth(radius), 0.001);
        float disk = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, radius);
        float glow = (0.018 * exp(-0.6 * radius * radius)
                    + 0.0015 * exp(-0.10 * radius * radius))
                    * (1.0 - smoothstep(5.0, 7.0, radius));
        gl_FragColor = vec4(vec3(8.0, 7.0, 5.0) * disk
                         + vec3(1.0, 0.7, 0.4) * glow, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  private readonly disk = new Mesh(this.geometry, this.material);
  private available = false;

  constructor(private readonly cue: HTMLElement) {
    this.scene.background = new Color('#060709');
    this.disk.scale.setScalar(Math.tan(SUN_RADIUS_RAD) * GLOW_RADII);
    this.disk.visible = false;
    this.scene.add(this.disk);
  }

  setDirection(direction: readonly number[]) {
    this.available =
      direction.length === 3 &&
      direction.every(Number.isFinite) &&
      Math.hypot(...direction) > 1e-12;
    this.disk.visible = this.available;
    if (!this.available) {
      this.cue.hidden = true;
      return;
    }
    this.direction.fromArray(direction).normalize();
    this.disk.position.copy(this.direction);
    this.disk.quaternion.setFromUnitVectors(PLANE_NORMAL, this.direction.clone().negate());
  }

  clear() {
    this.setDirection([]);
  }

  updateCue(camera: PerspectiveCamera, width: number, height: number) {
    this.cue.hidden = !this.available || width <= 0 || height <= 0;
    if (this.cue.hidden) return;
    const cue = projectSunCue(camera, this.direction, width, height);
    this.cue.dataset.edge = String(!cue.onScreen);
    this.cue.dataset.occluded = String(cue.behindEarth);
    this.cue.dataset.behindView = String(cue.behindCamera);
    this.cue.style.left = `${cue.x}px`;
    this.cue.style.top = `${cue.y}px`;
    this.cue.style.setProperty('--sun-bearing', `${cue.bearingDeg + 45}deg`);
    const detail = this.cue.querySelector('small');
    if (detail)
      detail.textContent = cue.behindEarth ? 'behind Earth' : cue.behindCamera ? 'behind view' : '';
  }

  renderBackground(renderer: WebGLRenderer, camera: PerspectiveCamera) {
    this.camera.copy(camera, false);
    this.camera.position.set(0, 0, 0);
    this.camera.near = 0.1;
    this.camera.far = 2;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
    this.cue.hidden = true;
  }
}
