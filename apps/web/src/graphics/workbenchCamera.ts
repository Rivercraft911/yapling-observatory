import { PerspectiveCamera, Vector3 } from 'three';

export function inspectionCameraPose(preview: 'exterior' | 'cutaway') {
  // glTF -Z is the patch-deck normal; the cutaway opens toward glTF +X and +Y.
  return preview === 'cutaway'
    ? { position: new Vector3(0.43, 0.3, -0.28), up: new Vector3(0, 0, -1) }
    : { position: new Vector3(0.43, 0.3, -0.57), up: new Vector3(0, 1, 0) };
}

export function sphereFramingDistance(camera: PerspectiveCamera, radius: number) {
  const verticalHalfFov = (camera.getEffectiveFOV() * Math.PI) / 360;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
  return (radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * 1.14;
}
