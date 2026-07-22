/** Haversine distance in meters between two {lat,lng} points. */
export function distanceMeters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isInsideGeofence(coordinates, fence) {
  if (!coordinates || !fence || fence.lat == null || fence.lng == null) return null;
  const dist = distanceMeters(coordinates, { lat: fence.lat, lng: fence.lng });
  if (dist == null) return null;
  return dist <= (fence.radiusM ?? fence.radius_m ?? 250);
}
