// CLI for the background source refresher (see lib/refresh.js).
// Usage (PowerShell, from the jane folder):
//   node --env-file=.env.local scripts/refresh_agent.js --near=40.8085,-73.9465 --limit=8
//   --near=lat,lng   refresh the sources closest to this point (default: 125th St, Harlem)
//   --limit=N        how many sources per run (keep it small; the hackathon account watches for abuse)
//   --dry            write proposals to data/agent_updates.json without changing sources.json
//   --types=a,b      only these source types, e.g. --types=community_garden,urban_farm
//   --stale-days=N   also re-check agent-verified sources older than N days (default 30)
import { runRefresh } from "../lib/refresh.js";
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const [nearLat, nearLng] = arg("near", "40.8085,-73.9465").split(",").map(Number);
await runRefresh({
  nearLat, nearLng,
  limit: Number(arg("limit", "8")),
  types: arg("types", "") ? arg("types", "").split(",") : null,
  staleDays: Number(arg("stale-days", "30")),
  dry: process.argv.includes("--dry"),
  verbose: true,
});
