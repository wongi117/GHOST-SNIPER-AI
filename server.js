// server.js — Ghost Sniper AI (unified server)
// Works on Railway (Node 22+)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Basic hardening / JSON parsing
app.use(cors());
app.use(express.json());

// -------- Static site (serves /public)
// If /public exists use it; else fall back to current dir
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

// Serve everything in /public (css, js, images, html)
app.use(express.static(PUBLIC_DIR));

// Default route: serve /public/index.html if present
app.get("/", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  // Fallback: simple page so Railway never 404s
  res.type("html").send(`
    <h1>Ghost Sniper</h1>
    <p>No <code>/public/index.html</code> found. Create it and redeploy.</p>
  `);
});

// Optional: quick link to the wallet test page
app.get("/wallet-test", (req, res) => {
  const testPath = path.join(PUBLIC_DIR, "wallet-test.html");
  if (fs.existsSync(testPath)) return res.sendFile(testPath);
  res.status(404).json({ error: "wallet-test.html not found in /public" });
});

// -------- Health check (Railway pings this)
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------- Jupiter Quote proxy (example)
// You can call this from the browser without exposing APIs.
// GET /api/quote?inputMint=...&outputMint=...&amount=...&slippageBps=...
app.get("/api/quote", async (req, res) => {
  try {
    const q = new URL("https://quote-api.jup.ag/v6/quote");
    for (const [k, v] of Object.entries(req.query)) {
      if (v != null && v !== "") q.searchParams.set(k, String(v));
    }
    // sensible defaults
    if (!q.searchParams.get("swapMode")) q.searchParams.set("swapMode", "ExactIn");
    if (!q.searchParams.get("slippageBps")) q.searchParams.set("slippageBps", "100"); // 1%

    const r = await fetch(q.toString(), { headers: { "accept": "application/json" } });
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "quote_failed", detail: String(err) });
  }
});

// ------- (Placeholders you can flesh out)
// app.post("/api/snipe", async (req, res) => { /* sign with wallet in client */ });
// app.get("/api/metrics", async (req, res) => { /* TA / telemetry feed */ });

// -------- Start server
app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});