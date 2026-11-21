// Runs Ash vs. the baseline on every case in eval/cases/<case>/ and scores both with the same checker.
// Case folder: meta.json {"text": "...", "truth": {"budget_usd": 30, "availability": [...]} | null}
//              optional audio.<ext>, img0.<ext>, img1.<ext>...
// "truth" is what YOU confirm the person meant (budget, times). If null, Ash's own intake is used,
// which flatters Ash, so fill truth in for every case you can.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { intake, janePlan, baselinePlan } from "../lib/jane.js";
import { checkPlan } from "../lib/check.js";

const root = new URL("./cases/", import.meta.url);
const sources = JSON.parse(readFileSync(new URL("../data/sources.json", import.meta.url), "utf8"));
const MIME = { webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4", m4a: "audio/mp4", mp3: "audio/mp3", wav: "audio/wav",
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", heic: "image/heic", webp: "image/webp" };

function loadCase(dir) {
  const files = readdirSync(dir);
  const meta = existsSync(new URL("meta.json", dir)) ? JSON.parse(readFileSync(new URL("meta.json", dir), "utf8")) : {};
  const load = (f) => ({ mimeType: MIME[f.split(".").pop().toLowerCase()] || "application/octet-stream",
    data: readFileSync(new URL(f, dir)).toString("base64") });
  const audioF = files.find((f) => f.startsWith("audio."));
  return { meta, text: meta.text || null, audio: audioF ? load(audioF) : null,
    images: files.filter((f) => f.startsWith("img")).sort().map(load) };
}

const caseDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
if (!caseDirs.length) { console.log("No cases in eval/cases/. Save some from the app (checkbox) first."); process.exit(0); }

const rows = [];
for (const name of caseDirs) {
  const c = loadCase(new URL(`${name}/`, root));
  const row = { case: name };
  try {
    const profile = await intake(c);
    const truth = { ...profile, ...(c.meta.truth || {}) };
    const j = await janePlan(profile, sources);
    const jCheck = checkPlan(j.plan, truth, sources, { eligibility: j.eligibility });
    row.jane = { feasible: jCheck.feasible, ...jCheck.counts, cost: jCheck.total_cost, budget: jCheck.budget,
      over_budget: jCheck.over_budget, repaired: j.attempts.length > 1, first_try_feasible: j.attempts[0].feasible,
      followup: !!profile.follow_up_question, errors: jCheck.errors };
    const b = await baselinePlan(c);
    const bCheck = checkPlan(b, truth, sources);
    row.baseline = { feasible: bCheck.feasible, ...bCheck.counts, cost: bCheck.total_cost, over_budget: bCheck.over_budget, errors: bCheck.errors };
  } catch (e) {
    row.error = String(e.message || e);
  }
  rows.push(row);
  console.log(name, row.error ? `ERROR ${row.error}` : `jane=${row.jane.feasible} baseline=${row.baseline.feasible}`);
}

const ok = rows.filter((r) => !r.error);
const rate = (k, f) => ok.length ? (ok.filter((r) => f(r[k])).length / ok.length) : 0;
const sum = (k, f) => ok.reduce((a, r) => a + f(r[k]), 0);
const summary = {
  cases: rows.length, errored: rows.length - ok.length,
  jane: {
    feasible_rate: rate("jane", (x) => x.feasible),
    first_try_feasible_rate: rate("jane", (x) => x.first_try_feasible),
    hallucinated_stops: sum("jane", (x) => x.hallucinated),
    closed_stops: sum("jane", (x) => x.closed),
    over_budget_rate: rate("jane", (x) => x.over_budget),
  },
  baseline: {
    feasible_rate: rate("baseline", (x) => x.feasible),
    hallucinated_stops: sum("baseline", (x) => x.hallucinated),
    closed_stops: sum("baseline", (x) => x.closed),
    over_budget_rate: rate("baseline", (x) => x.over_budget),
  },
};
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ summary, rows }, null, 2));
console.table({ jane: summary.jane, baseline: summary.baseline });
console.log("Full results: eval/results.json");
