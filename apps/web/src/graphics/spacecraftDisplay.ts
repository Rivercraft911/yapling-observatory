import { FrontSide, Group, Material, Matrix4, Mesh, PerspectiveCamera, Vector3 } from 'three';

type Bounds = { mesh: Mesh; center: Vector3; halfSize: Vector3 };
type FineDetail = Bounds & { widthAxis: number; lengthAxis: number; materials: Material[] };

/** View-only treatment of the authored micrometre-scale solar-cell metallization. */
export function createSpacecraftDisplay(root: Group) {
  const bounds: Bounds[] = [];
  const details: FineDetail[] = [];
  const viewFromMesh = new Matrix4();
  const replacedMaterials = new Set<Material>();

  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.computeBoundingBox();
    const localBox = object.geometry.boundingBox;
    if (!localBox || localBox.isEmpty()) return;
    const item = {
      mesh: object,
      center: localBox.getCenter(new Vector3()),
      halfSize: localBox.getSize(new Vector3()).multiplyScalar(0.5),
    };
    bounds.push(item);
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    if (!originals.every((material) => material.name === 'Very fine cell metallization')) return;
    // The two small dimensions are conductor thickness and width. Only these
    // named display details receive clones; the cell/glass/PCB materials stay intact.
    const axes = [0, 1, 2].sort(
      (a, b) => item.halfSize.getComponent(a) - item.halfSize.getComponent(b),
    );
    const materials = originals.map((material) => {
      replacedMaterials.add(material);
      const clone = material.clone();
      clone.transparent = true;
      clone.depthWrite = false;
      clone.side = FrontSide;
      return clone;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0];
    details.push({ ...item, widthAxis: axes[1], lengthAxis: axes[2], materials });
  });
  // No meshes retain these originals. GLTFLoader owns no external references.
  replacedMaterials.forEach((material) => material.dispose());

  function update(camera: PerspectiveCamera, viewportHeight: number, radius: number) {
    camera.updateMatrixWorld();
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    const tanX = tanY * camera.aspect;
    let nearest = Infinity;
    let farthest = 0;
    for (const { mesh, center, halfSize } of bounds) {
      if (!mesh.visible) continue;
      viewFromMesh.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
      const m = viewFromMesh.elements;
      const x = m[0] * center.x + m[4] * center.y + m[8] * center.z + m[12];
      const y = m[1] * center.x + m[5] * center.y + m[9] * center.z + m[13];
      const depth = -(m[2] * center.x + m[6] * center.y + m[10] * center.z + m[14]);
      const extentX =
        Math.abs(m[0]) * halfSize.x + Math.abs(m[4]) * halfSize.y + Math.abs(m[8]) * halfSize.z;
      const extentY =
        Math.abs(m[1]) * halfSize.x + Math.abs(m[5]) * halfSize.y + Math.abs(m[9]) * halfSize.z;
      const extentZ =
        Math.abs(m[2]) * halfSize.x + Math.abs(m[6]) * halfSize.y + Math.abs(m[10]) * halfSize.z;
      const end = depth + extentZ;
      if (end <= 0 || Math.abs(x) - extentX > end * tanX || Math.abs(y) - extentY > end * tanY)
        continue;
      nearest = Math.min(nearest, depth - extentZ);
      farthest = Math.max(farthest, end);
    }
    // Tight camera-space bounds preserve depth precision at metre and millimetre
    // scales. When flying inside a bound, retain a small positive safe near plane.
    const near = Number.isFinite(nearest) ? Math.max(0.00005, nearest * 0.8) : 0.00005;
    const far = Math.max(near * 1.1, farthest + Math.max(radius * 0.03, 0.001));
    if (Math.abs(camera.near - near) > 1e-7 || Math.abs(camera.far - far) > 1e-7) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }

    const focalPixels = viewportHeight / (2 * tanY);
    for (const { mesh, center, halfSize, widthAxis, lengthAxis, materials } of details) {
      viewFromMesh.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
      const m = viewFromMesh.elements;
      const depth = -(m[2] * center.x + m[6] * center.y + m[10] * center.z + m[14]);
      const w = widthAxis * 4,
        l = lengthAxis * 4;
      const length = Math.hypot(m[l], m[l + 1]);
      // Project the conductor width perpendicular to its projected long axis.
      const projectedWidth =
        length > 1e-8
          ? Math.abs(m[w] * m[l + 1] - m[w + 1] * m[l]) / length
          : Math.hypot(m[w], m[w + 1]);
      const pixels =
        depth > 0
          ? (halfSize.getComponent(widthAxis) * 2 * projectedWidth * focalPixels) / depth
          : 0;
      const t = Math.max(0, Math.min(1, (pixels - 0.35) / 0.9));
      const opacity = t * t * (3 - 2 * t);
      mesh.visible = opacity > 0;
      for (const material of materials) material.opacity = opacity;
    }
  }

  return { update };
}
