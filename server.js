// server.js — Ghost Sniper AI (YouTube/TikTok ingest + summary)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import ytdl from "ytdl-core";
import { YoutubeTranscript } from "youtube-transcript";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// serve /public (needs /public/index.html)
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- helpers ----
const TMP_DIR = "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isYouTube(url) {
  return /youtu\.?be/.test(url);
}
function isTikTok(url) {
  return /tiktok\.com/.test(url);
}
function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}
async function saveStreamToFile(stream, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    stream.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", reject);
    stream.on("error", reject);
  });
}

// ---- health ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- ingest: YouTube + TikTok ----
app.post("/api/ingest", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }

    let transcriptText = "";
    let provider = "";

    if (isYouTube(url)) {
      provider = "youtube";
      // 1) try official captions
      const vid = youtubeId(url);
      if (vid) {
        try {
          const caps = await YoutubeTranscript.fetchTranscript(vid);
          if (caps?.length) {
            transcriptText = caps.map((c) => c.text).join(" ");
          }
        } catch { /* no captions */ }
      }
      // 2) fallback: download audio-only and transcribe with Whisper
      if (!transcriptText) {
        const tmp = path.join(TMP_DIR, `yt-${Date.now()}.mp4`);
        const stream = ytdl(url, { quality: "highestaudio", filter: "audioonly" });
        await saveStreamToFile(stream, tmp);
        const tr = await client.audio.transcriptions.create({
          model: "whisper-1",
          file: fs.createReadStream(tmp)
        });
        transcriptText = tr.text || "";
        fs.promises.unlink(tmp).catch(() => {});
      }
    } else if (isTikTok(url)) {
      provider = "tiktok";
      // fetch page, find og:video direct link, download & transcribe
      const page = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (iPhone; like Mac OS X) Safari/605.1.15" }
      }).then(r => r.text());
      const m = page.match(/property="og:video" content="([^"]+)"/i);
      const videoUrl = m?.[1];
      if (!videoUrl) {
        return res.status(400).json({ ok: false, error: "Could not extract TikTok video URL" });
      }
      const tmp = path.join(TMP_DIR, `tt-${Date.now()}.mp4`);
      const videoResp = await fetch(videoUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!videoResp.ok) throw new Error("Failed to download TikTok video");
      await saveStreamToFile(videoResp.body, tmp);
      const tr = await client.audio.transcriptions.create({
        model: "whisper-1",
        file: fs.createReadStream(tmp)
      });
      transcriptText = tr.text || "";
      fs.promises.unlink(tmp).catch(() => {});
    } else {
      return res.status(400).json({ ok: false, error: "Only YouTube or TikTok links supported (for now)" });
    }

    if (!transcriptText?.trim()) {
      return res.status(422).json({ ok: false, provider, error: "No transcript available" });
    }

    // summarize to trading insights
    const prompt = `You are a fast crypto trading assistant.
Return tight, actionable notes for sniping/momentum trading from the transcript below.
Include:
- 5–10 bullet SUMMARY
- Any COINS/TICKERS mentioned
- ACTIONS (entry/exit ideas, risk)
- WARNINGS
Make it concise.

Transcript:
${transcriptText.slice(0, 16000)}`;

    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    });

    const analysis = out.choices[0]?.message?.content || "(no output)";
    return res.json({ ok: true, provider, chars: transcriptText.length, analysis });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// default route → serve UI or friendly message
app.get("*", (_req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res
    .status(200)
    .send("index.html not found — commit your front-end or push /public/index.html");
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});