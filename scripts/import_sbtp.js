// Import the Saved by the Plate map export (Supabase `locations` CSV) as UNVERIFIED candidate sources.
// Usage (PowerShell):  node scripts/import_sbtp.js "C:\Users\shayb\Downloads\locations_rows.csv"
// - Imports food sources AND community gardens/urban farms. Gardens/farms come in with no schedulable hours
//   until the refresh agent confirms they give or sell food to the public, and when.
// - Citywide by default; the planner filters by travel time from the person. Optional: --zips=10026,10027
// - Parses simple hour strings ("24/7", "Thursday & Sunday 8am-4pm"); anything else -> hours unknown.
// - Never overwrites a source already in data/sources.json (your hand-verified ones win).
// The planner only schedules sources with known hours, so unknown-hours rows are listed but not used.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const zipArg = process.argv.find((a) => a.startsWith("--zips="));
const ZIPS = zipArg ? new Set(zipArg.slice(7).split(",")) : null;
const TYPE_MAP = { foodbank: "pantry", fridge: "community_fridge", market: "farmers_market", csa: "csa", garden: "community_garden", urbanfarm: "urban_farm" };
const GROWING = new Set(["community_garden", "urban_farm"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_RE = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

// Minimal RFC-4180 CSV parser (handles quotes, commas and newlines inside quotes).
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const keys = head.map((h) => h.replace(/^\uFEFF/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

const to24 = (h, m, ap) => {
  let H = Number(h) % 12; if (/p/i.test(ap)) H += 12;
  return `${String(H).padStart(2, "0")}:${m || "00"}`;
};
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;

function daysIn(seg) {
  const days = new Set();
  const range = seg.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*(?:-|–|through|to)\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*/i);
  if (range) {
    const a = DAY_RE[range[1].toLowerCase()], b = DAY_RE[range[2].toLowerCase()];
    for (let i = a; ; i = (i + 1) % 7) { days.add(DAYS[i]); if (i === b) break; }
  }
  for (const m of seg.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*/gi)) days.add(DAYS[DAY_RE[m[1].toLowerCase()]]);
  if (/daily|every day|7 days/i.test(seg)) DAYS.forEach((d) => days.add(d));
  return days;
}

// Seasonal strings like "June through November": returns false if this month is outside the season.
function inSeason(s, now = new Date()) {
  const m = s.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(?:-|–|through|to)\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  if (!m) return true;
  const a = MONTHS.indexOf(m[1]), b = MONTHS.indexOf(m[2]), c = now.getMonth();
  return a <= b ? c >= a && c <= b : c >= a || c <= b;
}

// Returns {hours, raw, note}; hours is null when the string can't be parsed confidently.
function parseHours(raw) {
  const s = String(raw || "").trim();
  if (!s || /varies|call ahead|by appointment/i.test(s)) return { hours: null, raw: s || null };
  if (/24\s*\/\s*7|24 hours/i.test(s)) return { hours: Object.fromEntries(DAYS.map((d) => [d, [["00:00", "23:59"]]])), raw: s };
  if (!inSeason(s)) return { hours: {}, raw: s, note: "out of season" };
  const hours = {};
  for (const seg of s.split(/;|\n/)) {
    if (/clos/i.test(seg) && !TIME_RE.test(seg)) continue;
    TIME_RE.lastIndex = 0;
    const days = daysIn(seg);
    const slots = [...seg.matchAll(TIME_RE)].map((t) => [to24(t[1], t[2], t[3] || t[6]), to24(t[4], t[5], t[6])]);
    for (const d of days) for (const sl of slots) (hours[d] ||= []).push(sl);
  }
  return Object.keys(hours).length ? { hours, raw: s } : { hours: null, raw: s };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const normName = (s) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
// "2139 Adam Clayton Powell Jr Boulevard" and "2139 Adam Clayton Powell Jr Blvd (at 127th)" -> "2139 adam"
const addrKey = (a) => { const m = String(a || "").toLowerCase().match(/(\d+)\s+(?:w(?:est)?\.?\s+|e(?:ast)?\.?\s+)?([a-z0-9]+)/); return m ? `${m[1]} ${m[2]}` : null; };

const csvPath = process.argv[2];
if (!csvPath || !existsSync(csvPath)) { console.error("Give the CSV path, e.g. node scripts/import_sbtp.js C:\\...\\locations_rows.csv"); process.exit(1); }

const rows = parseCSV(readFileSync(csvPath, "utf8"));
const outPath = new URL("../data/sources.json", import.meta.url);
const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : [];
const seen = new Set(existing.map((s) => normName(s.name)));
const seenAddr = new Set(existing.map((s) => addrKey(s.address)).filter(Boolean));
const ids = new Set(existing.map((s) => s.id));

let added = 0, withHours = 0, skipped = 0;
for (const r of rows) {
  const type = TYPE_MAP[r.type];
  const zip = r.zip_code || (r.address.match(/\b(100\d\d)\b/) || [])[1];
  if (!type || (ZIPS && !ZIPS.has(zip)) || r.status === "inactive") { skipped++; continue; }
  const name = r.name.trim();
  if (seen.has(normName(name)) || seenAddr.has(addrKey(r.address))) {
    // duplicate or already hand-verified: keep yours, but fill in missing coordinates
    const ex = existing.find((e) => normName(e.name) === normName(name) || addrKey(e.address) === addrKey(r.address));
    if (ex && ex.lat == null && r.latitude) { ex.lat = Number(r.latitude); ex.lng = Number(r.longitude); }
    continue;
  }
  // Gardens/farms: their listed hours are visiting hours, NOT food distribution hours. Import with no
  // schedulable hours; the refresh agent finds out whether and when they give or sell food.
  const parsed = parseHours(r.open_hours || r.hours);
  const { hours, raw, note } = GROWING.has(type) ? { hours: null, raw: parsed.raw ? `garden open hours (not food): ${parsed.raw}` : null } : parsed;
  let id = slug(name) || r.id; while (ids.has(id)) id += "-x";
  existing.push({
    id, name, aliases: [], type, address: r.address,
    hours: hours || {},
    hours_raw: raw, ...(note ? { hours_note: note } : {}),
    eligibility: ["community_fridge", "farmers_market", "community_garden", "urban_farm"].includes(type) ? "open to all" : "unknown - call ahead",
    cost: type === "farmers_market" || type === "csa" ? "paid" : GROWING.has(type) ? "unknown" : "free",
    accepts_snap: type === "farmers_market" ? true : false,
    health_bucks: type === "farmers_market",
    offers: r.local_items_selling ? [r.local_items_selling] : [],
    ...(GROWING.has(type) ? { food_distribution: "unknown" } : {}),
    phone: r.phone || null, website: r.website || r.social_media_website1 || null,
    lat: Number(r.latitude) || null, lng: Number(r.longitude) || null,
    verified_by: `UNVERIFIED - Saved by the Plate map export (source: ${r.source}, last updated ${r.updated_at.slice(0, 10)})`,
    stock: null,
  });
  ids.add(id); seen.add(normName(name)); if (addrKey(r.address)) seenAddr.add(addrKey(r.address)); added++; if (hours && Object.keys(hours).length) withHours++;
}
writeFileSync(outPath, JSON.stringify(existing, null, 2));
console.log(`Added ${added} sources (${withHours} with usable hours, ${added - withHours} hours unknown). Skipped ${skipped} rows (no food distribution, inactive, or outside --zips).`);
console.log(`data/sources.json now has ${existing.length} sources.`);
