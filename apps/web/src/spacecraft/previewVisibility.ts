import type { Object3D } from 'three';

export const STAR_TRACKER_GROUP = 'SSI_STAR_TRACKER_REMOVABLE';

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
  const tracker = root.getObjectByName(STAR_TRACKER_GROUP);
  if (!tracker) return { found: false, selected };
  tracker.visible = visible;
  let next = selected;
  if (!visible) {
    for (let part: Object3D | null = selected; part; part = part.parent) {
      if (part === tracker) {
        next = null;
        break;
      }
    }
  }
  return { found: true, selected: next };
}
