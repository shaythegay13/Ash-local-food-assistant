// Rough NYC travel time from straight-line distance. Good enough to keep a Brooklyn plan out of the Bronx;
// swap for a real transit API later.
export function miles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Walk (3 mph) under ~0.8 mi; otherwise subway/bus: 10 min overhead + ~15 mph.
export function travelMinutes(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(Number(v)))) return null;
  const d = miles(+lat1, +lng1, +lat2, +lng2);
  return Math.round(d <= 0.8 ? d * 20 : 10 + d * 4);
}
