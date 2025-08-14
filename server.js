// server.js — Ghost Sniper AI backend (Node 22 ESM)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- static: serve /public if present, otherwise 404 hint
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Health
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "ghost-sniper", ts: Date.now() })
);

// ---- /api/ingest — YouTube/TikTok link → fetch readable text → summarize
app.post("/api/ingest", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }
    // Identify provider (simple)
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let provider = "web";
    if (host.includes("youtube") || host === "youtu.be") provider = "youtube";
    if (host.includes("tiktok")) provider = "tiktok";

    // Use Jina Reader to grab a clean, readable page text (works for most sites incl. YT/TikTok pages)
    const jinaEndpoint = "https://r.jina.ai/http/" + url;
    const resp = await fetch(jinaEndpoint, { timeout: 25_000 });
    if (!resp.ok) {
      return res.status(502).json({
        ok: false,
        error: `Fetch failed (${resp.status})`,
      });
    }
    const text = await resp.text();
    const trimmed = text.slice(0, 24_000); // keep prompt under model limits

    // Summarize with OpenAI (if key present); else, return raw
    if (!client) {
      return res.json({
        ok: true,
        provider,
        chars: trimmed.length,
        analysis:
          "[OpenAI key not set on server] Sample extracted text (first 1,000 chars):\n\n" +
          trimmed.slice(0, 1000),
      });
    }

    const system = `You are Ghost Sniper's research assistant.
Summarize the video/page content into:
1) One-paragraph overview
2) 5-8 bullet key takeaways (concise, no fluff)
3) Any specific trading heuristics, metrics, or patterns mentioned.
Keep it short and actionable.`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            `Provider: ${provider}\nOriginal URL: ${url}\n\nExtracted text:\n` +
            trimmed,
        },
      ],
    });

    const analysis =
      completion.choices?.[0]?.message?.content?.trim() ||
      "No analysis returned.";
    return res.json({ ok: true, provider, chars: trimmed.length, analysis });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Quote/Trade stubs (wire later)
app.get("/api/quote", async (req, res) => {
  // TODO: call Jupiter quote v6 or Pump.fun API here
  return res.json({ ok: true, demo: true, note: "quote stub" });
});

app.post("/api/snipe", async (req, res) => {
  // TODO: sign & send from the browser wallet; server should never hold keys
  return res.json({ ok: true, demo: true, note: "snipe stub" });
});

app.post("/api/sell", async (req, res) => {
  return res.json({ ok: true, demo: true, note: "sell stub" });
});

// ---- Fallback index
app.get("*", (_req, res) => {
  const idx = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res
    .status(200)
    .send(
      `<h3>Ghost Sniper</h3><p class="muted">index.html not found — commit your front-end to <code>/public/index.html</code></p>`
    );
});

app.listen(PORT, () =>
  console.log(`🚀 Ghost Sniper running on port ${PORT}`)
);