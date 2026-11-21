import express from "express";
import multer from "multer";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { intake, janePlan, readStock, readFlyer } from "./lib/jane.js";

const SOURCES_PATH = new URL("./data/sources.json", import.meta.url);
const loadSources = () => JSON.parse(readFileSync(SOURCES_PATH, "utf8"));
const saveSources = (s) => writeFileSync(SOURCES_PATH, JSON.stringify(s, null, 2));

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

const toMedia = (f) => f && { mimeType: f.mimetype.split(";")[0], data: f.buffer.toString("base64") };
const extOf = (mime) => (mime.split("/")[1] || "bin").split(";")[0];

// Optionally save a stranger's real request as an eval case (their consent first).
function saveCase(text, audioFile, imageFiles) {
  const dir = new URL(`./eval/cases/case-${Date.now()}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("meta.json", dir), JSON.stringify({ text: text || null, truth: null }, null, 2));
  if (audioFile) writeFileSync(new URL(`audio.${extOf(audioFile.mimetype)}`, dir), audioFile.buffer);
  imageFiles.forEach((f, i) => writeFileSync(new URL(`img${i}.${extOf(f.mimetype)}`, dir), f.buffer));
}

// One conversational turn: any mix of voice, photos, text.
app.post("/api/turn", upload.fields([{ name: "audio", maxCount: 1 }, { name: "images", maxCount: 6 }]), async (req, res) => {
  try {
    const audioFile = req.files?.audio?.[0];
    const imageFiles = req.files?.images || [];
    const text = req.body.text?.trim() || null;
    const priorProfile = req.body.prior_profile ? JSON.parse(req.body.prior_profile) : null;
    if (req.body.save === "1") saveCase(text, audioFile, imageFiles);

    const profile = await intake({ text, audio: toMedia(audioFile), images: imageFiles.map(toMedia), priorProfile });
    if (profile.follow_up_question) return res.json({ profile, say: profile.follow_up_question });

    const result = await janePlan(profile, loadSources());
    res.json({ profile, say: result.plan.say, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e), say: "Sorry, something went wrong on my end. Can you try again?" });
  }
});

// Ingest a saved fridge/pantry photo (stock) or a flyer (hours) for a source.
app.post("/api/ingest", upload.single("image"), async (req, res) => {
  try {
    const { source_id, kind } = req.body;
    const sources = loadSources();
    const src = sources.find((s) => s.id === source_id);
    if (!src) return res.status(404).json({ error: "unknown source_id" });
    const img = toMedia(req.file);
    if (kind === "flyer") {
      const flyer = await readFlyer(img);
      src.flyer_reading = { ...flyer, read_at: new Date().toISOString() }; // review before copying into hours
      saveSources(sources);
      return res.json({ source_id, flyer });
    }
    src.stock = await readStock(img);
    if (req.body.observed_at) src.stock.observed_at = new Date(req.body.observed_at).toISOString();
    saveSources(sources);
    res.json({ source_id, stock: src.stock });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/sources", (_req, res) => res.json(loadSources()));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Ash running on http://localhost:${port}`));
