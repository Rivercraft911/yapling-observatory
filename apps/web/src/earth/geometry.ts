import { BufferGeometry, Float32BufferAttribute } from 'three';
import { ecefToDisplay, geodeticToEcef, textureUv } from './geodesy';

export function earthGeometry(heightM = 0, columns = 256, rows = 128): BufferGeometry {
  const vertices: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let y = 0; y <= rows; y++) {
    const lat = -90 + (y / rows) * 180,
      phi = (lat * Math.PI) / 180;
    for (let x = 0; x <= columns; x++) {
      const lon = -180 + (x / columns) * 360,
        lambda = (lon * Math.PI) / 180;
      vertices.push(...ecefToDisplay(geodeticToEcef(lat, lon, heightM)));
      normals.push(
        Math.cos(phi) * Math.cos(lambda),
        Math.sin(phi),
        -Math.cos(phi) * Math.sin(lambda),
      );
      uvs.push(...textureUv(lat, lon));
      if (x < columns && y < rows) {
        const a = y * (columns + 1) + x,
          b = a + columns + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export interface DisplayPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function distanceToSegments(point: DisplayPoint, segments: readonly number[]) {
  let minimumSquared = Infinity;
  for (let i = 0; i + 5 < segments.length; i += 6) {
    const x = segments[i],
      y = segments[i + 1],
      z = segments[i + 2];
    const dx = segments[i + 3] - x,
      dy = segments[i + 4] - y,
      dz = segments[i + 5] - z;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const projection =
      lengthSquared > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ((point.x - x) * dx + (point.y - y) * dy + (point.z - z) * dz) / lengthSquared,
            ),
          )
        : 0;
    const px = point.x - x - projection * dx;
    const py = point.y - y - projection * dy;
    const pz = point.z - z - projection * dz;
    minimumSquared = Math.min(minimumSquared, px * px + py * py + pz * pz);
  }
  return Math.sqrt(minimumSquared);
}

/** Display-only frustum fitting. A fixed tiny near plane loses cloud/surface depth at large dolly. */
export function earthDepthRange(
  position: DisplayPoint,
  effectiveFovDeg: number,
  aspect: number,
  sceneExtent = 1.02,
  segments: readonly (readonly number[])[] = [],
  points: readonly DisplayPoint[] = [],
) {
  const radius = Math.hypot(position.x, position.y, position.z);
  // 1.013 encloses the visual atmosphere. Inside it, retain the near-plane floor.
  let clearance = Math.max(0, radius - 1.013);
  for (const group of segments)
    clearance = Math.min(clearance, distanceToSegments(position, group));
  for (const point of points)
    clearance = Math.min(
      clearance,
      Math.hypot(position.x - point.x, position.y - point.y, position.z - point.z),
    );
  const tangent = Math.tan((effectiveFovDeg * Math.PI) / 360);
  const cornerFactor = Math.sqrt(1 + tangent * tangent * (1 + aspect * aspect));
  return {
    near: Math.max(0.0001, (clearance * 0.25) / cornerFactor),
    far: Math.max(2, radius + Math.max(1.02, sceneExtent) * 1.05),
  };
}
