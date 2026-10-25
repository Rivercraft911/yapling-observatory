import {
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Object3D,
  type Material,
} from 'three';

const groups: Record<string, string> = {
  SSI_BATTERY_CASSETTE: 'battery',
  SSI_CARD_FC_REMOVABLE: 'obc',
  SSI_GUIDES_FIXED: 'bus',
  SSI_ACTUATOR_TRAY_FIXED: 'bus',
};
export function thermalNodeForPart(part: Object3D): string | null {
  for (let current: Object3D | null = part; current; current = current.parent) {
    if (groups[current.name]) return groups[current.name];
  }
  for (let current: Object3D | null = part; current; current = current.parent) {
    const name =
      typeof current.userData.name === 'string'
        ? current.userData.name
        : current.name.replaceAll('_', ' ');
    if (/^(Primary rail|End frame|Rail end)/.test(name)) return 'bus';
    if (/white PCB|panel substrate/i.test(name) || /cell.*\| (active face|backing)/i.test(name))
      return 'panel';
  }
  return null;
}
const stops = ['#416b9a', '#aeb7b7', '#e2a062', '#c93b48'].map((value) => new Color(value));
export function temperatureColor(kelvin: number | undefined) {
  if (kelvin == null || !Number.isFinite(kelvin)) return new Color('#696c70');
  const position = Math.max(0, Math.min(1, (kelvin - 273.15) / 80)) * (stops.length - 1);
  const low = Math.floor(position);
  return stops[low].clone().lerp(stops[Math.min(stops.length - 1, low + 1)], position - low);
}
export function createThermalOverlay(root: Object3D) {
  const parts: { mesh: Mesh; original: Material | Material[]; node: string | null }[] = [];
  const materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const original = Array.isArray(object.material) ? object.material : [object.material];
    if (original.some((material) => material.name === 'Very fine cell metallization')) return;
    parts.push({ mesh: object, original: object.material, node: thermalNodeForPart(object) });
  });
  for (const { node } of parts)
    if (!materials.has(node || 'unmapped')) {
      materials.set(
        node || 'unmapped',
        node
          ? new MeshBasicMaterial({ color: '#696c70', side: DoubleSide, toneMapped: false })
          : new MeshStandardMaterial({
              color: '#696c70',
              roughness: 0.8,
              metalness: 0.05,
              side: DoubleSide,
            }),
      );
    }
  let active = false;
  return {
    update(temperatures?: Record<string, number>) {
      const enabled = !!temperatures;
      if (enabled !== active) {
        for (const part of parts)
          part.mesh.material = enabled ? materials.get(part.node || 'unmapped')! : part.original;
        active = enabled;
      }
      if (enabled)
        for (const [node, material] of materials) {
          material.color.copy(temperatureColor(temperatures[node]));
          if (material instanceof MeshStandardMaterial)
            material.emissive.copy(material.color).multiplyScalar(0.16);
        }
    },
    dispose() {
      for (const part of parts) part.mesh.material = part.original;
      for (const material of materials.values()) material.dispose();
    },
  };
}
