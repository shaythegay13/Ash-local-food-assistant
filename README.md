# Ash: food plans on a budget (Gemini 4 NYC hackathon, 5 Sigma track)

## What was built at this hackathon (Nov 21, 2026)
Everything in this repo was built today, with AI coding assistance:
- **Ash**, the voice/photo/text agent and its mobile web UI (visual design made in Google Stitch today)
- **Intake** (Gemini 4 Hydrogen): voice, photos and text become a structured profile with budget, household, location, availability
- **Decisions API gates**: eligibility per source, stock from photos, evidence checks on agent findings
- **Planner** (Gemini 4 Neon; Carbon was too slow for a live user), plus the **verify-and-repair loop** (`lib/check.js`): hours, budget period, travel time, eligibility
- **Travel-time model** with borough penalties (`lib/geo.js`)
- **Managed Agent refresher** (`lib/refresh.js`): an Antigravity agent in a Google-hosted sandbox researches missing or stale hours, runs in the background after each request, and every finding passes an evidence gate
- **Evaluation**: a baseline (one Gemini call with Google Search), a test set from strangers at the event, and a shared feasibility checker
- **Import script** that converts an existing location export into Ash's format

**Pre-existing, not built today:** the raw location list (`locations_rows.csv`), exported from the Saved by the Plate food map (2025). Ash treats it as unverified: imported hours are marked "confirm first" until the agent or a person re-checks them.

A person talks to Ash, shows them photos, types, or does all three. Ash builds a week-long plan to get food in Harlem within their budget. The plan uses only verified sources, open at times the person can actually go, with stock read from real fridge photos.

## Model jobs
| Step | Model | Job |
|---|---|---|
| Intake | `gemini-4-hydrogen` | Voice + photos + text → structured profile (budget, household, times, diet, equipment, food on hand) |
| Gates | `gemini-decision-1` (Decisions API) | Eligibility per source (one batched call); stock / produce / unsafe from fridge photos |
| Planner | `gemini-4-neon` (low thinking) | Cheapest feasible week from the gated candidates; one repair pass if verification fails. Switched from Carbon, which took 1–2 min per plan |
| Hours | **code, not a model** | Opening hours are structured data, so a deterministic check is exact |
| Baseline | `gemini-4-hydrogen` + Google Search | One call, same raw inputs, no map and no gates |

## Run it
```bash
npm install
export GEMINI_API_KEY=...        # from AI Studio
npm test                          # offline checks for the hours and feasibility logic
npm start                         # http://localhost:3000   (ingest page: /admin.html)
```
On your laptop the mic works on localhost. **On a phone the mic needs HTTPS**, so tunnel it: `npx cloudflared tunnel --url http://localhost:3000` (or ngrok).

Switch models without code changes: `INTAKE_MODEL`, `PLANNER_MODEL`, `DECIDE_MODEL`, `BASELINE_MODEL`.

## Do first (in this order)
1. **Test audio in the first 15 minutes.** Chrome records `audio/webm`. If Hydrogen rejects it, record on Safari (mp4) or convert to wav on the server.
2. **Replace `data/sources.json`** with about 15 real Harlem sources. Verify each one's hours and eligibility, and fill in `verified_by` with how and when you checked. The eval only means something if this file is true.
3. **Ingest stock**: save recent fridge Instagram photos, then upload them at `/admin.html` with the date each was posted. Stock older than 48h shows as "unknown" on purpose.
4. **Collect test cases from strangers**: tick "Save this request as a test case" in the app, after asking their permission. Then open `eval/cases/<case>/meta.json` and fill in `truth` (their real budget and availability) so the scoring doesn't take Ash's word for it.

## Eval
```bash
npm run eval     # writes eval/results.json, prints Ash vs baseline
```
Metrics, both systems scored by the same checker (`lib/check.js`):
- **Feasible rate**: every stop is a verified source, open at the scheduled time, inside the person's availability, eligible, and the plan is within budget
- **Hallucinated stops**: places that aren't in the verified list
- **Closed stops**: scheduled when the place is closed
- **Over-budget rate**
- **First-try vs. after-repair feasibility**: this is your "what we changed after seeing failures" slide

## Demo script (3 min)
1. A stranger's real voice request, on stage or recorded earlier, with background noise.
2. Ash's spoken plan and the "Checked" badge.
3. The baseline's plan for the same request, with its closed and hallucinated stops highlighted.
4. The results table.
5. One place it still breaks, and what you'd do next.

## Builder-guide notes
- **Structured outputs:** intake, flyer and planner calls declare JSON schemas. Only the baseline asks for JSON in plain text, because it uses Google Search.
- **Decisions confidence below 0.75** doesn't count as an answer. Stock becomes "unknown", and eligibility becomes "confirm with the site" plus a backup stop.
- **If `models.generateContent` errors on Gemini 4**, switch those calls to the Interactions API (`client.interactions.create`). Install the docs MCP first: `npx add-mcp "https://gemini-api-docs-mcp.dev"`.
- **Optional upgrades:** `gemini-3.8-flash-tts` for the agent's voice. An Antigravity Managed Agent that re-verifies source hours from websites, which is a candidate for the Managed Agents prize.
