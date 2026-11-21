// The refresh agent as a reusable function, used by the CLI script and by the server in the background.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { travelMinutes } from "./geo.js";

const AGENT = process.env.REFRESH_AGENT || "antigravity-preview-09-2026";
const AGENT_MODEL = process.env.REFRESH_MODEL || "gemini-4-hydrogen";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
const SRC = new URL("../data/sources.json", import.meta.url);


export async function runRefresh({ nearLat, nearLng, limit = 8, types = null, staleDays = 30, dry = false, verbose = false } = {}) {
const LIMIT = limit, DRY = dry, STALE_DAYS = staleDays, TYPES = types ? new Set(types) : null;
const say = (...m) => (verbose ? console.log(...m) : console.log("[refresh]", ...m));
const sources = JSON.parse(readFileSync(SRC, "utf8"));
// 1. Pick what needs refreshing: missing hours, hours only from an old directory, gardens/farms whose food
//    distribution is unknown, and anything the agent verified more than STALE_DAYS ago.
const ageDays = (vb) => { const m = String(vb || "").match(/AGENT-(?:VERIFIED|CHECKED) (\d{4}-\d{2}-\d{2})/); return m ? (Date.now() - Date.parse(m[1])) / 864e5 : null; };
const needsRefresh = (s) => {
  if (/^(called|verified)/i.test(s.verified_by || "")) return false; // checked by a human: leave it
  const age = ageDays(s.verified_by);
  if (age !== null) return age > STALE_DAYS; // agent-checked: only once it's stale
  return Object.keys(s.hours || {}).length === 0 || /^UNVERIFIED/.test(s.verified_by || "") || s.food_distribution === "unknown";
};
const needs = sources
  .filter(needsRefresh)
  .filter((s) => s.type !== "community_fridge") // fridges are 24/7; stock comes from photos instead
  .filter((s) => !TYPES || TYPES.has(s.type))
  .map((s) => ({ s, t: travelMinutes(nearLat, nearLng, s.lat, s.lng) ?? 999 }))
  .sort((a, b) => a.t - b.t)
  .slice(0, LIMIT)
  .map(({ s }) => s);

if (!needs.length) { say("Nothing to refresh."); return { checked: 0, accepted: 0 }; }
say(`Agent will check ${needs.length} sources:\n` + needs.map((s) => `  - ${s.name} (${s.address})`).join("\n"));

const TASK = `You are a research agent keeping a NYC free-food directory accurate. For EACH source below, find its
CURRENT hours of food distribution (pantry/market/meal hours, not office hours) and eligibility rules.
Use the web from your sandbox: the org's website, its Instagram/Facebook, foodhelpline.org (Lemontree),
plentiful.org, nycfoodpolicy.org, the Food Bank For NYC finder. Prefer pages updated in 2026.
Rules:
- Never guess. If you can't find current hours, return hours: null and say why.
- evidence_quote must be ONE contiguous, verbatim excerpt copied from the page (no "..." and no stitching
  pieces together) that itself contains the days and times. Give its URL.
- Community gardens and urban farms: find out whether they GIVE AWAY or SELL food to the public (produce
  distributions, farm stands, CSA pickups, community harvest days) and when. Their general "garden open" hours
  do not count. If they don't distribute food to the public, set status "no_public_food".
- If the hours only run until a date (seasonal markets, "until November 27"), put that date in season_end (YYYY-MM-DD).
- Note seasonal end dates, "call ahead", appointment-only, or "temporarily closed".
When done, print ONLY a JSON array, one object per source, in this shape:
[{"id": "...", "found": true|false, "hours": [{"day":"Mon","start":"HH:MM","end":"HH:MM"}] | null,
  "eligibility": string|null, "status": "open"|"temporarily_closed"|"permanently_closed"|"no_public_food"|"unknown",
  "offers": [what food, e.g. "free produce", "farm stand"] | null, "cost": "free"|"paid"|null,
  "evidence_quote": string|null, "evidence_url": string|null, "evidence_date": string|null,
  "season_end": "YYYY-MM-DD"|null, "notes": string|null}]
Sources:
${JSON.stringify(needs.map((s) => ({ id: s.id, name: s.name, type: s.type, address: s.address, phone: s.phone || null, website: s.website || null, last_known_hours: s.hours_raw || null })), null, 1)}`;

// 2. Run the Managed Agent in a Google-hosted sandbox with web egress, in the background, and poll.
say(`\nStarting ${AGENT} (${AGENT_MODEL}) in a hosted sandbox...`);
let run = await ai.interactions.create({
  agent: AGENT,
  environment: { type: "remote", network: { allowlist: [{ domain: "*" }] } },
  agent_config: { type: "antigravity", model: AGENT_MODEL, max_total_tokens: "400000" },
  input: TASK,
  background: true,
});
const t0 = Date.now();
while (["in_progress", "queued", undefined].includes(run.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  run = await ai.interactions.get(run.id);
  if (verbose) process.stdout.write(`\r  status: ${run.status} (${Math.round((Date.now() - t0) / 1000)}s)   `);
}
if (verbose) console.log();
if (run.status !== "completed") throw new Error(`Agent did not complete: ${run.status} ${JSON.stringify(run.errors || "")}`);

const text = run.output_text || "";
const a = text.indexOf("["), b = text.lastIndexOf("]");
if (a < 0 || b < 0) throw new Error("Agent returned no JSON: " + text.slice(0, 500));
const proposals = JSON.parse(text.slice(a, b + 1));

// 3. Gate each proposal with the Decisions API: does the quoted evidence actually support these hours, and is it current?
const gated = [];
for (const p of proposals) {
  if (!p.found || !p.hours?.length || !p.evidence_quote) { gated.push({ ...p, accepted: false, reason: "no evidence" }); continue; }
  const d = await ai.decisions.create({
    model: process.env.DECIDE_MODEL || "gemini-decision-1",
    input: [{ type: "text", text: `Today is ${new Date().toDateString()}.\nProposed hours: ${JSON.stringify(p.hours)}\nStatus: ${p.status}\nEvidence (from ${p.evidence_url}, dated ${p.evidence_date || "unknown"}):\n"${p.evidence_quote}"` }],
    questions: {
      supported: { type: "noul", instructions: "Does the evidence text clearly state these exact days and times for food distribution?",
        criteria: { true_description: "The quote states the same days and times.", false_description: "The quote is vague, different, or about office hours." } },
      current: { type: "noul", instructions: "Do these hours still apply today? A schedule that says it runs until a date that is still in the future counts as current." },
    },
  });
  const sup = d.answers.supported, cur = d.answers.current;
  const accepted = sup.noul >= 0.8 && cur.noul >= 0.6 && sup.confidence >= 0.75 && p.status === "open";
  gated.push({ ...p, accepted, p_supported: sup.noul, p_current: cur.noul, reason: accepted ? "evidence supports hours" : "gate rejected" });
}

// 4. Apply accepted updates (with a backup), and log everything.
const today = new Date().toISOString().slice(0, 10);
const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
let applied = 0;
for (const g of gated) {
  const s = byId[g.id];
  if (!s) continue;
  if (g.status === "permanently_closed" || g.status === "temporarily_closed") { s.hours = {}; s.hours_note = g.status; }
  if (g.status === "no_public_food" && g.found) { s.hours = {}; s.food_distribution = "none"; s.verified_by = `AGENT-CHECKED ${today}: no public food distribution found`; }
  if (!g.accepted) continue;
  s.hours = g.hours.reduce((h, x) => ((h[x.day] ||= []).push([x.start, x.end]), h), {});
  if (g.eligibility) s.eligibility = g.eligibility;
  if (g.season_end) s.season_end = g.season_end;
  if (g.offers?.length) s.offers = g.offers;
  if (g.cost) s.cost = g.cost;
  if (s.food_distribution === "unknown") s.food_distribution = "yes";
  s.verified_by = `AGENT-VERIFIED ${today} from ${g.evidence_url} (p=${g.p_supported.toFixed(2)})`;
  applied++;
}
writeFileSync(new URL("../data/agent_updates.json", import.meta.url), JSON.stringify(gated, null, 2));
const logPath = new URL("../data/agent_log.json", import.meta.url);
const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
log.push({ at: new Date().toISOString(), agent: AGENT, model: AGENT_MODEL, checked: needs.length,
  found: gated.filter((g) => g.found).length, accepted: gated.filter((g) => g.accepted).length, dry: DRY });
writeFileSync(logPath, JSON.stringify(log, null, 2));
if (!DRY) { copyFileSync(SRC, new URL("../data/sources.backup.json", import.meta.url)); writeFileSync(SRC, JSON.stringify(sources, null, 2)); }

if (verbose) console.table(gated.map((g) => ({ id: g.id, found: g.found, status: g.status, accepted: g.accepted, p: g.p_supported?.toFixed?.(2) ?? "-" })));
say(`${DRY ? "[dry run] would apply" : "Applied"} ${gated.filter((g) => g.accepted).length} of ${needs.length}. Details: data/agent_updates.json`);
return { checked: needs.length, accepted: gated.filter((g) => g.accepted).length, gated };
}
