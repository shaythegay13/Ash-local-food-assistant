// Offline checks for the deterministic parts (no API key needed): node lib/selftest.js
import assert from "node:assert/strict";
import { openWindows, isWithin } from "./hours.js";
import { checkPlan, matchSource } from "./check.js";

const sources = [
  { id: "p1", name: "Harlem Grace Pantry", hours: { Tue: [["10:00", "13:00"]] }, eligibility: "open to all" },
  { id: "f1", name: "125th St Community Fridge", hours: Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => [d, [["00:00", "23:59"]]])) },
];
const profile = { budget_usd: 30, availability: [{ day: "Tue", start: "12:00", end: "18:00" }] };

const w = openWindows(sources[0], profile.availability);
assert.deepEqual(w, [{ day: "Tue", start: "12:00", end: "13:00" }]);
assert.ok(isWithin(w, "Tue", "12:30"));
assert.ok(!isWithin(w, "Tue", "11:00"));

const good = { stops: [{ source_id: "p1", day: "Tue", time: "12:15", expected_cost_usd: 0 }, { source_id: "f1", day: "Tue", time: "17:00", expected_cost_usd: 0 }], total_expected_cost_usd: 0 };
assert.ok(checkPlan(good, profile, sources).feasible);

const bad = { stops: [{ source_id: "p1", day: "Wed", time: "10:00" }, { name: "Imaginary Food Bank", day: "Tue", time: "12:00" }], total_expected_cost_usd: 45 };
const c = checkPlan(bad, profile, sources);
assert.equal(c.feasible, false);
assert.equal(c.counts.closed, 1);
assert.equal(c.counts.hallucinated, 1);
assert.ok(c.over_budget);

assert.equal(matchSource("Grace Pantry Harlem", sources)?.id, "p1");
assert.equal(matchSource("Bronx Food Hub", sources), null);
console.log("selftest passed");
import { allowedDays } from "./hours.js";
const sat = new Date("2026-11-21T12:00:00");
assert.deepEqual(allowedDays(6, sat), ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]);
const late = checkPlan({ stops: [{ source_id: "f1", day: "Fri", time: "18:00", expected_cost_usd: 0 }] }, { budget_period_days: 6 }, sources);
assert.equal(late.feasible, false);
console.log("period test passed");
import { travelMinutes } from "./geo.js";
const harlemToUnion = travelMinutes(40.8075, -73.9465, 40.7359, -73.9911);
assert.ok(harlemToUnion > 30 && harlemToUnion < 50, "Harlem->Union Sq " + harlemToUnion);
const harlemToBklyn = travelMinutes(40.8075, -73.9465, 40.6782, -73.9442);
assert.ok(harlemToBklyn > 45, "Harlem->Crown Heights " + harlemToBklyn);
console.log("travel test passed", { harlemToUnion, harlemToBklyn });
