import { useEffect, useRef, useState } from 'react';
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRenderer } from '../graphics/renderer';
import type { AssetInfo, Variant } from '../types';
import { NominalPreview } from './NominalPreview';
import type { NominalGeometryStatus } from './NominalPreview';
import type { AntennaModel, Pattern, Probe, RadiusMode } from './types';

const FLOOR_DB = -30;
const palette = ['#253747', '#438b9b', '#d8c384', '#cc344d'].map((value) => new Color(value));
export function gainRadius(gain: number, peak: number, mode: RadiusMode) {
  const ratio = peak > 0 ? Math.max(0, Math.min(1, gain / peak)) : 0;
  return mode === 'linear'
    ? ratio
    : Math.max(0, (10 * Math.log10(Math.max(ratio, 1e-30)) - FLOOR_DB) / -FLOOR_DB);
}
function gainColor(gain: number, peak: number) {
  const t = gainRadius(gain, peak, 'db') * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(t));
  return palette[i].clone().lerp(palette[i + 1], t - i);
}
function label(text: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.font = '32px monospace';
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 64, 32);
  const sprite = new Sprite(
    new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false }),
  );
  sprite.scale.set(0.24, 0.12, 1);
  return sprite;
}
function disposeGroup(group: Group) {
  group.traverse((object) => {
    if (object instanceof Mesh || object instanceof Line) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
    if (object instanceof Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
  });
  group.clear();
}

export function LobeView({
  pattern,
  probe,
  mode,
  loading,
  variant,
  asset,
  model,
  geometryVisible,
  lobeVisible,
  lobeOpacity,
  focusRequest,
}: {
  pattern: Pattern | null;
  probe: Probe | null;
  mode: RadiusMode;
  loading: boolean;
  variant: Variant;
  asset?: AssetInfo;
  model: AntennaModel;
  geometryVisible: boolean;
  lobeVisible: boolean;
  lobeOpacity: number;
  focusRequest: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const sceneHandle = useRef<{
    lobe: Group;
    probe: Group;
    preview: NominalPreview;
    reset: () => void;
    focus: () => void;
  } | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const [geometryStatus, setGeometryStatus] = useState<NominalGeometryStatus>({
    state: 'loading',
    revision: 'Revision unverified',
    selectedParts: 0,
  });
  const [error, setError] = useState('');
  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let renderer: ReturnType<typeof createRenderer>['renderer'];
    try {
      renderer = createRenderer().renderer;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '3D renderer unavailable');
      return;
    }
    const scene = new Scene();
    scene.background = new Color('#131315');
    const camera = new PerspectiveCamera(38, 1, 0.02, 20);
    camera.up.set(0, 0, 1);
    const reset = () => {
      camera.position.set(2.6, modelRef.current === 'patch' ? 3.1 : -3.1, 2.1);
      controls.target.set(0, 0, 0);
      controls.update();
    };
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      'aria-label',
      'Analytical gain lobe and nominal spacecraft antenna in body axes. Drag to orbit, scroll to zoom, right-drag to pan.',
    );
    host.appendChild(canvas);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = 0.7;
    controls.maxDistance = 9;
    reset();
    scene.add(new HemisphereLight('#f4efe9', '#414253', 2.1));
    const light = new DirectionalLight('#fff5e6', 1.5);
    light.position.set(2, -3, 4);
    scene.add(light);
    const pmrem = new PMREMGenerator(renderer),
      room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.65;
    const axes = new Group();
    scene.add(axes);
    const coordinates: [string, [number, number, number], string][] = [
      ['+X', [1.35, 0, 0], '#ec7b85'],
      ['+Y', [0, 1.35, 0], '#b8c5a0'],
      ['+Z', [0, 0, 1.35], '#9aaccd'],
    ];
    for (const [name, endpoint, color] of coordinates) {
      const geometry = new BufferGeometry().setFromPoints([
        new Vector3(),
        new Vector3(...endpoint),
      ]);
      axes.add(
        new Line(geometry, new LineBasicMaterial({ color, transparent: true, opacity: 0.65 })),
      );
      const sprite = label(name, color);
      sprite.position.set(...endpoint);
      axes.add(sprite);
    }
    const lobe = new Group(),
      probeGroup = new Group();
    const preview = new NominalPreview(setGeometryStatus);
    scene.add(lobe, probeGroup, preview.group);
    const focus = () => {
      const sphere = preview.selectionSphere();
      if (!sphere) return;
      controls.target.copy(sphere.center);
      const direction = new Vector3(0.45, modelRef.current === 'patch' ? 1 : -1, 0.35).normalize();
      const distance = Math.max(
        0.8,
        (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.3,
      );
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      controls.update();
    };
    sceneHandle.current = { lobe, probe: probeGroup, preview, reset, focus };
    const resize = new ResizeObserver(() => {
      camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resize.observe(host);
    let animation = 0;
    const render = () => {
      controls.update();
      if (preview.group.visible) preview.update(camera, canvas.height);
      // Include the normalized shell and axes as well as the SI-derived preview.
      const distance = camera.position.length();
      const near = Math.min(camera.near, Math.max(0.005, (distance - 1.6) * 0.8));
      const far = Math.max(camera.far, distance + 1.65);
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      animation = requestAnimationFrame(render);
    };
    render();
    return () => {
      cancelAnimationFrame(animation);
      resize.disconnect();
      controls.dispose();
      disposeGroup(lobe);
      disposeGroup(probeGroup);
      disposeGroup(axes);
      preview.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      canvas.remove();
      sceneHandle.current = null;
    };
  }, []);
  useEffect(() => {
    void sceneHandle.current?.preview.load(variant, asset, model);
  }, [variant, asset?.url, asset?.sha256, asset?.revision, asset?.available, model]);
  useEffect(() => {
    sceneHandle.current?.reset();
  }, [model]);
  useEffect(() => {
    if (focusRequest > 0) sceneHandle.current?.focus();
  }, [focusRequest, geometryStatus.state]);
  useEffect(() => {
    const handle = sceneHandle.current;
    if (handle) {
      handle.preview.group.visible = geometryVisible;
      handle.lobe.visible = lobeVisible && model !== 'v45';
    }
  }, [geometryVisible, lobeVisible, model]);
  useEffect(() => {
    const handle = sceneHandle.current;
    if (!handle) return;
    disposeGroup(handle.lobe);
    const grid = pattern?.grid;
    if (!grid) return;
    const peak = pattern.peak_gain_linear || 0;
    const positions: number[] = [],
      colors: number[] = [],
      indices: number[] = [];
    grid.directions_body.forEach((direction, index) => {
      const radius = gainRadius(grid.gain_linear[index], peak, mode);
      positions.push(...direction.map((value) => value * radius));
      const color = gainColor(grid.gain_linear[index], peak);
      colors.push(color.r, color.g, color.b);
    });
    const width = grid.azimuth_steps + 1;
    for (let i = 0; i < grid.polar_steps; i++)
      for (let j = 0; j < grid.azimuth_steps; j++) {
        const a = i * width + j,
          b = a + width;
        if (i > 0) indices.push(a, b, a + 1);
        if (i < grid.polar_steps - 1) indices.push(b, b + 1, a + 1);
      }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    handle.lobe.add(
      new Mesh(
        geometry,
        new MeshStandardMaterial({
          vertexColors: true,
          side: DoubleSide,
          roughness: 0.68,
          metalness: 0.02,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        }),
      ),
    );
  }, [pattern, mode]);
  useEffect(() => {
    sceneHandle.current?.lobe.traverse((object) => {
      if (object instanceof Mesh && object.material instanceof MeshStandardMaterial)
        object.material.opacity = lobeOpacity;
    });
  }, [pattern, mode, lobeOpacity]);
  useEffect(() => {
    const handle = sceneHandle.current;
    if (!handle) return;
    disposeGroup(handle.probe);
    if (!probe) return;
    const direction = new Vector3(
      probe.direction_body[0],
      probe.direction_body[1],
      probe.direction_body[2],
    ).normalize();
    handle.probe.add(
      new Line(
        new BufferGeometry().setFromPoints([new Vector3(), direction.clone().multiplyScalar(1.17)]),
        new LineBasicMaterial({
          color: '#f5eee7',
          depthTest: false,
          transparent: true,
          opacity: 0.8,
        }),
      ),
    );
    const marker = new Mesh(
      new SphereGeometry(0.022, 16, 12),
      new MeshBasicMaterial({ color: '#fffaf2', depthTest: false }),
    );
    marker.position
      .copy(direction)
      .multiplyScalar(gainRadius(probe.gain_linear || 0, pattern?.peak_gain_linear || 0, mode));
    marker.renderOrder = 2;
    handle.probe.add(marker);
  }, [probe, pattern, mode]);
  return (
    <div className="antenna-lobe">
      <div className="antenna-canvas" ref={mount} />
      <div className="antenna-lobe-caption">
        <span>BODY FRAME</span>
        <strong>
          {mode === 'linear' ? 'Radius = G / sampled Gmax' : 'Radius = relative gain, −30 to 0 dB'}
        </strong>
        <small>Shape scale is normalized. No physical distance.</small>
      </div>
      <div
        className="antenna-geometry-caption"
        aria-live="polite"
        title="Existing GLB in its nominal mount. Geometry is uniformly scaled for inspection; the lobe has no metre radius. Pattern rotation does not articulate this spacecraft."
      >
        <strong>Nominal geometry</strong>
        <span>
          {geometryStatus.state === 'ready'
            ? `${variant} · ${geometryStatus.selectedParts} highlighted ${model === 'patch' ? 'radiator' : 'conductors'}`
            : geometryStatus.state === 'loading'
              ? 'Loading physical antenna'
              : 'Physical model unavailable'}
        </span>
        <small>{geometryStatus.revision}</small>
        {geometryStatus.state === 'unavailable' ? (
          <button
            onClick={() => {
              void sceneHandle.current?.preview.load(variant, asset, model, true);
            }}
            title={geometryStatus.error}
          >
            Retry geometry
          </button>
        ) : null}
      </div>
      <div className="antenna-color-key">
        <span>−30 dB</span>
        <i />
        <span>0 dB</span>
      </div>
      <button className="antenna-reset" onClick={() => sceneHandle.current?.reset()}>
        Reset view
      </button>
      {loading ? (
        <div className="antenna-loading">
          <span className="spinner" />
          Sampling core pattern
        </div>
      ) : null}
      {error ? (
        <div className="antenna-empty" role="alert">
          {error}
        </div>
      ) : model === 'v45' ? (
        <div className="antenna-unresolved">
          <strong>
            V / tape{' '}
            {geometryStatus.state === 'ready' && geometryVisible ? 'geometry' : 'reference'}
          </strong>
          <span>Installed RF pattern unresolved</span>
        </div>
      ) : null}
    </div>
  );
}
