import {
  Box3,
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  PCFShadowMap,
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
  SphereGeometry,
  ShaderMaterial,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Material } from 'three';
import type { AssetInfo, Variant } from '../types';
import { createSpacecraftDisplay } from '../graphics/spacecraftDisplay';
import { createThermalOverlay } from '../graphics/thermalOverlay';

// Display basis C: body/ECEF (x,y,z) -> glTF/display (x,z,-y).
const C = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const CI = C.clone().invert();
const Z = new Vector3(0, 0, 1);
const ORIGIN = new Vector3();
const ENVIRONMENT_UP = new Vector3(0, 1, 0);
// Fallback only for the current synthetic core: E/I coincide at pass midpoint.
const SYNTHETIC_EARTH_OMEGA_RAD_S = 7.292115e-5;

/** Appearance-only broad Earth reflection; never used by power or thermal models. */
export function earthFillIntensity(radiusM: number, sunCosine: number) {
  const cosine = Math.max(-1, Math.min(1, sunCosine));
  const angle = Math.acos(cosine);
  const phase = (Math.sin(angle) + (Math.PI - angle) * cosine) / Math.PI;
  return 0.9 * phase * Math.min(1, (6928137 / Math.max(6378137, radiusM)) ** 2);
}

function earthEnvironment(pmrem: PMREMGenerator) {
  const scene = new Scene();
  scene.background = new Color(0);
  const geometry = new SphereGeometry(1, 32, 16);
  const material = new ShaderMaterial({
    side: BackSide,
    vertexShader: `varying vec3 direction;void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec3 direction;void main(){float disk=smoothstep(.32,.46,normalize(direction).y);gl_FragColor=vec4(vec3(.32,.42,.52)*disk,1.);}`,
  });
  scene.add(new Mesh(geometry, material));
  try {
    return pmrem.fromScene(scene, 0, 0.1, 2, { size: 64 });
  } finally {
    geometry.dispose();
    material.dispose();
  }
}

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
  // Controls keep a fixed up basis; the public camera publishes the transported view.
  private readonly navigationCamera = new PerspectiveCamera(34, 1, 0.00005, 100);
  private earthLocked = false;
  private readonly earthCameraFrame = new Quaternion();
  private readonly publishedCameraFrame = new Quaternion();
  private readonly cameraFrameRotation = new Quaternion();
  private readonly navigationFromDisplay = new Quaternion();
  private readonly previousNavigationUp = new Vector3();
  private readonly publishedCameraPosition = new Vector3();
  private readonly publishedCameraQuaternion = new Quaternion();
  private readonly publishedCameraUp = new Vector3();
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
  private pmrem: PMREMGenerator;
  private environment: ReturnType<PMREMGenerator['fromScene']>;
  private readonly radial = new Vector3(0, 0, 1);
  private readonly sunDirection = new Vector3(1, 2, 2).normalize();
  private readonly shadowSunBody = new Vector3();
  private readonly shadowUpBody = new Vector3(0, 1, 0);
  private readonly shadowBodyFromDisplay = new Quaternion();
  private readonly shadowRotation = new Quaternion();
  private readonly shadowDirection = new Vector3();
  private readonly earthRotation = new Quaternion();
  private orbitalRadiusM = 6928137;
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
  private contextRestored = () => {
    if (this.disposed) return;
    this.environment.dispose();
    this.pmrem.dispose();
    const lighting = this.createEarthEnvironment();
    this.pmrem = lighting.pmrem;
    this.environment = lighting.environment;
    this.scene.environment = this.environment.texture;
    this.sun.shadow.dispose();
    this.sun.shadow.map = null;
    this.sun.shadow.mapPass = null;
    this.sun.shadow.needsUpdate = true;
  };

  constructor(
    private readonly renderer: WebGLRenderer,
    canvas: HTMLCanvasElement = renderer.domElement,
    private readonly onStatus?: (status: FollowStatus) => void,
  ) {
    this.canvas = canvas;
    this.camera.up.copy(this.radial);
    this.navigationCamera.up.copy(this.radial);
    this.controls = this.makeControls(false);
    this.scene.add(this.poseRoot, this.marker, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    // r183's extra PCF taps rotate per screen pixel. Zero radius retains
    // hardware bilinear filtering without that moving noise pattern.
    this.sun.shadow.radius = 0;
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.bias = -0.00005;
    this.sun.shadow.normalBias = 0.00012;
    this.fitSunShadow();
    const lighting = this.createEarthEnvironment();
    this.pmrem = lighting.pmrem;
    this.environment = lighting.environment;
    this.scene.environment = this.environment.texture;
    this.updateEarthFill();
    // Background is null so the foreground pass cannot erase Earth.
    this.scene.background = null;
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.resetView();
  }

  private createEarthEnvironment() {
    const pmrem = new PMREMGenerator(this.renderer);
    try {
      return { pmrem, environment: earthEnvironment(pmrem) };
    } catch (cause) {
      pmrem.dispose();
      throw cause;
    }
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
    const controls = new OrbitControls(this.navigationCamera, this.canvas);
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

  setEarthLock(enabled: boolean) {
    if (this.disposed || this.earthLocked === enabled) return;
    this.earthLocked = enabled;
    this.earthCameraFrame.identity();
    this.syncNavigationCamera(this.earthCameraFrame, true);
    this.publishCamera();
    this.captureCamera();
    this.canvas.dataset.earthLock = String(enabled);
  }

  private syncNavigationCamera(frame: Quaternion, resetControls = false) {
    this.previousNavigationUp.copy(this.navigationCamera.up);
    this.navigationFromDisplay.copy(frame).invert();
    this.navigationCamera.copy(this.camera, false);
    this.navigationCamera.position.applyQuaternion(this.navigationFromDisplay);
    this.navigationCamera.quaternion.premultiply(this.navigationFromDisplay);
    this.navigationCamera.up.applyQuaternion(this.navigationFromDisplay);
    if (
      resetControls ||
      this.previousNavigationUp.distanceToSquared(this.navigationCamera.up) > 1e-16
    ) {
      const enabled = this.controls.enabled;
      this.controls.dispose();
      this.controls = this.makeControls(enabled);
    }
    this.controls.target.copy(ORIGIN);
    this.controls.update();
  }

  private publishCamera() {
    this.camera.position
      .copy(this.navigationCamera.position)
      .applyQuaternion(this.earthCameraFrame);
    this.camera.quaternion.copy(this.earthCameraFrame).multiply(this.navigationCamera.quaternion);
    this.camera.up.copy(this.navigationCamera.up).applyQuaternion(this.earthCameraFrame);
    this.publishedCameraFrame.copy(this.earthCameraFrame);
    this.camera.updateMatrixWorld();
  }

  private captureCamera() {
    this.publishedCameraPosition.copy(this.camera.position);
    this.publishedCameraQuaternion.copy(this.camera.quaternion);
    this.publishedCameraUp.copy(this.camera.up);
  }

  setPosition(positionEcefM: readonly number[]) {
    if (positionEcefM.length !== 3 || !positionEcefM.every(Number.isFinite)) return;
    const radial = new Vector3(positionEcefM[0], positionEcefM[2], -positionEcefM[1]);
    if (radial.lengthSq() < 1) return;
    this.orbitalRadiusM = radial.length();
    radial.normalize();
    if (this.earthLocked && this.seededPosition) {
      // Transport the view with Earth's direction, independently of body attitude.
      this.earthCameraFrame
        .premultiply(this.cameraFrameRotation.setFromUnitVectors(this.radial, radial))
        .normalize();
    }
    this.radial.copy(radial);
    this.updateEarthFill();
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
    const pose = spacecraftEarthQuaternion(
      qBodyFromInertialWxyz,
      timeS,
      durationS,
      ecefFromInertialAngleRad,
    );
    if (!this.poseRoot.quaternion.equals(pose)) this.sun.shadow.needsUpdate = true;
    this.poseRoot.quaternion.copy(pose);
    this.poseRoot.updateMatrixWorld(true);
    this.orientSunShadow();
  }

  setSun(directionDisplay: readonly number[], visibility = 1) {
    if (directionDisplay.length === 3 && directionDisplay.every(Number.isFinite)) {
      this.viewport.set(directionDisplay[0], directionDisplay[1], directionDisplay[2]);
      if (this.viewport.lengthSq() > 1e-20) {
        this.viewport.normalize();
        if (!this.sunDirection.equals(this.viewport)) {
          this.sunDirection.copy(this.viewport);
          this.fitSunShadow();
        }
        this.updateEarthFill();
      }
    }
    this.sun.intensity =
      3.2 * Math.max(0, Math.min(1, Number.isFinite(visibility) ? visibility : 1));
  }

  private fitSunShadow() {
    const extent = this.radius * 1.08;
    const distance = Math.max(1, extent * 4);
    this.sun.position.copy(this.sunDirection).multiplyScalar(distance);
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -extent;
    camera.right = camera.top = extent;
    camera.near = distance - extent;
    camera.far = distance + extent;
    this.orientSunShadow();
    camera.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  private orientSunShadow() {
    const direction = this.shadowDirection
      .copy(this.sunDirection)
      .applyQuaternion(this.shadowBodyFromDisplay.copy(this.poseRoot.quaternion).invert());
    if (this.shadowSunBody.lengthSq() === 0) {
      this.shadowUpBody.set(
        Math.abs(direction.y) < 0.9 ? 0 : 1,
        Math.abs(direction.y) < 0.9 ? 1 : 0,
        0,
      );
    } else {
      this.shadowUpBody.applyQuaternion(
        this.shadowRotation.setFromUnitVectors(this.shadowSunBody, direction),
      );
    }
    // Transport in body coordinates: a roll about the Sun must not resample
    // otherwise unchanged shadows. No world-axis threshold changes the basis.
    this.shadowUpBody.addScaledVector(direction, -this.shadowUpBody.dot(direction)).normalize();
    this.shadowSunBody.copy(direction);
    this.sun.shadow.camera.up.copy(this.shadowUpBody).applyQuaternion(this.poseRoot.quaternion);
  }

  private updateEarthFill() {
    this.earthRotation.setFromUnitVectors(ENVIRONMENT_UP, this.viewport.copy(this.radial).negate());
    this.scene.environmentRotation.setFromQuaternion(this.earthRotation);
    this.scene.environmentIntensity = earthFillIntensity(
      this.orbitalRadiusM,
      this.radial.dot(this.sunDirection),
    );
  }

  setSize(width: number, height: number) {
    this.height = Math.max(1, height);
    this.camera.aspect = Math.max(1, width) / this.height;
    this.navigationCamera.aspect = this.camera.aspect;
    this.navigationCamera.updateProjectionMatrix();
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
    this.camera.up.copy(this.radial);
    this.earthCameraFrame.identity();
    this.syncNavigationCamera(this.earthCameraFrame, true);
    this.publishCamera();
    this.captureCamera();
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
      this.root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const fine = materials.every(
          (material) => material.name === 'Very fine cell metallization',
        );
        object.castShadow = object.receiveShadow = !fine;
        for (const material of materials) material.shadowSide = DoubleSide;
      });
      this.fitSunShadow();
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
    // The Earth collision gate can adjust the public camera after this update.
    // Import that adjustment in the last published frame before transporting it.
    if (
      !this.camera.position.equals(this.publishedCameraPosition) ||
      !this.camera.quaternion.equals(this.publishedCameraQuaternion) ||
      !this.camera.up.equals(this.publishedCameraUp)
    )
      this.syncNavigationCamera(this.publishedCameraFrame);
    this.controls.target.copy(ORIGIN);
    this.controls.update(Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0)));
    this.publishCamera();
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
        this.syncNavigationCamera(this.earthCameraFrame);
      }
    }
    const diameterPixels =
      (this.radius * this.height) / (distance * Math.tan((this.camera.fov * Math.PI) / 360));
    const modelVisible = this.root !== null && diameterPixels >= 0.6;
    // A paused far view can cache an empty map while only the marker is drawn.
    // Re-entering model range must refresh it even when Sun and pose are held.
    if (this.poseRoot.visible !== modelVisible) this.sun.shadow.needsUpdate = true;
    this.poseRoot.visible = modelVisible;
    this.marker.visible = !this.poseRoot.visible;
    if (this.display && this.poseRoot.visible)
      this.display.update(this.camera, this.renderer.domElement.height, this.radius);
    else {
      this.camera.near = Math.max(0.00005, distance * 0.5);
      this.camera.far = Math.max(this.camera.near * 1.1, distance * 1.5);
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.captureCamera();
  }

  render() {
    if (this.disposed) return;
    const autoClear = this.renderer.autoClear;
    const shadows = this.renderer.shadowMap.enabled;
    const shadowType = this.renderer.shadowMap.type;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.shadowMap.enabled = shadows;
      this.renderer.shadowMap.type = shadowType;
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
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.controls.dispose();
    this.clearModel();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.sun.shadow.dispose();
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
