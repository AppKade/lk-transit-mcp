const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bounding box [west, south, east, north] that contains a circle of `radiusM` around the point. */
export function boundingBox(lat: number, lon: number, radiusM: number): [number, number, number, number] {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos(rad(lat)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Rough Sri Lanka plausibility box (incl. offshore margin) used by validators. */
export const SRI_LANKA_BBOX: [number, number, number, number] = [79.4, 5.7, 82.1, 10.1];

export function inSriLanka(lat: number, lon: number): boolean {
  const [w, s, e, n] = SRI_LANKA_BBOX;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}
