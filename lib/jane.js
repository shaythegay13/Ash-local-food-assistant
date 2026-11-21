// Ash's pipeline. Model jobs:
// Ash is a new agent built at the Gemini 4 NYC hackathon (Nov 21, 2026); the file keeps its original name.
//   Hydrogen (fast)  -> intake: voice/photos/text -> structured profile; flyer reading
//   Decisions API    -> gates: eligibility per source, fridge/shelf stock from photos
//   Neon (fast reason) -> planner: cheapest feasible week from gated candidates (+1 repair pass)
// Baseline: one Hydrogen call with Google Search, same raw inputs, no map, no gates.
import { GoogleGenAI } from "@google/genai";
import { openWindows, allowedDays } from "./hours.js";
import { travelMinutes, boroughOf } from "./geo.js";
import { checkPlan } from "./check.js";

export const MODELS = {
  intake: process.env.INTAKE_MODEL || "gemini-4-hydrogen",
  // Neon: the builder guide's "fast frontier" model for reasoning while a user waits. Carbon was 1-2 min per plan.
  planner: process.env.PLANNER_MODEL || "gemini-4-neon",
  decide: process.env.DECIDE_MODEL || "gemini-decision-1",
  baseline: process.env.BASELINE_MODEL || "gemini-4-hydrogen",
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

// New models get 503 "overloaded" errors on launch week: retry with backoff on 429/500/503.
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const code = e?.status ?? e?.code ?? Number(String(e?.message).match(/\b(429|500|503)\b/)?.[1]);
      if (i >= tries - 1 || ![429, 500, 503].includes(Number(code))) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
}
const gen = (args) => retry(() => ai.models.generateContent(args));
const decide = (args) => retry(() => ai.decisions.create(args));

export function parseJSON(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("Model returned no JSON: " + t.slice(0, 200));
  return JSON.parse(t.slice(a, b + 1));
}

const media = (m) => ({ inlineData: { mimeType: m.mimeType, data: m.data } });

// Structured outputs (builder guide: declare schemas, don't ask for raw JSON in plain text).
const str = { type: "string" }, num = { type: "number" }, bool = { type: "boolean" };
const nullable = (t) => ({ anyOf: [t, { type: "null" }] });
const arr = (items) => ({ type: "array", items });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
const slot = obj({ day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }, start: str, end: str });

const PROFILE_SCHEMA = obj({
  language: str, transcript: str,
  budget_usd: nullable(num), budget_period_days: nullable(num), budget_raw: nullable(str),
  has_snap: nullable(bool),
  household: obj({ adults: nullable(num), children: nullable(num) }),
  location: nullable(str), home_lat: nullable(num), home_lng: nullable(num),
  home_borough: { anyOf: [{ type: "string", enum: ["M", "X", "K", "Q", "S"] }, { type: "null" }] },
  max_travel_minutes: nullable(num), availability: arr(slot),
  diet: arr(str), equipment: arr(str), food_on_hand: arr(str),
  follow_up_question: nullable(str),
});
const FLYER_SCHEMA = obj({
  name: nullable(str), address: nullable(str),
  hours: arr(slot), eligibility: nullable(str), accepts_snap: nullable(bool),
  notes: nullable(str), unreadable_fields: arr(str),
});
const PLAN_SCHEMA = obj({
  say: str,
  stops: arr(obj({ source_id: str, day: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
    time: str, get: str, expected_cost_usd: num, why: str })),
  total_expected_cost_usd: num,
  days_covered_estimate: num,
  gap_note: nullable(str),
  caveats: arr(str),
});
const json = (schema) => ({ responseMimeType: "application/json", responseJsonSchema: schema });
// Thinking levels (builder guide): low for the live path; override with INTAKE_THINKING / PLANNER_THINKING.
const think = (lvl) => ({ thinkingConfig: { thinkingLevel: String(lvl).toUpperCase() } });

// ---------- 1. Intake (Hydrogen) ----------
const INTAKE_PROMPT = `You are Ash's intake step for a NYC food-access assistant.
The person may have spoken (audio), typed, and/or sent photos (their fridge, cupboard, a receipt,
a benefits balance screen). Extract a profile. Do not invent facts; use null when unknown.
If a photo shows food they already have, list it in food_on_hand. If it shows a balance or receipt,
use it for budget but never repeat account or card numbers.
If they name a neighborhood, cross streets or address in NYC, set home_lat/home_lng to its approximate coordinates (neighborhood center is fine); null if unknown.
home_borough: M=Manhattan, X=Bronx, K=Brooklyn, Q=Queens, S=Staten Island; null if unknown.
max_travel_minutes: only if they say how far they'll go ("I don't want to go far" = 20); else null.
availability = WHEN THEY CAN GO GET FOOD. Include every constraint they state, in any form:
  "free after 5" (weekdays 17:00-21:00 unless they say otherwise), "I usually shop on Saturdays" (Sat 08:00-20:00),
  "only weekends" (Sat+Sun), "not Tuesday" (every other day), "mornings" (08:00-12:00).
  A day with no time given = 08:00-20:00. Write 24h HH:MM. If they gave NO timing at all, use [].
  Never add days they didn't mention when they named specific days.
  When merging with a prior profile, keep earlier availability unless they change it. diet = cultural/religious only (halal, kosher, vegetarian), never medical.
follow_up_question: ONE short question in their language if budget or location is unknown, else null.`;

export async function intake({ text, audio, images = [], priorProfile = null }) {
  const parts = [{ text: INTAKE_PROMPT }];
  if (priorProfile) parts.push({ text: `Profile so far (merge new info into it): ${JSON.stringify(priorProfile)}` });
  if (text) parts.push({ text: `Person typed: ${text}` });
  if (audio) parts.push(media(audio));
  for (const img of images) parts.push(media(img));
  const res = await gen({
    model: MODELS.intake,
    contents: [{ role: "user", parts }],
    config: { ...json(PROFILE_SCHEMA), ...think(process.env.INTAKE_THINKING || "low") },
  });
  return parseJSON(res.text);
}

// ---------- 2. Gates (Decisions API) ----------
// One call, one question per source with a non-trivial eligibility rule.
export async function eligibility(profile, sources) {
  const questions = {};
  for (const s of sources) {
    if (!s.eligibility || /^(open to all|none|anyone)$/i.test(s.eligibility.trim()) || /^unknown/i.test(s.eligibility)) continue;
    questions[`elig_${s.id}`] = {
      type: "noul",
      instructions: `Does this person meet the program's eligibility rule? Rule: "${s.eligibility}". Treat unknown profile fields as unknown, not as disqualifying.`,
      criteria: {
        true_description: "The person qualifies or very likely qualifies.",
        false_description: "The rule clearly excludes this person.",
      },
    };
  }
  if (!Object.keys(questions).length) return {};
  const r = await decide({
    model: MODELS.decide,
    input: [{ type: "text", text: `Person profile:\n${JSON.stringify(profile)}` }],
    questions,
  });
  const out = {};
  for (const [k, v] of Object.entries(r.answers || {})) out[k.replace(/^elig_/, "")] = { p: v.noul, confidence: v.confidence };
  return out;
}

// Read a fridge / pantry shelf photo (e.g. a saved Instagram post).
export async function readStock({ data, mimeType }) {
  const r = await decide({
    model: MODELS.decide,
    input: [
      { type: "text", text: "Photo of a NYC community fridge or food pantry shelf." },
      { type: "image", data, mime_type: mimeType, resolution: "medium" },
    ],
    questions: {
      stock: {
        type: "choice",
        instructions: "How stocked is the fridge or shelf?",
        criteria: {
          stocked: "Mostly full of food.",
          low: "Some food, mostly empty.",
          empty: "Little or no food.",
          other: "Unreadable photo or not a fridge/shelf.",
        },
      },
      produce: { type: "noul", instructions: "Is fresh fruit or vegetables visible?" },
      unsafe: { type: "noul", instructions: "Are visibly unsafe items present (spoiled, moldy, opened containers, raw meat)?" },
    },
  });
  const a = r.answers;
  return {
    // low-confidence reads are not trusted (builder guide: check confidence in code)
    status: a.stock.confidence < 0.75 || a.stock.choice === "other" ? "unknown" : a.stock.choice,
    confidence: a.stock.confidence,
    produce_p: a.produce.noul,
    unsafe_p: a.unsafe.noul,
    observed_at: new Date().toISOString(),
  };
}

// Read hours/eligibility off a flyer or door sign (Hydrogen).
export async function readFlyer({ data, mimeType }) {
  const res = await gen({
    model: MODELS.intake,
    contents: [{ role: "user", parts: [
      { text: `Read this food pantry / fridge flyer or door sign. Never guess hours you cannot read; list them in unreadable_fields.` },
      media({ data, mimeType }),
    ] }],
    config: json(FLYER_SCHEMA),
  });
  const f = parseJSON(res.text);
  // flatten slots into the sources.json hours shape
  f.hours = (f.hours || []).reduce((h, s) => ((h[s.day] ||= []).push([s.start, s.end]), h), {});
  return f;
}

// ---------- 3. Planner (Neon) + verify + repair ----------
const PLAN_PROMPT = `You are Ash's planner. Build the cheapest FEASIBLE plan for the coming week that feeds
this household within budget. Prefer free sources first, then SNAP / Health Bucks options, then cheapest paid.
HARD RULES:
- Use ONLY source_id values from the candidate list.
- Schedule each stop on a day and time INSIDE that candidate's open_windows. open_windows are already limited to
  the days and times the person said they can go; never schedule outside them, even for a "great" option.
- hours_verified false: hours come from an older directory; tell them to confirm before going.
- eligibility_uncertain: tell them to confirm eligibility with that site, and include a backup.
- Stock "empty" or "unknown": don't rely on it alone; add a backup.
- Respect cultural/religious diet. Use food_on_hand to avoid duplicate pickups.
- total_expected_cost_usd must be <= budget_usd when a budget is given.
- Cover the WHOLE household (adults + children) for the WHOLE budget period. A longer trip (e.g. a big year-round
  farmers market) is worth it when it stretches the budget a lot; otherwise prefer closer stops (see travel_minutes).
- days_covered_estimate: your honest estimate of how many of the period's days this plan feeds the household.
  If it falls short, say so in gap_note (e.g. "covers about 4 of 6 days; call these pantries to fill the gap").
"say" = 2-4 short spoken sentences in the person's language. Stay on where/when/how much; no nutrition or health advice.`;

// Step 1: cheap filters in code: open in the period, inside availability, within travel range.
const DEFAULT_MAX_TRAVEL = 45; // minutes
const MAX_CANDIDATES = 25; // fewer, closer candidates = a much faster planner call
function prefilter(profile, sources) {
  const inPeriod = allowedDays(profile.budget_period_days);
  const maxT = profile.max_travel_minutes || DEFAULT_MAX_TRAVEL;
  return sources
    .map((s) => ({
      s,
      windows: openWindows(s, profile.availability).filter((w) => inPeriod.includes(w.day)),
      travel: travelMinutes(profile.home_lat, profile.home_lng, s.lat, s.lng, profile.home_borough, boroughOf(s.address)),
    }))
    // if we know where the person is, a source with no coordinates can't be placed, so leave it out
    .filter((x) => !x.s.season_end || x.s.season_end >= new Date().toISOString().slice(0, 10)) // seasonal source has ended
    .filter((x) => x.windows.length > 0 && (x.travel === null ? profile.home_lat == null : x.travel <= maxT))
    .sort((a, b) => (a.travel ?? 99) - (b.travel ?? 99))
    .slice(0, MAX_CANDIDATES);
}

function candidatesFor(pre, elig) {
  const now = Date.now();
  return pre
    .map(({ s, windows, travel }) => {
      const fresh = s.stock && now - Date.parse(s.stock.observed_at) < 48 * 3600e3;
      return {
        source_id: s.id, name: s.name, type: s.type, address: s.address,
        travel_minutes: travel, open_windows: windows,
        cost: s.cost, accepts_snap: s.accepts_snap, health_bucks: s.health_bucks,
        offers: s.offers, eligibility_rule: s.eligibility || "open to all",
        eligibility_p: elig[s.id]?.p ?? null,
        eligibility_uncertain: elig[s.id] ? elig[s.id].confidence < 0.75 : /^unknown/i.test(s.eligibility || ""),
        hours_verified: !/^UNVERIFIED/.test(s.verified_by || ""),
        stock: fresh ? s.stock.status : "unknown",
      };
    })
    .filter((c) => c.eligibility_p === null || c.eligibility_p >= 0.35 || c.eligibility_uncertain);
}

async function callPlanner(profile, candidates, feedback) {
  const parts = [
    { text: PLAN_PROMPT },
    { text: `Today is ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()]}. Profile: ${JSON.stringify(profile)}` },
    { text: `Candidates: ${JSON.stringify(candidates)}` },
  ];
  if (feedback) parts.push({ text: `Your previous plan FAILED verification. Fix every error:\n${feedback}` });
  const res = await gen({
    model: MODELS.planner,
    contents: [{ role: "user", parts }],
    config: { ...json(PLAN_SCHEMA), ...think(process.env.PLANNER_THINKING || "low") },
  });
  return parseJSON(res.text);
}

export async function janePlan(profile, sources, { maxRepairs = 1 } = {}) {
  const t0 = Date.now();
  const pre = prefilter(profile, sources);
  const elig = await eligibility(profile, pre.map((x) => x.s)); // Decisions API only on what survived the code filters
  const candidates = candidatesFor(pre, elig);
  const attempts = [];
  let plan = await callPlanner(profile, candidates);
  const eligP = Object.fromEntries(Object.entries(elig).filter(([, v]) => v.confidence >= 0.75).map(([k, v]) => [k, v.p]));
  let check = checkPlan(plan, profile, sources, { eligibility: eligP });
  attempts.push(check);
  for (let i = 0; i < maxRepairs && !check.feasible; i++) {
    plan = await callPlanner(profile, candidates, check.errors.join("\n"));
    check = checkPlan(plan, profile, sources, { eligibility: eligP });
    attempts.push(check);
  }
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  for (const st of plan.stops || []) {
    const s = byId[st.source_id];
    if (s) Object.assign(st, { name: s.name, address: s.address,
      travel_minutes: travelMinutes(profile.home_lat, profile.home_lng, s.lat, s.lng, profile.home_borough, boroughOf(s.address)),
      hours_verified: !/^UNVERIFIED/.test(s.verified_by || ""),
      lat: s.lat, lng: s.lng, type: s.type, accepts_snap: s.accepts_snap, health_bucks: s.health_bucks,
      needs_id: /\bID\b|identification/i.test(s.eligibility || "") });
  }
  const ms = Date.now() - t0;
  console.log(`[plan] ${candidates.length} candidates, ${attempts.length} planner call(s), ${(ms / 1000).toFixed(1)}s`);
  return { plan, check, attempts, eligibility: eligP, candidate_count: candidates.length, ms };
}

// ---------- Baseline: one call, web search, same raw inputs ----------
export async function baselinePlan({ text, audio, images = [] }) {
  const parts = [{ text: `You help people in Harlem, NYC find food on a budget. Using the person's message
(audio/text/photos), make a plan for the coming week. Search the web for real places and hours.
Return ONLY JSON: {"budget_usd": number|null, "stops":[{"name":"...","address":"...","day":"Mon","time":"HH:MM","expected_cost_usd":number}],
"total_expected_cost_usd": number}` }];
  if (text) parts.push({ text: `Person typed: ${text}` });
  if (audio) parts.push(media(audio));
  for (const img of images) parts.push(media(img));
  const res = await gen({
    model: MODELS.baseline,
    contents: [{ role: "user", parts }],
    config: { tools: [{ googleSearch: {} }] },
  });
  return parseJSON(res.text);
}
