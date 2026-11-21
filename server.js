import express from "express";
import multer from "multer";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { intake, janePlan, readStock, readFlyer } from "./lib/jane.js";
import { runRefresh } from "./lib/refresh.js";
import { GoogleGenAI } from "@google/genai";

// ---- Ash's voice: Gemini 3.8 Flash TTS (natural speech). The browser voice is the fallback if this fails. ----
const tts = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" }); // speechConfig is v1beta-only
function wav(pcm, rate = 24000) { // wrap raw 16-bit mono PCM in a WAV header so any browser can play it
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Background research: after someone asks for a plan, the Managed Agent checks unverified places near them,
// so the NEXT plan in that area is built on fresher data. One run at a time, small batches, and each area
// (about 1 km square) at most once per 30 minutes. Set AUTO_REFRESH=0 in .env.local to turn it off.
let refreshing = false;
const lastRun = new Map();
function backgroundRefresh(profile) {
  if (process.env.AUTO_REFRESH === "0" || refreshing || profile?.home_lat == null) return false;
  const cell = `${profile.home_lat.toFixed(2)},${profile.home_lng.toFixed(2)}`;
  if (Date.now() - (lastRun.get(cell) || 0) < 30 * 60e3) return false;
  lastRun.set(cell, Date.now());
  refreshing = true;
  runRefresh({ nearLat: profile.home_lat, nearLng: profile.home_lng, limit: Number(process.env.AUTO_REFRESH_LIMIT || 4) })
    .then((r) => console.log(`[refresh] near ${cell}: checked ${r.checked}, accepted ${r.accepted}`))
    .catch((e) => console.error("[refresh] failed:", e.message))
    .finally(() => { refreshing = false; });
  return true;
}

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
    const researching = backgroundRefresh(profile);
    res.json({ profile, say: result.plan.say, researching, ...result });
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

app.post("/api/tts", express.json({ limit: "20kb" }), async (req, res) => {
  try {
    const text = String(req.body?.text || "").slice(0, 1200);
    if (!text) return res.status(400).end();
    const r = await tts.models.generateContent({
      model: process.env.TTS_MODEL || "gemini-3.8-flash-tts",
      contents: [{ role: "user", parts: [{ text: `Say this warmly and clearly, like a kind neighbor who knows the area, at a relaxed pace: ${text}` }] }],
      config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.TTS_VOICE || "Kore" } } } },
    });
    const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw new Error("no audio returned");
    const mime = part.inlineData.mimeType || "";
    const audio = Buffer.from(part.inlineData.data, "base64");
    if (/wav|mpeg|mp3|ogg/.test(mime)) { res.type(mime); return res.send(audio); }
    const rate = Number(mime.match(/rate=(\d+)/)?.[1] || 24000); // raw PCM (audio/L16)
    res.type("audio/wav").send(wav(audio, rate));
  } catch (e) {
    console.error("[tts]", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/sources", (_req, res) => res.json(loadSources()));
app.get("/api/refresh-status", (_req, res) => res.json({ refreshing }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Ash running on http://localhost:${port}`));
