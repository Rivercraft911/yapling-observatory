import { FrameSize } from '../graphics/frameSize';
import { linkDisplayState } from '../mission/linkDisplay';
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  NoColorSpace,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  REVISION,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Texture,
  LinearMipmapLinearFilter,
  LinearFilter,
  RepeatWrapping,
  ClampToEdgeWrapping,
  Vector3,
  Vector2,
  Raycaster,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AssetInfo, RunSnapshot, Variant } from '../types';
import { createRenderer } from '../graphics/renderer';
import { createEarthAppearance } from './atmosphereAdapter';
import type { EarthAppearance } from './atmosphereAdapter';
import { earthGeometry, earthDepthRange } from './geometry';
import { SpacecraftFollow } from './SpacecraftFollow';
import { FollowLink } from './FollowLink';
import { SunDisplay } from './SunDisplay';
import { TargetDisplay, activeTargetAtSample } from './TargetDisplay';
import { GroundTrackLayer } from './GroundTrackLayer';
import regionalImagery from './regional-lod.json';
import cloudImagery from './cloud-tiles.json';
import { CloudTileLayer, cloudTileBudget, readCloudTile } from './CloudTiles';
import type { FollowStatus } from './SpacecraftFollow';
import {
  displayBracket,
  interpolateVector3,
  interpolateQuaternion,
} from '../graphics/displayInterpolation';
import type { DisplayTimeSource } from '../graphics/displayInterpolation';
import {
  ecefToDisplay,
  geodeticToEcef,
  isEarthOccluded,
  visualSunDirection,
  WGS84_A_M,
  WGS84_B_OVER_A,
} from './geodesy';

interface RegionalTextureAsset {
  url: string;
  runtime_bytes: number;
  runtime_sha256: string;
  runtime_dimensions: number[];
}

export interface EarthLabels {
  station: HTMLElement;
  satellite: HTMLElement;
  sun: HTMLElement;
  target: HTMLElement;
}
export type EarthCameraMode = 'earth' | 'spacecraft';
export class EarthScene {
  private readonly scene = new Scene();
  private readonly renderer = createRenderer().renderer;
  private readonly camera = new PerspectiveCamera(34, 1, 0.001, 40);
  private readonly controls: OrbitControls;
  private readonly follow: SpacecraftFollow;
  private readonly followLink: FollowLink;
  private readonly sunDisplay: SunDisplay;
  private readonly targetDisplay = new TargetDisplay(this.renderer);
  private readonly groundTrack = new GroundTrackLayer(this.renderer.getPixelRatio());
  private groundTrackEnabled = false;
  private readonly followEarthCamera = new PerspectiveCamera(34, 1, 0.0001, 40);
  private cameraMode: EarthCameraMode = 'earth';
  private groundTargetPicker: ((positionEcefM: number[]) => void) | null = null;
  private pickStart: [number, number] | null = null;
  private pickDown = (event: PointerEvent) => {
    if (this.groundTargetPicker && this.cameraMode === 'earth' && event.button === 0)
      this.pickStart = [event.clientX, event.clientY];
  };
  private pickUp = (event: PointerEvent) => {
    const start = this.pickStart;
    this.pickStart = null;
    if (
      !start ||
      !this.groundTargetPicker ||
      this.cameraMode !== 'earth' ||
      Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 5 ||
      !this.earthMeshes[0]
    )
      return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const ray = new Raycaster();
    ray.setFromCamera(
      new Vector2(
        (2 * (event.clientX - bounds.left)) / bounds.width - 1,
        1 - (2 * (event.clientY - bounds.top)) / bounds.height,
      ),
      this.camera,
    );
    const point = ray.intersectObject(this.earthMeshes[0], false)[0]?.point;
    if (point)
      this.groundTargetPicker([point.x * WGS84_A_M, -point.z * WGS84_A_M, point.y * WGS84_A_M]);
  };
  setGroundTargetPicker(callback: ((positionEcefM: number[]) => void) | null) {
    this.groundTargetPicker = callback;
    this.controls.enabled = this.cameraMode === 'earth' && !callback;
    this.renderer.domElement.style.cursor = callback ? 'crosshair' : '';
  }
  private thermalView = false;
  setThermalView(enabled: boolean) {
    this.thermalView = enabled;
    this.updateSample(this.sampleIndex);
  }
  private readonly history = new Group();
  private readonly satelliteGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  );
  private readonly stationGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  );
  private readonly satelliteMaterial = new PointsMaterial({
    color: '#ef6771',
    size: 6,
    sizeAttenuation: false,
    depthTest: true,
  });
  private readonly stationMaterial = new PointsMaterial({
    color: '#e6e1d9',
    size: 4,
    sizeAttenuation: false,
    depthTest: true,
  });
  private readonly satellite = new Points(this.satelliteGeometry, this.satelliteMaterial);
  private readonly station = new Points(this.stationGeometry, this.stationMaterial);
  private readonly losGeometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
  );
  private readonly losSolidMaterial = new LineBasicMaterial({
    color: '#ef6771',
    transparent: true,
    opacity: 0.85,
  });
  private readonly losDashedMaterial = new LineDashedMaterial({
    color: '#e6e1d9',
    transparent: true,
    opacity: 0.8,
    dashSize: 0.018,
    gapSize: 0.012,
  });
  private readonly losSolid = new Line(this.losGeometry, this.losSolidMaterial);
  private readonly losDashed = new Line(this.losGeometry, this.losDashedMaterial);
  private appearance: EarthAppearance | null = null;
  private textures: Texture[] = [];
  private earthMeshes: Mesh[] = [];
  private regionalTexture: Texture | null = null;
  private regionalBitmap: ImageBitmap | null = null;
  private regionalAbort: AbortController | null = null;
  private regionalFailed = false;
  private cloudTiles: CloudTileLayer | null = null;
  private regionalUnusedSince = 0;
  private regionalNeededSince = 0;
  private snapshot: RunSnapshot | null = null;
  private stationPoint = new Vector3();
  private stationEcefM: number[] = [];
  private historySegments: number[] = [];
  private losSegment: number[] = [];
  private sceneExtent = 1.02;
  private sampleIndex = 0;
  private displayTimeSource: DisplayTimeSource | undefined;
  private lastDisplayTime = NaN;
  private stationNormal = new Vector3();
  private frame = 0;
  private disposed = false;
  private observer: ResizeObserver;
  private frameSize = new FrameSize();
  private autoFramed = false;
  private frameTimes: number[] = [];
  private lastFrame = 0;

  constructor(
    private host: HTMLElement,
    private labels: EarthLabels,
    private onLoad: (error?: string) => void,
    onFollowStatus?: (status: FollowStatus) => void,
  ) {
    this.sunDisplay = new SunDisplay(labels.sun);
    this.camera.position.set(-1.4, 1.6, 3.5);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.className = 'earth-canvas';
    canvas.setAttribute(
      'aria-label',
      'Earth pass view. Drag to orbit, right-drag to pan, scroll to zoom.',
    );
    canvas.dataset.renderer = `Three r${REVISION} / WebGL 2`;
    const gl = this.renderer.getContext();
    canvas.dataset.depthBits = String(gl.getParameter(gl.DEPTH_BITS));
    this.renderer.toneMappingExposure = 1.08;
    this.host.appendChild(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.06;
    this.controls.maxDistance = 10;
    this.controls.zoomToCursor = true;
    this.follow = new SpacecraftFollow(this.renderer, canvas, (status) => {
      canvas.dataset.followStatus = status.state;
      canvas.dataset.followRevision = status.revision;
      onFollowStatus?.(status);
    });
    this.follow.setEnabled(false);
    this.followLink = new FollowLink(
      this.renderer,
      this.losDashedMaterial.dashSize * WGS84_A_M,
      this.losDashedMaterial.gapSize * WGS84_A_M,
    );
    canvas.addEventListener('pointerdown', this.pickDown);
    canvas.addEventListener('pointerup', this.pickUp);
    canvas.dataset.cameraMode = 'earth';
    canvas.dataset.regionalImageryState = 'global-only';
    canvas.dataset.regionalImageryRevision = regionalImagery.revision;
    canvas.dataset.regionalImageryBounds = JSON.stringify(regionalImagery.bounds_deg);
    canvas.dataset.regionalImageryEpoch = regionalImagery.acquisition_epoch;
    canvas.dataset.regionalImagerySha256 = regionalImagery.runtime_sha256;
    canvas.dataset.cloudTileState = 'global-only';
    canvas.dataset.cloudTileRevision = cloudImagery.revision;
    canvas.dataset.cloudTileEpoch = cloudImagery.acquisition_epoch;
    canvas.dataset.cloudTileBudget = String(cloudTileBudget(this.renderer.capabilities));
    canvas.dataset.imageryProvenanceUrl = '/earth/asset-provenance.json';
    this.scene.add(
      this.history,
      this.satellite,
      this.station,
      this.losSolid,
      this.losDashed,
      this.targetDisplay.group,
      this.groundTrack.group,
    );
    this.history.visible = false;
    this.satellite.visible = false;
    this.station.visible = false;
    this.losSolid.visible = false;
    this.losDashed.visible = false;
    this.frameSize.request(this.host.clientWidth, this.host.clientHeight);
    this.observer = new ResizeObserver(() => {
      this.frameSize.request(this.host.clientWidth, this.host.clientHeight);
    });
    this.observer.observe(host);
    void this.load();
    this.frame = requestAnimationFrame(this.animate);
  }

  private async load() {
    const loader = new TextureLoader();
    const highResolution = this.renderer.capabilities.maxTextureSize >= 8192;
    this.renderer.domElement.dataset.mapResolution = highResolution
      ? '8192×4096'
      : '4096×2048 GPU fallback';
    const urls = [
      highResolution ? '/earth/earth-day-8k.jpg' : '/earth/earth-day-4k.jpg',
      highResolution ? '/earth/earth-clouds-8k.jpg' : '/earth/earth-clouds-4k.png',
      '/earth/earth-ocean-2k.png',
      highResolution ? '/earth/earth-night-8k.jpg' : '/earth/earth-night-2k.jpg',
    ];
    const results = await Promise.allSettled(urls.map((url) => loader.loadAsync(url)));
    const textures = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (this.disposed || results.slice(0, 3).some((result) => result.status === 'rejected')) {
      textures.forEach((texture) => texture.dispose());
      if (!this.disposed) this.onLoad('Earth imagery unavailable');
      return;
    }
    this.textures = textures;
    textures.forEach((texture, i) => {
      texture.colorSpace = i === 0 || i === 3 ? SRGBColorSpace : NoColorSpace;
      texture.flipY = true;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 16);
      texture.needsUpdate = true;
    });
    this.renderer.domElement.dataset.nightLights = textures[3]
      ? highResolution
        ? '8192x4096'
        : '2048x1024'
      : 'unavailable';
    const tileBudget = cloudTileBudget(this.renderer.capabilities);
    this.appearance = createEarthAppearance(
      textures[0],
      textures[1],
      textures[2],
      tileBudget,
      textures[3] || null,
    );
    this.cloudTiles = new CloudTileLayer(
      tileBudget,
      (tiles) => this.appearance?.setCloudTiles(tiles),
      this.renderer.domElement.dataset,
      (asset, signal) =>
        readCloudTile(asset, signal, this.renderer.capabilities.getMaxAnisotropy()),
    );
    const surface = new Mesh(earthGeometry(), this.appearance.surface);
    const clouds = new Mesh(earthGeometry(8000), this.appearance.clouds);
    clouds.renderOrder = 1;
    const atmosphere = new Mesh(earthGeometry(80000, 128, 64), this.appearance.atmosphere);
    atmosphere.renderOrder = 2;
    this.earthMeshes = [surface, clouds, atmosphere];
    this.scene.add(...this.earthMeshes);
    this.updateSample(this.sampleIndex);
    this.onLoad();
  }

  setHistory(snapshot: RunSnapshot | null) {
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.clearHistory();
    this.targetDisplay.clear();
    this.labels.target.hidden = true;
    this.historySegments = [];
    this.losSegment = [];
    this.sceneExtent = 1.02;
    const samples = snapshot?.run.result?.samples;
    const stepS = snapshot?.scenario.step_s;
    this.groundTrack.setSamples(
      samples?.satellite_position_ecef_m.length ? samples : undefined,
      stepS && Number.isFinite(stepS) && stepS > 0 ? 3 * stepS : Infinity,
    );
    if (!snapshot || !samples?.satellite_position_ecef_m.length) {
      this.history.visible = false;
      this.station.visible = false;
      this.satellite.visible = false;
      return;
    }
    const station = snapshot.scenario.station;
    this.stationEcefM = geodeticToEcef(
      station.latitude_deg,
      station.longitude_deg,
      station.height_m,
    );
    this.stationPoint.fromArray(ecefToDisplay(this.stationEcefM));
    const lat = (station.latitude_deg * Math.PI) / 180,
      lon = (station.longitude_deg * Math.PI) / 180;
    this.stationNormal.set(
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      -Math.cos(lat) * Math.sin(lon),
    );
    this.station.position.copy(this.stationPoint);
    const above: number[] = [],
      below: number[] = [];
    for (let i = 1; i < samples.satellite_position_ecef_m.length; i++) {
      const a = samples.satellite_position_ecef_m[i - 1],
        b = samples.satellite_position_ecef_m[i];
      if (
        a?.length !== 3 ||
        b?.length !== 3 ||
        !a.every(Number.isFinite) ||
        !b.every(Number.isFinite)
      )
        continue;
      (samples.visible[i - 1] && samples.visible[i] ? above : below).push(
        ...ecefToDisplay(a),
        ...ecefToDisplay(b),
      );
    }
    this.historySegments = [...above, ...below];
    for (let i = 0; i < this.historySegments.length; i += 3)
      this.sceneExtent = Math.max(
        this.sceneExtent,
        Math.hypot(
          this.historySegments[i],
          this.historySegments[i + 1],
          this.historySegments[i + 2],
        ),
      );
    this.sceneExtent = Math.max(this.sceneExtent, this.stationPoint.length());
    for (const [vertices, color, opacity] of [
      [below, '#706b65', 0.34],
      [above, '#e6e1d9', 0.66],
    ] as const) {
      const geometry = new BufferGeometry().setAttribute(
        'position',
        new Float32BufferAttribute(vertices, 3),
      );
      const line = new LineSegments(
        geometry,
        new LineBasicMaterial({ color, transparent: true, opacity }),
      );
      this.history.add(line);
    }
    this.history.visible = !this.groundTrackEnabled;
    this.station.visible = true;
    this.renderer.domElement.dataset.runId = snapshot.run.run_id;
    if (!this.autoFramed) {
      this.globe();
      this.autoFramed = true;
    }
    this.updateSample(this.sampleIndex);
  }

  setDisplayTimeSource(source?: DisplayTimeSource) {
    this.displayTimeSource = source;
    this.lastDisplayTime = NaN;
    if (!source) this.updateSample(this.sampleIndex);
  }

  updateSample(index: number, displayTimeS?: number) {
    displayTimeS ??= this.displayTimeSource?.current;
    if (displayTimeS === undefined) this.lastDisplayTime = NaN;
    this.sampleIndex = index;
    const snapshot = this.snapshot,
      samples = snapshot?.run.result?.samples;
    const bracket =
      samples && displayTimeS !== undefined ? displayBracket(samples.time_s, displayTimeS) : null;
    index = bracket?.lower ?? index;
    const p = bracket
      ? interpolateVector3(
          samples!.satellite_position_ecef_m[bracket.lower],
          samples!.satellite_position_ecef_m[bracket.upper],
          bracket.alpha,
        )
      : samples?.satellite_position_ecef_m[index];
    if (!snapshot || !samples || !p || p.length !== 3 || !p.every(Number.isFinite)) {
      this.sunDisplay.clear();
      this.targetDisplay.clear();
      this.labels.target.hidden = true;
      this.satellite.visible = false;
      this.losSolid.visible = false;
      this.losDashed.visible = false;
      this.followLink.clear();
      this.losSegment = [];
      this.labels.satellite.hidden = true;
      this.labels.station.hidden = true;
      this.groundTrack.group.visible = false;
      return;
    }
    this.satellite.position.fromArray(ecefToDisplay(p));
    this.satellite.visible = true;
    const visualTime = bracket?.time ?? samples.time_s[index];
    this.groundTrack.updateSample(index, p, visualTime);
    const sunEcef = samples.sun_direction_ecef
      ? bracket
        ? interpolateVector3(
            samples.sun_direction_ecef[bracket.lower],
            samples.sun_direction_ecef[bracket.upper],
            bracket.alpha,
          )
        : samples.sun_direction_ecef[index]
      : null;
    const sun = sunEcef
      ? (new Vector3(sunEcef[0], sunEcef[2], -sunEcef[1]).normalize().toArray() as [
          number,
          number,
          number,
        ])
      : visualSunDirection(snapshot.scenario.epoch_utc, visualTime);
    this.appearance?.setSun(sun);
    this.follow.setSun(sun);
    this.sunDisplay.setDirection(sun);
    this.follow.setPosition(p);
    this.targetDisplay.setTarget(
      p,
      activeTargetAtSample(samples.pointing_target_ecef_m, bracket?.lower ?? index),
    );
    const nodeTemperatures = samples.thermal?.node_temperature_k;
    this.follow.setTemperatures(
      this.thermalView && nodeTemperatures
        ? Object.fromEntries(
            Object.entries(nodeTemperatures).map(([node, values]) => [
              node,
              bracket
                ? values[bracket.lower] +
                  (values[bracket.upper] - values[bracket.lower]) * bracket.alpha
                : values[index],
            ]),
          )
        : undefined,
    );
    const inertialStation = bracket
      ? interpolateVector3(
          samples.station_position_m[bracket.lower],
          samples.station_position_m[bracket.upper],
          bracket.alpha,
        )
      : samples.station_position_m[index];
    const angle =
      inertialStation?.length === 3
        ? Math.atan2(-this.stationPoint.z, this.stationPoint.x) -
          Math.atan2(inertialStation[1], inertialStation[0])
        : undefined;
    const pose = bracket
      ? interpolateQuaternion(
          samples.q_body_from_inertial_wxyz[bracket.lower],
          samples.q_body_from_inertial_wxyz[bracket.upper],
          bracket.alpha,
        )
      : samples.q_body_from_inertial_wxyz[index];
    if (pose) this.follow.setPose(pose, visualTime, snapshot.scenario.duration_s, angle);
    const direction = samples.active_direction[index];
    const positive = linkDisplayState(samples, index) === 'RF OPPORTUNITY';
    const color = positive
      ? direction === 'uplink'
        ? '#ef6771'
        : '#e6e1d9'
      : samples.visible[index]
        ? '#a77b51'
        : '#77706b';
    this.losSolidMaterial.color.set(color);
    this.losDashedMaterial.color.set(color);
    const segment = this.followLink.setLink(
      p,
      this.stationEcefM,
      color,
      positive && direction === 'uplink',
    );
    const position = this.losGeometry.getAttribute('position');
    position.setXYZ(0, 0, 0, 0);
    const delta = segment?.deltaDisplayM || [0, 0, 0];
    this.losSegment = segment
      ? [
          this.satellite.position.x,
          this.satellite.position.y,
          this.satellite.position.z,
          this.satellite.position.x + delta[0] / WGS84_A_M,
          this.satellite.position.y + delta[1] / WGS84_A_M,
          this.satellite.position.z + delta[2] / WGS84_A_M,
        ]
      : [];
    position.setXYZ(1, delta[0] / WGS84_A_M, delta[1] / WGS84_A_M, delta[2] / WGS84_A_M);
    position.needsUpdate = true;
    // Rebase before Float32 conversion. The origin and dash phase are at SC.
    this.losSolid.position.copy(this.satellite.position);
    this.losDashed.position.copy(this.satellite.position);
    this.losGeometry.computeBoundingSphere();
    this.losDashed.computeLineDistances();
    this.losSolid.visible = !!segment && positive && direction === 'uplink';
    this.losDashed.visible = !!segment && !this.losSolid.visible;
    this.renderer.domElement.dataset.sampleIndex = String(index);
    this.renderer.domElement.dataset.elapsedSeconds = String(samples.time_s[index]);
    this.renderer.domElement.dataset.displayTimeSeconds = String(visualTime);
    this.renderer.domElement.dataset.displayInterpolation =
      bracket && bracket.lower !== bracket.upper
        ? `${bracket.lower}:${bracket.upper}:${bracket.alpha.toFixed(6)}`
        : 'sample';
  }

  setAsset(variant: Variant, asset?: AssetInfo) {
    void this.follow.setAsset(variant, asset);
  }
  setGroundTrack(enabled: boolean, windowSeconds = 10800) {
    const enabling = enabled && !this.groundTrackEnabled;
    this.groundTrackEnabled = enabled;
    if (enabling) this.setCameraMode('earth');
    this.groundTrack.setEnabled(enabled && this.cameraMode === 'earth', windowSeconds);
    this.history.visible = !enabled && this.history.children.length > 0;
    this.renderer.domElement.dataset.groundTrack = String(enabled);
    this.renderer.domElement.dataset.groundTrackWindowSeconds = String(windowSeconds);
    this.updateSample(this.sampleIndex);
  }
  setCameraMode(mode: EarthCameraMode) {
    this.cameraMode = mode;
    this.controls.enabled = mode === 'earth' && !this.groundTargetPicker;
    this.follow.setEnabled(mode === 'spacecraft');
    this.groundTrack.setEnabled(this.groundTrackEnabled && mode === 'earth');
    this.renderer.domElement.dataset.cameraMode = mode;
    this.renderer.domElement.setAttribute(
      'aria-label',
      mode === 'earth'
        ? 'Earth pass view. Drag to orbit, right-drag to pan, scroll to zoom.'
        : 'Follow spacecraft. Drag to orbit the spacecraft; scroll to dolly. The spacecraft stays centered.',
    );
  }
  resetFollow = () => {
    this.follow.resetView();
  };

  globe = () => {
    this.controls.target.set(0, 0, 0);
    if (this.snapshot) {
      const east = new Vector3(this.stationNormal.z, 0, -this.stationNormal.x).normalize();
      const vertical = (this.camera.fov * Math.PI) / 360;
      const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
      const distance = 1.28 / Math.sin(Math.min(vertical, horizontal));
      this.camera.position
        .copy(this.stationNormal)
        .addScaledVector(east, -0.18)
        .normalize()
        .multiplyScalar(distance);
    } else this.camera.position.set(-1.4, 1.6, 3.5);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  };

  focusStation = () => {
    if (!this.snapshot) return;
    const east = new Vector3(this.stationNormal.z, 0, -this.stationNormal.x).normalize();
    const north = new Vector3().crossVectors(this.stationNormal, east).normalize();
    this.controls.target.copy(this.stationPoint).multiplyScalar(0.9);
    this.camera.position
      .copy(this.stationPoint)
      .addScaledVector(this.stationNormal, 0.95)
      .addScaledVector(east, -0.34)
      .addScaledVector(north, 0.2);
    this.camera.up.copy(north);
    this.controls.update();
  };

  fitPass = () => {
    if (!this.snapshot) {
      this.globe();
      return;
    }
    // Camera framing changes no history, sample index or authoritative position.
    this.controls.target.copy(this.stationNormal).multiplyScalar(0.5);
    const east = new Vector3(this.stationNormal.z, 0, -this.stationNormal.x).normalize();
    this.camera.position.copy(this.stationNormal).multiplyScalar(3.0).addScaledVector(east, -0.6);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  };

  private placeLabel(element: HTMLElement, position: Vector3, camera = this.camera) {
    if (isEarthOccluded(camera.position.toArray(), position.toArray())) {
      element.hidden = true;
      return;
    }
    const screen = position.clone().project(camera);
    element.hidden =
      screen.z > 1 || screen.z < -1 || Math.abs(screen.x) > 1 || Math.abs(screen.y) > 1;
    element.style.transform = `translate(${(screen.x * 0.5 + 0.5) * this.host.clientWidth}px,${(-screen.y * 0.5 + 0.5) * this.host.clientHeight}px)`;
  }

  private animate = (now: number) => {
    if (this.disposed) return;
    // Resizing clears the drawing buffer. Do it only in the frame that redraws it.
    this.frameSize.apply((width, height) => {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.follow.setSize(width, height);
    });
    const displayTime = this.displayTimeSource?.current;
    if (displayTime !== undefined && displayTime !== this.lastDisplayTime) {
      this.updateSample(this.sampleIndex, displayTime);
      this.lastDisplayTime = displayTime;
    }
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    const follow =
      this.cameraMode === 'spacecraft' &&
      !!this.snapshot?.run.result?.samples.satellite_position_ecef_m[this.sampleIndex];
    let activeCamera = this.camera;
    let closeFollow = false;
    if (follow) {
      this.follow.update(dt);
      this.clipFollowCamera();
      const local = this.follow.camera;
      // Keep the existing 5.1km history-display threshold independent of adaptive depth.
      closeFollow = local.position.length() < 0.0008 * WGS84_A_M;
      this.followEarthCamera.position
        .copy(this.satellite.position)
        .addScaledVector(local.position, 1 / WGS84_A_M);
      this.followEarthCamera.quaternion.copy(local.quaternion);
      this.followEarthCamera.up.copy(local.up);
      this.followEarthCamera.fov = local.fov;
      this.followEarthCamera.aspect = local.aspect;
      this.followEarthCamera.updateProjectionMatrix();
      this.followEarthCamera.updateMatrixWorld();
      activeCamera = this.followEarthCamera;
      this.satellite.visible = false;
    } else {
      this.controls.update();
      if (this.camera.position.length() < 1.025) this.camera.position.setLength(1.025);
      this.satellite.visible =
        !!this.snapshot?.run.result?.samples.satellite_position_ecef_m[this.sampleIndex];
    }
    this.history.visible =
      this.history.children.length > 0 && !closeFollow && !this.groundTrackEnabled;
    this.groundTrack.updateCamera(activeCamera);
    this.fitDepthRange(activeCamera, !follow);
    if (follow) {
      // The local pass owns the LOS before the adaptive background near plane.
      // If its conservative Earth gate declines, fit the background to the full LOS.
      let nearLink = this.followLink.update(this.follow.camera, activeCamera.near);
      let nearTarget = this.targetDisplay.updateNear(this.follow.camera, activeCamera.near);
      if (!nearLink || (this.targetDisplay.group.visible && !nearTarget)) {
        this.fitDepthRange(activeCamera, true);
        nearLink = this.followLink.update(this.follow.camera, activeCamera.near);
        nearTarget = this.targetDisplay.updateNear(this.follow.camera, activeCamera.near);
      }
      this.renderer.domElement.dataset.followNearLinkActive = String(nearLink);
      this.renderer.domElement.dataset.followNearTargetActive = String(nearTarget);
    }
    this.renderer.domElement.dataset.earthNear = activeCamera.near.toPrecision(6);
    this.renderer.domElement.dataset.earthFar = activeCamera.far.toPrecision(6);
    this.renderer.domElement.dataset.followHistoryVisible = String(this.history.visible);
    if (this.groundTrackEnabled) {
      const track = this.groundTrack.statistics;
      this.renderer.domElement.dataset.groundTrackSamples = String(track.pointCount);
      this.renderer.domElement.dataset.groundTrackMarkers = String(track.markerCount);
      this.renderer.domElement.dataset.groundTrackOmittedMarkers = String(track.omittedMarkerCount);
      this.renderer.domElement.dataset.groundTrackStartSeconds = String(track.windowStartS ?? '');
      this.renderer.domElement.dataset.groundTrackEndSeconds = String(track.windowEndS ?? '');
    }
    if (this.station.visible)
      this.placeLabel(this.labels.station, this.station.position, activeCamera);
    else this.labels.station.hidden = true;
    if (this.satellite.visible)
      this.placeLabel(this.labels.satellite, this.satellite.position, activeCamera);
    else this.labels.satellite.hidden = true;
    if (this.targetDisplay.group.visible)
      this.placeLabel(this.labels.target, this.targetDisplay.marker.position, activeCamera);
    else this.labels.target.hidden = true;
    this.renderer.domElement.dataset.pointingTargetActive = String(
      this.targetDisplay.group.visible,
    );
    this.updateRegionalImagery(activeCamera, now);
    this.sunDisplay.updateCue(activeCamera, this.host.clientWidth, this.host.clientHeight);
    const autoClear = this.renderer.autoClear;
    try {
      this.renderer.autoClear = true;
      this.sunDisplay.renderBackground(this.renderer, activeCamera);
      this.renderer.autoClear = false;
      // Opaque Earth and spacecraft cover the solar disk in their own depth ranges.
      this.renderer.render(this.scene, activeCamera);
      if (follow) {
        this.renderer.clearDepth();
        this.followLink.render();
        this.targetDisplay.renderNear();
        this.renderer.clearDepth();
        this.follow.render();
      }
    } finally {
      this.renderer.autoClear = autoClear;
    }
    this.renderer.domElement.dataset.followModelVisible = String(
      follow && this.follow.modelVisible,
    );
    if (this.lastFrame) {
      this.frameTimes.push(now - this.lastFrame);
      if (this.frameTimes.length === 120) {
        this.renderer.domElement.dataset.meanFrameMs = (
          this.frameTimes.reduce((a, b) => a + b, 0) / 120
        ).toFixed(2);
        this.frameTimes = [];
      }
    }
    this.lastFrame = now;
    this.frame = requestAnimationFrame(this.animate);
  };

  private fitDepthRange(camera: PerspectiveCamera, includeLos: boolean) {
    const groups = [
      this.history.visible ? this.historySegments : [],
      includeLos && (this.losSolid.visible || this.losDashed.visible) ? this.losSegment : [],
      includeLos ? this.targetDisplay.backgroundSegment : [],
    ];
    const points = [];
    if (this.station.visible) points.push(this.station.position);
    if (this.satellite.visible) points.push(this.satellite.position);
    if (this.targetDisplay.group.visible) points.push(this.targetDisplay.marker.position);
    const range = earthDepthRange(
      camera.position,
      camera.getEffectiveFOV(),
      camera.aspect,
      this.sceneExtent,
      groups,
      points,
    );
    camera.near = range.near;
    camera.far = range.far;
    camera.updateProjectionMatrix();
  }

  private updateRegionalImagery(camera: PerspectiveCamera, now: number) {
    if (!this.appearance) return;
    const radius = camera.position.length();
    const bounds = regionalImagery.bounds_deg;
    const latitude = ((bounds.south + bounds.north) * Math.PI) / 360;
    const longitude = ((bounds.west + bounds.east) * Math.PI) / 360;
    const regionDot =
      (camera.position.x * Math.cos(latitude) * Math.cos(longitude) +
        camera.position.y * Math.sin(latitude) -
        camera.position.z * Math.cos(latitude) * Math.sin(longitude)) /
      radius;
    const close = Math.max(0, Math.min(1, (2.2 - radius) / 0.85));
    const weight = close * close * (3 - 2 * close);
    const desired =
      weight > 0.01 &&
      regionDot > 0.55 &&
      !document.hidden &&
      this.host.clientWidth > 0 &&
      this.host.clientHeight > 0;
    this.cloudTiles?.update(
      camera.position,
      !document.hidden && this.host.clientWidth > 0 && this.host.clientHeight > 0 ? weight : 0,
      now,
    );
    if (!desired) {
      this.regionalNeededSince = 0;
      this.regionalAbort?.abort();
      this.appearance.setRegionalOpacity(0);
      this.renderer.domElement.dataset.regionalImageryMix = '0';
      if (!this.regionalUnusedSince) this.regionalUnusedSince = now;
      if (this.regionalTexture && now - this.regionalUnusedSince > 15000)
        this.releaseRegionalImagery();
      return;
    }
    this.regionalUnusedSince = 0;
    if (!this.regionalNeededSince) this.regionalNeededSince = now;
    if (
      !this.regionalTexture &&
      !this.regionalAbort &&
      !this.regionalFailed &&
      now - this.regionalNeededSince > 250 &&
      this.renderer.capabilities.maxTextureSize >= 4096
    ) {
      void this.loadRegionalImagery();
    }
    this.appearance.setRegionalOpacity(this.regionalTexture ? weight : 0);
    this.renderer.domElement.dataset.regionalImageryMix = this.regionalTexture
      ? weight.toFixed(3)
      : '0';
  }

  private async readRegionalBitmap(
    source: RegionalTextureAsset,
    controller: AbortController,
    mime: string,
  ) {
    const response = await fetch(source.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Regional imagery HTTP${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== source.runtime_bytes)
      throw new Error('Regional imagery size mismatch');
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== source.runtime_sha256) throw new Error('Regional imagery hash mismatch');
    if (controller.signal.aborted || this.disposed) return null;
    // ImageBitmap ignores WebGL unpack flipY; orient data once at decode.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), {
      imageOrientation: 'flipY',
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    if (controller.signal.aborted || this.disposed) {
      bitmap.close();
      return null;
    }
    if (
      bitmap.width !== source.runtime_dimensions[0] ||
      bitmap.height !== source.runtime_dimensions[1]
    ) {
      bitmap.close();
      throw new Error('Regional imagery dimensions mismatch');
    }
    return bitmap;
  }

  private createRegionalTexture(bitmap: ImageBitmap) {
    const texture = new Texture(bitmap);
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 16);
    texture.needsUpdate = true;
    return texture;
  }

  private async loadRegionalImagery() {
    const controller = new AbortController();
    this.regionalAbort = controller;
    this.renderer.domElement.dataset.regionalImageryState = 'loading';
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await this.readRegionalBitmap(regionalImagery, controller, 'image/jpeg');
      if (!bitmap) return;
      const texture = this.createRegionalTexture(bitmap);
      this.regionalTexture = texture;
      this.regionalBitmap = bitmap;
      const b = regionalImagery.bounds_deg;
      this.appearance?.setRegionalMap(texture, [
        (b.west + 180) / 360,
        (b.south + 90) / 180,
        (b.east + 180) / 360,
        (b.north + 90) / 180,
      ]);
      this.renderer.domElement.dataset.regionalImageryState = 'ready';
    } catch (error) {
      bitmap?.close();
      if (!controller.signal.aborted && !this.disposed) {
        this.regionalFailed = true;
        this.renderer.domElement.dataset.regionalImageryState = 'unavailable';
        this.renderer.domElement.dataset.regionalImageryError =
          error instanceof Error ? error.message : 'Regional imagery unavailable';
      }
    } finally {
      if (this.regionalAbort === controller) this.regionalAbort = null;
      if (controller.signal.aborted && !this.disposed && !this.regionalTexture)
        this.renderer.domElement.dataset.regionalImageryState = 'global-only';
    }
  }

  private releaseRegionalImagery() {
    this.appearance?.setRegionalMap(null);
    this.regionalTexture?.dispose();
    this.regionalBitmap?.close();
    this.regionalTexture = null;
    this.regionalBitmap = null;
    this.renderer.domElement.dataset.regionalImageryState = 'global-only';
  }

  private clipFollowCamera() {
    // Keep the local camera on the spacecraft side of the opaque ellipsoid.
    // This is a view collision only; spacecraft/sample positions are never changed.
    const scale = WGS84_A_M,
      b = WGS84_B_OVER_A,
      origin = this.satellite.position;
    const offset = this.follow.camera.position;
    const ox = origin.x,
      oy = origin.y / b,
      oz = origin.z;
    const dx = offset.x / scale,
      dy = offset.y / (scale * b),
      dz = offset.z / scale;
    const a = dx * dx + dy * dy + dz * dz;
    if (a < 1e-20) return;
    const q = 2 * (ox * dx + oy * dy + oz * dz),
      c = ox * ox + oy * oy + oz * oz - 1.0002 ** 2;
    const discriminant = q * q - 4 * a * c;
    if (discriminant <= 0) return;
    const hit = (-q - Math.sqrt(discriminant)) / (2 * a);
    if (hit > 0 && hit < 1) {
      offset.multiplyScalar(Math.max(0, hit * 0.999));
      this.follow.camera.lookAt(0, 0, 0);
      const distance = offset.length();
      this.follow.camera.near = Math.min(
        this.follow.camera.near,
        Math.max(0.00005, distance * 0.25),
      );
      this.follow.camera.far = Math.max(this.follow.camera.far, distance * 1.5);
      this.follow.camera.updateProjectionMatrix();
      this.follow.camera.updateMatrixWorld();
    }
  }

  private clearHistory() {
    this.history.children.forEach((child) => {
      if (child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as LineBasicMaterial).dispose();
      }
    });
    this.history.clear();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pickDown);
    this.renderer.domElement.removeEventListener('pointerup', this.pickUp);
    this.controls.dispose();
    this.follow.dispose();
    this.followLink.dispose();
    this.sunDisplay.dispose();
    this.targetDisplay.dispose();
    this.groundTrack.dispose();
    this.regionalAbort?.abort();
    this.releaseRegionalImagery();
    this.cloudTiles?.dispose();
    this.clearHistory();
    this.earthMeshes.forEach((mesh) => mesh.geometry.dispose());
    this.appearance?.dispose();
    this.textures.forEach((texture) => texture.dispose());
    this.satelliteGeometry.dispose();
    this.stationGeometry.dispose();
    this.losGeometry.dispose();
    this.satelliteMaterial.dispose();
    this.stationMaterial.dispose();
    this.losSolidMaterial.dispose();
    this.losDashedMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export const EARTH_RENDER_SCALE_M = WGS84_A_M;
