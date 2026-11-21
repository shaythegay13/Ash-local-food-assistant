// Background source refresher: an Antigravity Managed Agent (Google-hosted Linux sandbox with web access)
// looks up current hours for food sources whose hours are missing or stale, then the Decisions API
// gates each proposed update before it touches data/sources.json.
//
// Usage (PowerShell, from the jane folder):
//   node --env-file=.env.local scripts/refresh_agent.js --near=40.8085,-73.9465 --limit=8
//   --near=lat,lng   refresh the sources closest to this point (default: 125th St, Harlem)
//   --limit=N        how many sources per run (keep it small; the hackathon account watches for abuse)
//   --dry            write proposals to data/agent_updates.json without changing sources.json
//
// Every run appends to data/agent_log.json so you can show judges exactly what the agent changed.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { travelMinutes } from "../lib/geo.js";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const [nearLat, nearLng] = arg("near", "40.8085,-73.9465").split(",").map(Number);
const LIMIT = Number(arg("limit", "8"));
const DRY = process.argv.includes("--dry");
const AGENT = process.env.REFRESH_AGENT || "antigravity-preview-09-2026";
const AGENT_MODEL = process.env.REFRESH_MODEL || "gemini-4-hydrogen";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
const SRC = new URL("../data/sources.json", import.meta.url);
const sources = JSON.parse(readFileSync(SRC, "utf8"));

// 1. Pick what needs refreshing: no usable hours, or hours that only came from an old directory.
const needs = sources
  .filter((s) => !/^(AGENT-VERIFIED|called|verified)/i.test(s.verified_by || ""))
  .filter((s) => Object.keys(s.hours || {}).length === 0 || /^UNVERIFIED/.test(s.verified_by || ""))
  .filter((s) => s.type !== "community_fridge") // fridges are 24/7; stock comes from photos instead
  .map((s) => ({ s, t: travelMinutes(nearLat, nearLng, s.lat, s.lng) ?? 999 }))
  .sort((a, b) => a.t - b.t)
  .slice(0, LIMIT)
  .map(({ s }) => s);

if (!needs.length) { console.log("Nothing to refresh."); process.exit(0); }
console.log(`Agent will check ${needs.length} sources:\n` + needs.map((s) => `  - ${s.name} (${s.address})`).join("\n"));

const TASK = `You are a research agent keeping a NYC free-food directory accurate. For EACH source below, find its
CURRENT hours of food distribution (pantry/market/meal hours, not office hours) and eligibility rules.
Use the web from your sandbox: the org's website, its Instagram/Facebook, foodhelpline.org (Lemontree),
plentiful.org, nycfoodpolicy.org, the Food Bank For NYC finder. Prefer pages updated in 2026.
Rules:
- Never guess. If you can't find current hours, return hours: null and say why.
- evidence_quote must be ONE contiguous, verbatim excerpt copied from the page (no "..." and no stitching
  pieces together) that itself contains the days and times. Give its URL.
- If the hours only run until a date (seasonal markets, "until November 27"), put that date in season_end (YYYY-MM-DD).
- Note seasonal end dates, "call ahead", appointment-only, or "temporarily closed".
When done, print ONLY a JSON array, one object per source, in this shape:
[{"id": "...", "found": true|false, "hours": [{"day":"Mon","start":"HH:MM","end":"HH:MM"}] | null,
  "eligibility": string|null, "status": "open"|"temporarily_closed"|"permanently_closed"|"unknown",
  "evidence_quote": string|null, "evidence_url": string|null, "evidence_date": string|null,
  "season_end": "YYYY-MM-DD"|null, "notes": string|null}]
Sources:
${JSON.stringify(needs.map((s) => ({ id: s.id, name: s.name, address: s.address, phone: s.phone || null, website: s.website || null, last_known_hours: s.hours_raw || null })), null, 1)}`;

// 2. Run the Managed Agent in a Google-hosted sandbox with web egress, in the background, and poll.
console.log(`\nStarting ${AGENT} (${AGENT_MODEL}) in a hosted sandbox...`);
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
  process.stdout.write(`\r  status: ${run.status} (${Math.round((Date.now() - t0) / 1000)}s)   `);
}
console.log();
if (run.status !== "completed") { console.error("Agent did not complete:", run.status, JSON.stringify(run.errors || "")); process.exit(1); }

const text = run.output_text || "";
const a = text.indexOf("["), b = text.lastIndexOf("]");
if (a < 0 || b < 0) { console.error("Agent returned no JSON:\n" + text.slice(0, 1500)); process.exit(1); }
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
  if (!g.accepted) continue;
  s.hours = g.hours.reduce((h, x) => ((h[x.day] ||= []).push([x.start, x.end]), h), {});
  if (g.eligibility) s.eligibility = g.eligibility;
  if (g.season_end) s.season_end = g.season_end;
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

console.table(gated.map((g) => ({ id: g.id, found: g.found, status: g.status, accepted: g.accepted, p: g.p_supported?.toFixed?.(2) ?? "-" })));
console.log(`${DRY ? "[dry run] would apply" : "Applied"} ${gated.filter((g) => g.accepted).length} of ${needs.length}. Details: data/agent_updates.json`);
