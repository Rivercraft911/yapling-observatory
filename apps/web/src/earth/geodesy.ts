/** Display transforms only. Run ECEF positions remain authoritative and unmodified. */
export const WGS84_A_M = 6378137;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B_OVER_A = 1 - WGS84_F;
export type Vec3 = [number, number, number];
const RAD = Math.PI / 180;

export function ecefToDisplay(position: readonly number[]): Vec3 {
  return [position[0] / WGS84_A_M, position[2] / WGS84_A_M, -position[1] / WGS84_A_M];
}

export function geodeticToEcef(latitudeDeg: number, longitudeDeg: number, heightM = 0): Vec3 {
  const lat = latitudeDeg * RAD,
    lon = longitudeDeg * RAD;
  const e2 = WGS84_F * (2 - WGS84_F);
  const n = WGS84_A_M / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (n + heightM) * Math.cos(lat) * Math.cos(lon),
    (n + heightM) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - e2) + heightM) * Math.sin(lat),
  ];
}

export function textureUv(latitudeDeg: number, longitudeDeg: number): [number, number] {
  return [(longitudeDeg + 180) / 360, (latitudeDeg + 90) / 180];
}

/** Whether the open camera-to-locator segment intersects the opaque WGS84 ellipsoid. */
export function isEarthOccluded(
  camera: readonly number[],
  point: readonly number[],
  tolerance = 0.00002,
): boolean {
  const a = [camera[0], camera[1] / WGS84_B_OVER_A, camera[2]];
  const b = [point[0], point[1] / WGS84_B_OVER_A, point[2]];
  const d = b.map((v, i) => v - a[i]);
  const aa = d.reduce((s, v) => s + v * v, 0);
  if (aa < 1e-16) return false;
  const bb = 2 * d.reduce((s, v, i) => s + v * a[i], 0);
  const cc = a.reduce((s, v) => s + v * v, 0) - 1;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant <= 0) return false;
  const t = (-bb - Math.sqrt(discriminant)) / (2 * aa);
  return t > tolerance && t < 1 - tolerance;
}

/** USNO low-precision apparent Sun + mean sidereal rotation, for visual illumination only.
 * UTC approximates UT1; no EOP, polar motion or mission ephemeris is supplied here.
 * Sources and scope are retained in earth/rendering-notes.json. */
export function visualSunDirection(epochUtc: string, elapsedS: number): Vec3 {
  const ms = new Date(epochUtc).getTime() + elapsedS * 1000;
  if (!Number.isFinite(ms)) return [1, 0, 0];
  const jd = ms / 86400000 + 2440587.5;
  const d = jd - 2451545;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const longitude = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
  // Equivalent J2000 GMST expression in degrees, neglecting sub-arcsecond terms.
  const t = d / 36525;
  const gmst =
    (280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000) * RAD;
  const lon = ra - gmst;
  return [Math.cos(dec) * Math.cos(lon), Math.sin(dec), -Math.cos(dec) * Math.sin(lon)];
}
