// Rough NYC travel time. Straight-line distance works within a borough and into Manhattan (the subway is
// built around it), but badly underestimates outer-borough-to-outer-borough trips (e.g. Crown Heights -> Forest
// Hills has no direct line), so those get a penalty. Swap for a real transit API later.
export function miles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Borough from a NYC ZIP code in an address: M, X (Bronx), K (Brooklyn), Q, S.
export function boroughOf(address) {
  const z = String(address || "").match(/\b(1\d{4})\b/)?.[1];
  if (!z) return null;
  const p = Number(z.slice(0, 3));
  if (p >= 100 && p <= 102) return "M";
  if (p === 103) return "S";
  if (p === 104) return "X";
  if (p === 112) return "K";
  if (p === 110 || p === 111 || (p >= 113 && p <= 116)) return "Q";
  return null;
}

// Walk (3 mph) under ~0.8 mi; otherwise subway/bus: 10 min overhead + ~15 mph, with borough penalties.
export function travelMinutes(lat1, lng1, lat2, lng2, fromBoro = null, toBoro = null) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(Number(v)))) return null;
  const d = miles(+lat1, +lng1, +lat2, +lng2);
  if (d <= 0.8) return Math.round(d * 20);
  let t = 10 + d * 4;
  if (fromBoro && toBoro && fromBoro !== toBoro) t *= fromBoro === "M" || toBoro === "M" ? 1.15 : 1.6;
  return Math.round(t);
}
