// Feasibility checker: the core of the eval. Every stop must be a real verified source,
// open when scheduled, inside the person's availability, and the plan must fit the budget.
import { openWindows, isWithin, allowedDays, alreadyPassed } from "./hours.js";
import { travelMinutes, boroughOf } from "./geo.js";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
function nameSim(a, b) {
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / new Set([...A, ...B]).size;
}

// For baseline plans that cite names instead of ids.
export function matchSource(name, sources) {
  let best = null, score = 0;
  for (const s of sources) {
    const sc = Math.max(nameSim(name, s.name), ...(s.aliases || []).map((a) => nameSim(name, a)));
    if (sc > score) { score = sc; best = s; }
  }
  return score >= 0.5 ? best : null;
}

export function checkPlan(plan, profile, sources, { eligibility = {} } = {}) {
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  const errors = [];
  let hallucinated = 0, closed = 0, outsideAvail = 0, ineligible = 0;
  const stops = plan?.stops || [];
  const inPeriod = allowedDays(profile?.budget_period_days);

  for (const [i, stop] of stops.entries()) {
    const src = stop.source_id ? byId[stop.source_id] : matchSource(stop.name, sources);
    if (!src) {
      hallucinated++;
      errors.push(`Stop ${i + 1} ("${stop.name || stop.source_id}") is not a verified source.`);
      continue;
    }
    if (!inPeriod.includes(stop.day)) {
      outsideAvail++;
      errors.push(`Stop ${i + 1} (${src.name}) on ${stop.day} falls after the budget period ends.`);
      continue;
    }
    if (stop.time && alreadyPassed(stop.day, stop.time)) {
      closed++;
      errors.push(`Stop ${i + 1} (${src.name}) is scheduled for ${stop.day} ${stop.time}, which has already passed today.`);
      continue;
    }
    const openAny = openWindows(src, []);
    if (!isWithin(openAny, stop.day, stop.time)) {
      closed++;
      errors.push(`Stop ${i + 1} (${src.name}) is closed on ${stop.day} at ${stop.time}.`);
    } else if (profile?.availability?.length && !isWithin(openWindows(src, profile.availability), stop.day, stop.time)) {
      outsideAvail++;
      errors.push(`Stop ${i + 1} (${src.name}) at ${stop.day} ${stop.time} is outside the person's availability.`);
    }
    const t = travelMinutes(profile?.home_lat, profile?.home_lng, src.lat, src.lng, profile?.home_borough, boroughOf(src.address));
    if (t !== null && t > (profile?.max_travel_minutes || 45)) {
      outsideAvail++;
      errors.push(`Stop ${i + 1} (${src.name}) is about ${t} min away, over the ${profile?.max_travel_minutes || 45}-min travel limit.`);
    }
    const p = eligibility[src.id];
    if (p !== undefined && p < 0.5) {
      ineligible++;
      errors.push(`Stop ${i + 1} (${src.name}): person likely doesn't qualify (p=${p.toFixed(2)}).`);
    }
  }

  const total = Number(plan?.total_expected_cost_usd ?? stops.reduce((a, s) => a + (Number(s.expected_cost_usd) || 0), 0));
  const budget = profile?.budget_usd;
  const overBudget = budget != null && total > budget + 0.01;
  if (overBudget) errors.push(`Plan costs $${total.toFixed(2)}, over the $${budget} budget.`);
  if (!stops.length) errors.push("Plan has no stops.");

  return {
    feasible: errors.length === 0,
    errors,
    counts: { stops: stops.length, hallucinated, closed, outsideAvail, ineligible },
    total_cost: total,
    budget,
    over_budget: overBudget,
  };
}
