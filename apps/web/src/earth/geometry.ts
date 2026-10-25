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
