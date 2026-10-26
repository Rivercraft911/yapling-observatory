import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { Samples } from '../types';
import {
  buildGroundTrack,
  groundTrackWindowBounds,
  projectGroundTrackPosition,
  selectGroundTrackMarkers,
} from './groundTrack';
import { isEarthOccluded, WGS84_A_M, WGS84_B_OVER_A } from './geodesy';

type Track = ReturnType<typeof buildGroundTrack>;
type TrackPoint = Track['points'][number];

const TRACK_COLOR = '#8d8780';
const CONTACT_COLOR = '#e6e1d9';
const RF_COLOR = '#ce4c57';
const SURFACE_LIFT = 1200 / WGS84_A_M;
const MAX_ARC_STEP = 0.015;
const MAX_MARKERS = 64;

function rfEligible(state: TrackPoint['state']) {
  return state === 'uplink' || state === 'downlink';
}

function liftedPoint(position: readonly number[]) {
  return position.map((value) => value * (1 + SURFACE_LIFT));
}

/** Tessellation follows the display ellipsoid; it creates no additional contact samples. */
function surfaceArc(start: readonly number[], end: readonly number[], output: number[]) {
  const a = new Vector3(start[0], start[1] / WGS84_B_OVER_A, start[2]).normalize();
  const b = new Vector3(end[0], end[1] / WGS84_B_OVER_A, end[2]).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  if (angle > Math.PI - 0.01) return;
  const steps = Math.max(1, Math.ceil(angle / MAX_ARC_STEP));
  const sine = Math.sin(angle);
  const point = new Vector3();
  let previous = liftedPoint(start);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (angle < 1e-8) point.copy(a).lerp(b, t).normalize();
    else
      point
        .copy(a)
        .multiplyScalar(Math.sin((1 - t) * angle) / sine)
        .addScaledVector(b, Math.sin(t * angle) / sine);
    const current = [
      point.x * (1 + SURFACE_LIFT),
      point.y * WGS84_B_OVER_A * (1 + SURFACE_LIFT),
      point.z * (1 + SURFACE_LIFT),
    ];
    output.push(...previous, ...current);
    previous = current;
  }
}

function makeLine(name: string, color: string, opacity: number, renderOrder: number) {
  const line = new LineSegments(
    new BufferGeometry(),
    new LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  line.name = name;
  line.renderOrder = renderOrder;
  return line;
}

function writeLine(line: LineSegments, vertices: number[]) {
  let attribute = line.geometry.getAttribute('position');
  if (!attribute || attribute.array.length < vertices.length) {
    const capacity = 3 * Math.max(128, 2 ** Math.ceil(Math.log2(vertices.length / 3 || 1)));
    line.geometry.dispose();
    line.geometry = new BufferGeometry().setAttribute(
      'position',
      new Float32BufferAttribute(new Float32Array(capacity), 3).setUsage(DynamicDrawUsage),
    );
    attribute = line.geometry.getAttribute('position');
  }
  (attribute.array as Float32Array).set(vertices);
  attribute.needsUpdate = true;
  line.geometry.setDrawRange(0, vertices.length / 3);
  line.geometry.computeBoundingSphere();
  line.visible = vertices.length > 0;
}

function markerGeometry(count: number) {
  return new BufferGeometry()
    .setAttribute(
      'position',
      new Float32BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage),
    )
    .setAttribute(
      'color',
      new Float32BufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage),
    )
    .setAttribute(
      'glyph',
      new Float32BufferAttribute(new Float32Array(count), 1).setUsage(DynamicDrawUsage),
    )
    .setAttribute(
      'visibleMarker',
      new Float32BufferAttribute(new Float32Array(count).fill(1), 1).setUsage(DynamicDrawUsage),
    );
}

function markerMaterial(pixelRatio: number) {
  return new ShaderMaterial({
    uniforms: { pixelRatio: { value: pixelRatio } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: `
      uniform float pixelRatio;
      attribute vec3 color;
      attribute float glyph;
      attribute float visibleMarker;
      varying vec3 markerColor;
      varying float markerGlyph;
      varying float markerVisible;
      void main() {
        markerColor = color;
        markerGlyph = glyph;
        markerVisible = visibleMarker;
        if (glyph > 3.5) {
          vec3 worldPoint = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 scale = vec3(1.0, ${1 / WGS84_B_OVER_A}, 1.0);
          vec3 origin = cameraPosition * scale;
          vec3 ray = worldPoint * scale - origin;
          float a = dot(ray, ray);
          float b = dot(origin, ray);
          float c = dot(origin, origin) - 1.0;
          float discriminant = b * b - a * c;
          if (a > 0.0 && discriminant > 0.0) {
            float hit = (-b - sqrt(discriminant)) / a;
            if (hit > 0.0 && hit < 0.99998) markerVisible = 0.0;
          }
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (glyph > 3.5 ? 3.5 : glyph > 2.5 ? 11.0 : glyph > 1.5 ? 13.0 : 9.0) * pixelRatio;
      }
    `,
    fragmentShader: `
      varying vec3 markerColor;
      varying float markerGlyph;
      varying float markerVisible;
      void main() {
        if (markerVisible < 0.5) discard;
        vec2 p = (gl_PointCoord - 0.5) * 2.0;
        float radius = length(p);
        float shape = radius;
        if (markerGlyph < 1.5) {
          if (markerGlyph > 0.5) p.y = -p.y;
          shape = max(p.y * 0.5 + abs(p.x) * 0.8660254, -p.y);
        }
        float width = fwidth(shape) * 0.8;
        float outline = (1.0 - smoothstep(0.72 - width, 0.72 + width, shape))
          * smoothstep(0.43 - width, 0.43 + width, shape);
        float center = markerGlyph > 2.5 ? 1.0 - smoothstep(0.18, 0.3, radius) : 0.0;
        float alpha = markerGlyph > 3.5
          ? 1.0 - smoothstep(0.45, 0.82, radius)
          : max(outline, center) * 0.94;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(markerColor, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** Surface paths and fixed-pixel event glyphs consume returned sample classifications. */
export class GroundTrackLayer {
  readonly group = new Group();
  private readonly trace = makeLine('Ground track', TRACK_COLOR, 0.34, 3);
  private readonly contact = makeLine('Above-mask samples', CONTACT_COLOR, 0.78, 4);
  private readonly eligible: Points;
  private readonly material: ShaderMaterial;
  private readonly markers: Points;
  private readonly cursor: Points;
  private samples: Samples | undefined;
  private lastSamples: Samples | undefined;
  private lastSampleIndex = -1;
  private lastBoundsKey = '';
  private windowSeconds = 10800;
  private maxGapS = Infinity;
  private enabled = false;
  private track: Track | null = null;
  private cameraPosition = new Vector3(Infinity, Infinity, Infinity);
  private markerVisibilityDirty = true;

  constructor(pixelRatio = 1) {
    this.material = markerMaterial(pixelRatio);
    this.eligible = new Points(markerGeometry(0), this.material);
    this.eligible.name = 'Sampled RF opportunities';
    this.eligible.renderOrder = 5;
    this.markers = new Points(markerGeometry(MAX_MARKERS), this.material);
    this.markers.name = 'Sampled pass markers';
    this.markers.renderOrder = 6;
    this.cursor = new Points(markerGeometry(1), this.material);
    this.cursor.name = 'Current subsatellite point';
    this.cursor.renderOrder = 7;
    const color = new Color(CONTACT_COLOR);
    this.cursor.geometry.getAttribute('color').setXYZ(0, color.r, color.g, color.b);
    this.cursor.geometry.getAttribute('glyph').setX(0, 3);
    this.cursor.visible = false;
    this.group.name = 'Ground-track overlay';
    // Clouds and atmosphere do not write depth. Opaque Earth still hides the far hemisphere.
    this.group.renderOrder = 3;
    this.group.add(this.trace, this.contact, this.eligible, this.markers, this.cursor);
    this.group.visible = false;
  }

  setSamples(samples: Samples | undefined, maxGapS = Infinity) {
    this.samples = samples;
    if (this.maxGapS !== maxGapS) {
      this.lastBoundsKey = '';
      this.lastSampleIndex = -1;
    }
    this.maxGapS = maxGapS;
    if (!samples) {
      this.track = null;
      this.lastSamples = undefined;
      this.lastSampleIndex = -1;
      this.group.visible = false;
      this.cursor.visible = false;
    }
  }

  setEnabled(enabled: boolean, windowSeconds = this.windowSeconds) {
    if (windowSeconds !== this.windowSeconds) {
      this.lastSampleIndex = -1;
      this.lastBoundsKey = '';
    }
    this.enabled = enabled;
    this.windowSeconds = windowSeconds;
    this.group.visible = enabled && !!this.track;
  }

  updateSample(index: number, spacecraftPosition: readonly number[], timeS: number) {
    if (!this.enabled || !this.samples) return;
    if (this.samples !== this.lastSamples || index !== this.lastSampleIndex) {
      const bounds = groundTrackWindowBounds(this.samples.time_s, timeS, this.windowSeconds);
      const boundsKey = `${bounds.startIndex}:${bounds.endIndex}`;
      if (this.samples !== this.lastSamples || boundsKey !== this.lastBoundsKey || !this.track) {
        this.track = buildGroundTrack(this.samples, {
          cursorTimeS: timeS,
          windowSeconds: this.windowSeconds,
          maxGapS: this.maxGapS,
          maxMarkers: MAX_MARKERS,
        });
        const vertices: number[][] = [[], []];
        for (const segment of this.track.segments) {
          const layer = segment.visibility === 'visible' ? 1 : 0;
          surfaceArc(segment.start.position, segment.end.position, vertices[layer]);
        }
        writeLine(this.trace, vertices[0]);
        writeLine(this.contact, vertices[1]);
        this.updateRfSamples();
        this.lastBoundsKey = boundsKey;
      } else {
        this.track = {
          ...this.track,
          ...bounds,
          ...selectGroundTrackMarkers(this.track.candidateMarkers, timeS, MAX_MARKERS),
        };
      }
      this.updateMarkers();
      this.lastSamples = this.samples;
      this.lastSampleIndex = index;
    }
    this.group.visible = true;
    const point = projectGroundTrackPosition(spacecraftPosition);
    this.cursor.visible = !!point;
    if (point) {
      this.cursor.position.fromArray(liftedPoint(point));
      this.markerVisibilityDirty = true;
    }
  }

  private updateRfSamples() {
    const points = this.track?.points.filter((point) => rfEligible(point.state)) || [];
    if (this.eligible.geometry.getAttribute('position').count < points.length) {
      this.eligible.geometry.dispose();
      this.eligible.geometry = markerGeometry(2 ** Math.ceil(Math.log2(points.length)));
    }
    const position = this.eligible.geometry.getAttribute('position');
    const colors = this.eligible.geometry.getAttribute('color');
    const glyph = this.eligible.geometry.getAttribute('glyph');
    const color = new Color(RF_COLOR);
    points.forEach((point, index) => {
      const lifted = liftedPoint(point.position);
      position.setXYZ(index, lifted[0], lifted[1], lifted[2]);
      colors.setXYZ(index, color.r, color.g, color.b);
      glyph.setX(index, 4);
    });
    position.needsUpdate = true;
    colors.needsUpdate = true;
    glyph.needsUpdate = true;
    this.eligible.geometry.setDrawRange(0, points.length);
    this.eligible.geometry.computeBoundingSphere();
    this.eligible.visible = points.length > 0;
  }

  private updateMarkers() {
    const extrema = new Set<string>();
    const markers = (this.track?.markers || []).filter((marker) => {
      if (marker.kind === 'aos' || marker.kind === 'los') return true;
      const key = `${marker.contactId}:${marker.point.index}`;
      if (extrema.has(key)) return false;
      extrema.add(key);
      return true;
    });
    const position = this.markers.geometry.getAttribute('position');
    const colors = this.markers.geometry.getAttribute('color');
    const glyph = this.markers.geometry.getAttribute('glyph');
    const color = new Color();
    markers.forEach((marker, index) => {
      const point = liftedPoint(marker.point.position);
      position.setXYZ(index, point[0], point[1], point[2]);
      color.set(rfEligible(marker.point.state) ? RF_COLOR : CONTACT_COLOR);
      colors.setXYZ(index, color.r, color.g, color.b);
      glyph.setX(index, marker.kind === 'aos' ? 0 : marker.kind === 'los' ? 1 : 2);
    });
    position.needsUpdate = true;
    colors.needsUpdate = true;
    glyph.needsUpdate = true;
    this.markers.geometry.setDrawRange(0, markers.length);
    this.markers.geometry.computeBoundingSphere();
    this.markerVisibilityDirty = true;
  }

  updateCamera(camera: PerspectiveCamera) {
    if (!this.group.visible) return;
    if (!this.markerVisibilityDirty && this.cameraPosition.equals(camera.position)) return;
    this.cameraPosition.copy(camera.position);
    const origin = camera.position.toArray();
    const positions = this.markers.geometry.getAttribute('position');
    const visibility = this.markers.geometry.getAttribute('visibleMarker');
    for (let i = 0; i < this.markers.geometry.drawRange.count; i++)
      visibility.setX(
        i,
        isEarthOccluded(origin, [positions.getX(i), positions.getY(i), positions.getZ(i)]) ? 0 : 1,
      );
    visibility.needsUpdate = true;
    const cursorVisibility = this.cursor.geometry.getAttribute('visibleMarker');
    cursorVisibility.setX(0, isEarthOccluded(origin, this.cursor.position.toArray()) ? 0 : 1);
    cursorVisibility.needsUpdate = true;
    this.markerVisibilityDirty = false;
  }

  get statistics() {
    return {
      pointCount: this.track?.points.length || 0,
      markerCount: this.track ? this.markers.geometry.drawRange.count : 0,
      omittedMarkerCount: this.track?.omittedMarkerCount || 0,
      windowStartS: this.track?.windowStartS,
      windowEndS: this.track?.windowEndS,
    };
  }

  dispose() {
    for (const line of [this.trace, this.contact]) {
      line.geometry.dispose();
      line.material.dispose();
    }
    this.eligible.geometry.dispose();
    this.markers.geometry.dispose();
    this.cursor.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
