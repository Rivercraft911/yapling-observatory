import type { Object3D } from 'three';

export const STAR_TRACKER_GROUP = 'SSI_STAR_TRACKER_REMOVABLE';
export const OPTIONAL_MODULES = [
  {
    label: 'Reaction wheels',
    groups: ['SSI_WHEEL_X_OPTIONAL', 'SSI_WHEEL_Y_OPTIONAL', 'SSI_WHEEL_Z_OPTIONAL'],
  },
  { label: 'Magnetorquers', groups: ['SSI_TORQUER_X', 'SSI_TORQUER_Y', 'SSI_TORQUER_Z'] },
  { label: 'Battery cassette', groups: ['SSI_BATTERY_CASSETTE'] },
  { label: 'Fisheye cameras', groups: ['SSI_FISHEYE_PAIR_OPTIONAL'] },
];

export function isVisiblePart(object: Object3D): boolean {
  for (let part: Object3D | null = object; part; part = part.parent) {
    if (!part.visible) return false;
  }
  return true;
}

export function setStarTrackerVisibility<T extends Object3D>(
  root: Object3D,
  visible: boolean,
  selected: T | null,
) {
  return setModuleVisibility(root, STAR_TRACKER_GROUP, visible, selected);
}

export function setModuleVisibility<T extends Object3D>(
  root: Object3D,
  name: string,
  visible: boolean,
  selected: T | null,
) {
  const module = root.getObjectByName(name);
  if (!module) return { found: false, selected };
  module.visible = visible;
  let next = selected;
  if (!visible) {
    for (let part: Object3D | null = selected; part; part = part.parent) {
      if (part === module) {
        next = null;
        break;
      }
    }
  }
  return { found: true, selected: next };
}
