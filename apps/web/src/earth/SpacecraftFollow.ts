import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Material } from 'three';
import type { AssetInfo, Variant } from '../types';
import { createSpacecraftDisplay } from '../graphics/spacecraftDisplay';
import { createThermalOverlay } from '../graphics/thermalOverlay';

// Display basis C: body/ECEF (x,y,z) -> glTF/display (x,z,-y).
const C = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const CI = C.clone().invert();
const Z = new Vector3(0, 0, 1);
const ORIGIN = new Vector3();
// Fallback only for the current synthetic core: E/I coincide at pass midpoint.
const SYNTHETIC_EARTH_OMEGA_RAD_S = 7.292115e-5;

export interface FollowStatus {
  state: 'loading' | 'ready' | 'unavailable';
  revision: string;
  error?: string;
}

/** Pose only. No spacecraft position, attitude history or Scenario is mutated. */
export function spacecraftEarthQuaternion(
  qBodyFromInertialWxyz: readonly number[],
  timeS: number,
  durationS: number,
  ecefFromInertialAngleRad?: number,
): Quaternion {
  if (qBodyFromInertialWxyz.length !== 4 || !qBodyFromInertialWxyz.every(Number.isFinite))
    return new Quaternion();
  const [w, x, y, z] = qBodyFromInertialWxyz;
  const inertialFromBody = new Quaternion(x, y, z, w);
  if (inertialFromBody.lengthSq() < 1e-20) return new Quaternion();
  inertialFromBody.normalize().invert();
  const angle = Number.isFinite(ecefFromInertialAngleRad)
    ? ecefFromInertialAngleRad!
    : -SYNTHETIC_EARTH_OMEGA_RAD_S * (timeS - durationS / 2);
  const ecefFromInertial = new Quaternion().setFromAxisAngle(Z, Number.isFinite(angle) ? angle : 0);
  return C.clone().multiply(ecefFromInertial).multiply(inertialFromBody).multiply(CI).normalize();
}

/** SI-metres foreground pass for a normalized-ECEF Earth renderer.
 * Background display camera = satelliteDisplay + camera.position / WGS84_A_M,
 * with this same camera quaternion and FOV. Render Earth, clear depth, then render().
 * The local model keeps its authored scale and body origin; no display enlargement.
 */
export class SpacecraftFollow {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(34, 1, 0.00005, 100);
  controls: OrbitControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly poseRoot = new Group();
  private readonly sun = new DirectionalLight('#fff6e7', 3.2);
  private readonly markerGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  );
  private readonly markerMaterial = new PointsMaterial({
    color: '#ef6771',
    size: 6,
    sizeAttenuation: false,
  });
  private readonly marker = new Points(this.markerGeometry, this.markerMaterial);
  private readonly pmrem: PMREMGenerator;
  private readonly environment: ReturnType<PMREMGenerator['fromScene']>;
  private readonly radial = new Vector3(0, 0, 1);
  private readonly raycaster = new Raycaster();
  private readonly viewport = new Vector3();
  private root: Group | null = null;
  private thermalOverlay: ReturnType<typeof createThermalOverlay> | null = null;
  private temperatures: Record<string, number> | undefined;
  private display: ReturnType<typeof createSpacecraftDisplay> | null = null;
  private abort: AbortController | null = null;
  private ticket = 0;
  private assetKey = '';
  private radius = 0.25;
  private height = 1;
  private seededPosition = false;
  private disposed = false;
  private currentStatus: FollowStatus = { state: 'unavailable', revision: 'Revision unverified' };

  constructor(
    private readonly renderer: WebGLRenderer,
    canvas: HTMLCanvasElement = renderer.domElement,
    private readonly onStatus?: (status: FollowStatus) => void,
  ) {
    this.canvas = canvas;
    this.camera.up.copy(this.radial);
    this.controls = this.makeControls(false);
    this.scene.add(
      this.poseRoot,
      this.marker,
      this.sun,
      this.sun.target,
      new HemisphereLight('#dde6ed', '#121619', 1.1),
    );
    this.sun.position.set(1, 2, 2);
    this.pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = this.pmrem.fromScene(room, 0.04);
    room.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.75;
    // Background is null so the foreground pass cannot erase Earth.
    this.scene.background = null;
    this.resetView();
  }

  get status(): FollowStatus {
    return this.currentStatus;
  }
  get modelVisible(): boolean {
    return this.root !== null && this.poseRoot.visible;
  }

  private report(status: FollowStatus) {
    this.currentStatus = status;
    this.onStatus?.(status);
  }

  private makeControls(enabled: boolean) {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.enablePan = false;
    controls.zoomToCursor = false;
    controls.minDistance = 0.065;
    controls.maxDistance = 50_000_000;
    controls.enabled = enabled;
    return controls;
  }

  setEnabled(enabled: boolean) {
    this.controls.enabled = enabled;
  }

  setPosition(positionEcefM: readonly number[]) {
    if (positionEcefM.length !== 3 || !positionEcefM.every(Number.isFinite)) return;
    const radial = new Vector3(positionEcefM[0], positionEcefM[2], -positionEcefM[1]);
    if (radial.lengthSq() < 1) return;
    this.radial.copy(radial).normalize();
    if (!this.seededPosition) {
      this.seededPosition = true;
      this.resetView();
    }
  }

  setPose(
    qBodyFromInertialWxyz: readonly number[],
    timeS: number,
    durationS: number,
    ecefFromInertialAngleRad?: number,
  ) {
    this.poseRoot.quaternion.copy(
      spacecraftEarthQuaternion(qBodyFromInertialWxyz, timeS, durationS, ecefFromInertialAngleRad),
    );
    this.poseRoot.updateMatrixWorld(true);
  }

  setSun(directionDisplay: readonly number[]) {
    if (directionDisplay.length === 3 && directionDisplay.every(Number.isFinite)) {
      this.viewport.set(directionDisplay[0], directionDisplay[1], directionDisplay[2]);
      if (this.viewport.lengthSq() > 1e-20)
        this.sun.position.copy(this.viewport).normalize().multiplyScalar(10);
    }
  }

  setSize(width: number, height: number) {
    this.height = Math.max(1, height);
    this.camera.aspect = Math.max(1, width) / this.height;
    this.camera.updateProjectionMatrix();
  }

  resetView() {
    const tangent = new Vector3(0, 1, 0).addScaledVector(this.radial, -this.radial.y);
    if (tangent.lengthSq() < 1e-8)
      tangent.set(1, 0, 0).addScaledVector(this.radial, -this.radial.x);
    tangent.normalize();
    const distance = Math.max(1.1, this.radius * 5);
    // About 60° from nadir viewing: the Earth limb sits behind the real-sized craft.
    this.camera.position
      .copy(this.radial)
      .multiplyScalar(0.5)
      .addScaledVector(tangent, Math.sqrt(0.75))
      .multiplyScalar(distance);
    // OrbitControls caches its up-axis basis at construction. Recreate it only
    // when an explicit reset adopts a different local radial up direction.
    if (!this.camera.up.equals(this.radial)) {
      const enabled = this.controls.enabled;
      this.controls.dispose();
      this.camera.up.copy(this.radial);
      this.controls = this.makeControls(enabled);
    }
    this.controls.target.copy(ORIGIN);
    this.controls.update();
  }

  async setAsset(variant: Variant, asset?: AssetInfo) {
    const url = asset?.url || `/api/assets/spacecraft.glb?variant=${variant}`;
    const key = `${variant}|${url}|${asset?.sha256 || ''}|${asset?.revision || ''}|${asset?.available ?? ''}`;
    if (this.disposed || key === this.assetKey) return;
    this.assetKey = key;
    const ticket = ++this.ticket;
    this.abort?.abort();
    this.abort = new AbortController();
    this.clearModel();
    const revision = asset?.revision || 'Revision unverified';
    if (asset?.available === false) {
      this.report({
        state: 'unavailable',
        revision,
        error: 'Spacecraft model unavailable; showing position marker.',
      });
      return;
    }
    this.report({ state: 'loading', revision });
    try {
      const response = await fetch(url, { signal: this.abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Spacecraft model unavailable (${response.status})`);
      const headerRevision = response.headers.get('X-Asset-Revision') || revision;
      const buffer = await response.arrayBuffer();
      const gltf = await new GLTFLoader().parseAsync(
        buffer,
        new URL(url, window.location.href).href.replace(/[^/]*$/, ''),
      );
      if (this.disposed || ticket !== this.ticket) {
        disposeModel(gltf.scene);
        return;
      }
      this.root = gltf.scene;
      this.poseRoot.add(this.root);
      this.root.updateMatrixWorld(true);
      const sphere = new Box3().setFromObject(this.root).getBoundingSphere(new Sphere());
      this.radius = Math.max(0.05, sphere.radius + sphere.center.length());
      this.display = createSpacecraftDisplay(this.root);
      this.thermalOverlay = createThermalOverlay(this.root);
      this.thermalOverlay.update(this.temperatures);
      this.report({ state: 'ready', revision: headerRevision });
    } catch (cause) {
      if (
        !this.disposed &&
        ticket === this.ticket &&
        !(cause instanceof DOMException && cause.name === 'AbortError')
      ) {
        this.report({
          state: 'unavailable',
          revision,
          error:
            cause instanceof Error
              ? cause.message
              : 'Spacecraft model unavailable; showing position marker.',
        });
      }
    }
  }

  setTemperatures(temperatures?: Record<string, number>) {
    this.temperatures = temperatures;
    this.thermalOverlay?.update(temperatures);
  }

  update(dt: number) {
    if (this.disposed) return;
    if (
      ![this.camera.position.x, this.camera.position.y, this.camera.position.z].every(
        Number.isFinite,
      )
    )
      this.resetView();
    this.controls.target.copy(ORIGIN);
    this.controls.update(Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0)));
    this.poseRoot.updateMatrixWorld(true);
    let distance = Math.max(0.001, this.camera.position.length());
    if (this.root && distance < this.radius * 1.5) {
      // Origin is inside the chassis; keep the camera beyond the last exterior
      // intersection along its radial sightline, including a petal if crossed.
      this.viewport.copy(this.camera.position).normalize();
      this.raycaster.set(ORIGIN, this.viewport);
      this.raycaster.far = this.radius * 2;
      const hits = this.raycaster.intersectObject(this.root, true);
      const last = hits.filter((hit) => hit.object.visible).at(-1);
      if (last && distance < last.distance + 0.003) {
        distance = last.distance + 0.003;
        this.camera.position.copy(this.viewport).multiplyScalar(distance);
        this.camera.lookAt(ORIGIN);
      }
    }
    const diameterPixels =
      (this.radius * this.height) / (distance * Math.tan((this.camera.fov * Math.PI) / 360));
    this.poseRoot.visible = this.root !== null && diameterPixels >= 0.6;
    this.marker.visible = !this.poseRoot.visible;
    if (this.display && this.poseRoot.visible)
      this.display.update(this.camera, this.renderer.domElement.height, this.radius);
    else {
      this.camera.near = Math.max(0.00005, distance * 0.5);
      this.camera.far = Math.max(this.camera.near * 1.1, distance * 1.5);
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  render() {
    if (this.disposed) return;
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }

  private clearModel() {
    this.thermalOverlay?.dispose();
    this.thermalOverlay = null;
    if (this.root) {
      this.poseRoot.remove(this.root);
      disposeModel(this.root);
    }
    this.root = null;
    this.display = null;
    this.poseRoot.visible = false;
    this.marker.visible = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ticket++;
    this.abort?.abort();
    this.controls.dispose();
    this.clearModel();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.environment.dispose();
    this.pmrem.dispose();
    this.scene.clear();
  }
}

function disposeModel(root: Group) {
  const geometries = new Set<Mesh['geometry']>(),
    materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
      materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => {
    const data = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    texture.dispose();
  });
}
