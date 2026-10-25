import { FrameSize } from './graphics/frameSize';
import { useEffect, useRef, useState } from 'react';
import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion as ThreeQuaternion,
  Raycaster,
  Scene,
  Sphere,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { AssetInfo, Quaternion, Variant } from './types';
import { createRenderer } from './graphics/renderer';
import { createSpacecraftDisplay } from './graphics/spacecraftDisplay';
import { isVisiblePart, setStarTrackerVisibility } from './spacecraft/previewVisibility';
import { displayBracket, interpolateQuaternion } from './graphics/displayInterpolation';
import type { DisplayTimeSource } from './graphics/displayInterpolation';
import './spacecraft/workbench.css';

type Mode = 'orbit' | 'fly';
type CameraView = {
  position: Vector3;
  quaternion: ThreeQuaternion;
  up: Vector3;
  target: Vector3;
  minDistance: number;
  maxDistance: number;
};
type Handle = {
  frame: () => void;
  focus: () => void;
  setMode: (mode: Mode) => void;
  setStarTracker: (visible: boolean) => void;
};
const variantLabels: Record<Variant, string> = {
  dipole: 'Straight dipole',
  turnstile: 'Turnstile',
  v45: '45° V / tape',
};

export function Workbench({
  variant,
  asset,
  quaternion,
  displayTime,
  quaternionTimes,
  quaternionHistory,
  preview = 'exterior',
  starTrackerVisible = true,
}: {
  variant: Variant;
  asset?: AssetInfo;
  quaternion?: Quaternion;
  displayTime?: DisplayTimeSource;
  quaternionTimes?: readonly number[];
  quaternionHistory?: readonly Quaternion[];
  preview?: 'exterior' | 'cutaway';
  starTrackerVisible?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const cameraViews = useRef<Partial<Record<'exterior' | 'cutaway', CameraView>>>({});
  const pose = useRef<Quaternion | undefined>(quaternion);
  const playback = useRef({ displayTime, quaternionTimes, quaternionHistory });
  playback.current = { displayTime, quaternionTimes, quaternionHistory };
  const trackerVisibility = useRef(starTrackerVisible);
  trackerVisibility.current = starTrackerVisible;
  const modelLabel = preview === 'cutaway' ? 'Cutaway layout study' : 'Spacecraft';
  const [mode, setMode] = useState<Mode>('orbit');
  const navigationMode = useRef<Mode>(mode);
  navigationMode.current = mode;
  const [status, setStatus] = useState('Loading model');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('Spacecraft');
  const [revision, setRevision] = useState(asset?.revision || 'Revision unverified');
  const [retry, setRetry] = useState(0);
  pose.current = quaternion;

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let animation = 0;
    let renderer: ReturnType<typeof createRenderer>['renderer'];
    try {
      renderer = createRenderer().renderer;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'WebGL is unavailable.');
      return;
    }
    setStatus('Loading model');
    setError('');
    setSelection(modelLabel);
    setRevision(asset?.revision || 'Revision unverified');
    const scene = new Scene();
    scene.background = new Color('#171c1e');
    const camera = new PerspectiveCamera(38, 1, 0.0003, 100);
    // glTF -Z is the patch/front face; this is independent of the live body pose.
    camera.position.set(0.43, 0.3, -0.57);
    const savedView = cameraViews.current[preview];
    if (savedView) {
      camera.position.copy(savedView.position);
      camera.quaternion.copy(savedView.quaternion);
      camera.up.copy(savedView.up);
    }
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      'aria-label',
      'Spacecraft 3D view. Drag to orbit, right-drag to pan, scroll to dolly, double-click to focus.',
    );
    host.appendChild(canvas);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 0.025;
    controls.maxDistance = 8;
    controls.zoomToCursor = true;
    if (savedView) {
      controls.target.copy(savedView.target);
      controls.minDistance = savedView.minDistance;
      controls.maxDistance = savedView.maxDistance;
      controls.update();
      if (navigationMode.current === 'fly') camera.quaternion.copy(savedView.quaternion);
    }
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.85;
    room.dispose();
    scene.add(new HemisphereLight('#dde6ed', '#121619', 1.3));
    const key = new DirectionalLight('#fff6e7', 3.2);
    key.position.set(1, 2, 2);
    scene.add(key);
    const rim = new DirectionalLight('#bcdeed', 2);
    rim.position.set(-2, 0.5, -1);
    scene.add(rim);
    const poseRoot = new Group();
    scene.add(poseRoot);
    const box = new Box3();
    const sphere = new Sphere();
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const keys = new Set<string>();
    let currentMode: Mode = navigationMode.current;
    controls.enabled = currentMode === 'orbit';
    let root: Group | null = null;
    let display: ReturnType<typeof createSpacecraftDisplay> | null = null;
    let selected: Mesh | null = null;
    let radius = 0.3;
    let flyTargetDistance = savedView ? camera.position.distanceTo(savedView.target) : radius;
    let dragging = false;
    let lastTime = performance.now();
    const c = new ThreeQuaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    const ci = c.clone().invert();
    const rotation = new ThreeQuaternion();

    function frameObject(object: Group | Mesh | null) {
      if (!object) return;
      box.setFromObject(object);
      box.getBoundingSphere(sphere);
      const r = Math.max(sphere.radius, 0.008);
      const direction = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(sphere.center);
      camera.position
        .copy(sphere.center)
        .addScaledVector(direction, (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.14);
      controls.minDistance = Math.max(0.006, r * 0.12);
      controls.update();
    }
    handle.current = {
      frame: () => {
        selected = null;
        setSelection(modelLabel);
        frameObject(root);
      },
      focus: () => frameObject(selected || root),
      setMode: (next) => {
        if (next === 'fly' && currentMode !== 'fly')
          flyTargetDistance = Math.max(0.001, camera.position.distanceTo(controls.target));
        currentMode = next;
        controls.enabled = next === 'orbit';
        keys.clear();
        canvas.focus();
      },
      setStarTracker: (visible) => {
        if (!root) return;
        const result = setStarTrackerVisibility(root, visible, selected);
        if (selected !== result.selected) {
          selected = result.selected;
          setSelection(modelLabel);
        }
      },
    };
    const abort = new AbortController();
    const url =
      asset?.url ||
      (preview === 'cutaway'
        ? '/api/assets/previews/cutaway.glb'
        : `/api/assets/spacecraft.glb?variant=${variant}`);
    const request =
      asset?.available === false
        ? Promise.reject(
            new Error(preview === 'cutaway' ? 'Cutaway preview unavailable' : 'Model unavailable'),
          )
        : fetch(url, { signal: abort.signal, cache: 'no-store' });
    request
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model unavailable (${response.status})`);
        const headerRevision = response.headers.get('X-Asset-Revision');
        if (headerRevision && !disposed) setRevision(headerRevision);
        const buffer = await response.arrayBuffer();
        return new GLTFLoader().parseAsync(
          buffer,
          new URL(url, window.location.href).href.replace(/[^/]*$/, ''),
        );
      })
      .then((gltf) => {
        if (disposed) {
          disposeModel(gltf.scene);
          return;
        }
        root = gltf.scene;
        poseRoot.add(root);
        setStarTrackerVisibility(root, trackerVisibility.current, null);
        display = createSpacecraftDisplay(root);
        box.setFromObject(root);
        box.getBoundingSphere(sphere);
        radius = Math.max(sphere.radius, 0.05);
        if (!savedView) flyTargetDistance = radius;
        controls.maxDistance = savedView
          ? Math.max(
              radius * 30,
              savedView.maxDistance,
              camera.position.distanceTo(controls.target),
            )
          : radius * 30;
        if (!savedView) frameObject(root);
        setStatus('Model ready');
      })
      .catch((cause) => {
        if (!disposed && cause.name !== 'AbortError')
          setError(cause.message || 'Model unavailable');
      });

    const pick = (event: MouseEvent) => {
      if (!root || currentMode !== 'orbit') return;
      const bounds = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster
        .intersectObject(root, true)
        .find((item) => item.object instanceof Mesh && isVisiblePart(item.object));
      if (hit?.object instanceof Mesh) {
        selected = hit.object;
        setSelection((selected.name || 'Selected part').replace(/[_\.]+/g, ' '));
        frameObject(selected);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        currentMode === 'fly' &&
        ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'ShiftLeft', 'ShiftRight'].includes(
          event.code,
        )
      ) {
        event.preventDefault();
        keys.add(event.code);
      }
    };
    const keyUp = (event: KeyboardEvent) => keys.delete(event.code);
    const pointerDown = (event: PointerEvent) => {
      canvas.focus();
      if (currentMode === 'fly' && event.button === 0) {
        dragging = true;
        canvas.setPointerCapture(event.pointerId);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging || currentMode !== 'fly') return;
      const yaw = new ThreeQuaternion().setFromAxisAngle(
        new Vector3(0, 1, 0),
        -event.movementX * 0.004,
      );
      const pitch = new ThreeQuaternion().setFromAxisAngle(
        new Vector3(1, 0, 0),
        -event.movementY * 0.004,
      );
      camera.quaternion.premultiply(yaw).multiply(pitch).normalize();
    };
    const pointerUp = () => {
      dragging = false;
    };
    const blur = () => {
      keys.clear();
      dragging = false;
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    canvas.addEventListener('dblclick', pick);
    canvas.addEventListener('keydown', keyDown);
    canvas.addEventListener('keyup', keyUp);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    const frameSize = new FrameSize();
    frameSize.request(host.clientWidth, host.clientHeight);
    const resize = new ResizeObserver(() => {
      frameSize.request(host.clientWidth, host.clientHeight);
    });
    resize.observe(host);
    function animate(now: number) {
      if (disposed) return;
      frameSize.apply((width, height) => {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      });
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const history = playback.current;
      const bracket =
        history.displayTime && history.quaternionTimes && history.quaternionHistory
          ? displayBracket(history.quaternionTimes, history.displayTime.current)
          : null;
      const q =
        bracket && history.quaternionHistory
          ? interpolateQuaternion(
              history.quaternionHistory[bracket.lower],
              history.quaternionHistory[bracket.upper],
              bracket.alpha,
            )
          : pose.current;
      if (history.displayTime)
        canvas.dataset.displayTimeSeconds = String(history.displayTime.current);
      if (q?.length === 4 && q.every(Number.isFinite)) {
        rotation.set(q[1], q[2], q[3], q[0]).normalize().invert();
        poseRoot.quaternion.copy(c).multiply(rotation).multiply(ci);
      } else poseRoot.quaternion.identity();
      poseRoot.updateMatrixWorld(true);
      if (currentMode === 'fly') {
        const movement = new Vector3(
          Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
          Number(keys.has('KeyR')) - Number(keys.has('KeyF')),
          Number(keys.has('KeyS')) - Number(keys.has('KeyW')),
        );
        if (movement.lengthSq()) {
          movement
            .normalize()
            .applyQuaternion(camera.quaternion)
            .multiplyScalar(
              dt * radius * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 0.7),
            );
          const travel = movement.length();
          raycaster.set(camera.position, movement.clone().normalize());
          const hit = root
            ? raycaster.intersectObject(root, true).find((item) => isVisiblePart(item.object))
            : undefined;
          if (!hit || hit.distance > travel + 0.003) camera.position.add(movement);
        }
        controls.target
          .copy(camera.position)
          .add(camera.getWorldDirection(new Vector3()).multiplyScalar(flyTargetDistance));
      } else {
        const previous = camera.position.clone();
        controls.update(dt);
        const movement = camera.position.clone().sub(previous);
        const travel = movement.length();
        if (root && travel > 1e-8) {
          raycaster.set(previous, movement.normalize());
          const hit = raycaster
            .intersectObject(root, true)
            .find((item) => isVisiblePart(item.object));
          if (hit && hit.distance < travel + Math.max(0.0005, radius * 0.005))
            camera.position.copy(previous);
        }
      }
      display?.update(camera, canvas.height, radius);
      canvas.dataset.cameraPosition = JSON.stringify(camera.position.toArray());
      canvas.dataset.cameraTarget = JSON.stringify(controls.target.toArray());
      canvas.dataset.navigationMode = currentMode;
      renderer.render(scene, camera);
      animation = requestAnimationFrame(animate);
    }
    animation = requestAnimationFrame(animate);
    return () => {
      if (root || savedView)
        cameraViews.current[preview] = {
          position: camera.position.clone(),
          quaternion: camera.quaternion.clone(),
          up: camera.up.clone(),
          target: controls.target.clone(),
          minDistance: controls.minDistance,
          maxDistance: controls.maxDistance,
        };
      disposed = true;
      abort.abort();
      cancelAnimationFrame(animation);
      resize.disconnect();
      handle.current = null;
      canvas.removeEventListener('dblclick', pick);
      canvas.removeEventListener('keydown', keyDown);
      canvas.removeEventListener('keyup', keyUp);
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      controls.dispose();
      environment.dispose();
      pmrem.dispose();
      if (root) disposeModel(root);
      renderer.dispose();
      canvas.remove();
    };
  }, [variant, preview, asset?.url, asset?.revision, asset?.sha256, asset?.available, retry]);

  useEffect(() => {
    handle.current?.setStarTracker(starTrackerVisible);
  }, [starTrackerVisible]);

  useEffect(() => {
    handle.current?.setMode(mode);
  }, [mode, variant, retry]);
  return (
    <section className="workbench" data-spacecraft-view={preview} aria-label="Spacecraft workbench">
      <div className="scene-mount" ref={mount} />
      <div className="scene-top">
        <div>
          <span className="eyebrow">
            {preview === 'cutaway' ? 'SPACECRAFT / LAYOUT STUDY' : 'SPACECRAFT / 1U'}
          </span>
          <h1>{preview === 'cutaway' ? 'Cutaway layout study' : variantLabels[variant]}</h1>
        </div>
        <span className="scene-revision">
          {revision}
          {asset?.fallback ? ' · fallback' : ''}
        </span>
      </div>
      {error ? (
        <div className="scene-message error">
          <span>{error}</span>
          <button onClick={() => setRetry((n) => n + 1)}>Retry model</button>
        </div>
      ) : status !== 'Model ready' ? (
        <div className="scene-message">
          <span className="spinner" />
          {status}
        </div>
      ) : null}
      <div className="scene-bottom">
        <div className="view-tools">
          <div className="segmented">
            <button className={mode === 'orbit' ? 'active' : ''} onClick={() => setMode('orbit')}>
              Orbit
            </button>
            <button className={mode === 'fly' ? 'active' : ''} onClick={() => setMode('fly')}>
              Fly
            </button>
          </div>
          <button onClick={() => handle.current?.frame()} title="Frame all spacecraft geometry">
            Frame all
          </button>
          <button onClick={() => handle.current?.focus()} title="Focus the selected part">
            Focus
          </button>
        </div>
        <span className="navigation-hint">
          {mode === 'orbit'
            ? 'drag orbit · right-drag pan · wheel dolly · double-click focus'
            : 'drag look · W A S D move · R F vertical · Shift fast'}
        </span>
      </div>
      <div className="selection-readout">
        {selection}
        <span>metres · WebGL 2</span>
      </div>
    </section>
  );
}

function disposeModel(root: Group) {
  const textures = new Set<Texture>();
  const geometries = new Set<Mesh['geometry']>();
  root.traverse((object) => {
    if (object instanceof Mesh) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material))
          if (value instanceof Texture) textures.add(value);
        material.dispose();
      }
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => {
    const data = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    texture.dispose();
  });
}
