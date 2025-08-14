// server.js — Ghost Sniper AI backend (Node 22)
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
app.use(cors());
app.use(express.json());

// ---------- Static front-end ----------
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------- DexScreener (new pairs / SOL only) ----------
app.get("/api/dexscreener/new", async (_req, res) => {
  try {
    // Common endpoint that returns latest pairs for a chain
    const r = await fetch("https://api.dexscreener.com/latest/dex/pairs/solana");
    const data = await r.json();
    // Keep the most recent 50 and surface just what we need
    const items = (data?.pairs || []).slice(0, 50).map(p => ({
      pairAddress: p.pairAddress,
      baseSymbol: p.baseToken?.symbol,
      baseAddress: p.baseToken?.address,
      quoteSymbol: p.quoteToken?.symbol,
      quoteAddress: p.quoteToken?.address,
      dexId: p.dexId,
      priceUsd: p.priceUsd,
      liquidityUsd: p.liquidity?.usd,
      fdv: p.fdv,
      url: p.url,
      flags: p.labels || []
    }));
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "dexscreener_error", detail: String(e) });
  }
});

// ---------- CoinGecko (SOL spot) ----------
app.get("/api/price/sol", async (_req, res) => {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const j = await r.json();
    res.json({ usd: j?.solana?.usd ?? null });
  } catch (e) {
    res.status(500).json({ error: "coingecko_error", detail: String(e) });
  }
});

// ---------- Jupiter v6 quote proxy ----------
app.get("/api/jup/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 100 } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "missing_params" });
    }
    const q = new URL("https://quote-api.jup.ag/v6/quote");
    q.searchParams.set("inputMint", inputMint);
    q.searchParams.set("outputMint", outputMint);
    q.searchParams.set("amount", String(amount)); // integer in smallest units
    q.searchParams.set("slippageBps", String(slippageBps));
    q.searchParams.set("onlyDirectRoutes", "false");

    const r = await fetch(q.toString());
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "quote_error", detail: String(e) });
  }
});

// ---------- Jupiter v6 swap proxy (build TX) ----------
app.post("/api/jup/swap", async (req, res) => {
  try {
    const { quoteResponse, userPublicKey, wrapAndUnwrapSol = true } = req.body;
    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: "missing_body" });
    }
    const r = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol,              // auto wrap SOL
        dynamicComputeUnitLimit: true, // speed
        prioritizationFeeLamports: "auto"
      })
    });
    const data = await r.json();
    // Returns { swapTransaction: base64, lastValidBlockHeight, ... }
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "swap_error", detail: String(e) });
  }
});

// ---------- Optional: simple “ingest” cache for links you paste ----------
const mem = new Map(); // url -> summary
app.post("/api/ingest", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no_url" });
    if (!OPENAI_API_KEY) return res.status(400).json({ error: "no_openai_key" });

    // Very lightweight fetch of page text (best-effort)
    const html = await (await fetch(url)).text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                     .replace(/<style[\s\S]*?<\/style>/gi, "")
                     .replace(/<[^>]+>/g, " ")
                     .replace(/\s+/g, " ")
                     .slice(0, 20000);

    // Summarize with OpenAI for the AI panel
    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Summarize this crypto video/article for a trading copilot. Extract tickers, chains, and actionable signals."},
        { role: "user", content: text }
      ]
    });
    const summary = out.choices?.[0]?.message?.content ?? "(no summary)";
    mem.set(url, summary);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ingest_error", detail: String(e) });
  }
});

// ---------- Fallback: serve /public/index.html ----------
app.get("*", (_req, res) => {
  const p = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send("<h3>Ghost Sniper</h3><p>index.html not found — commit your front-end in /public/index.html</p>");
});

app.listen(PORT, () => console.log(`🚀 Ghost Sniper running on ${PORT}`));