// server.js — Ghost Sniper AI (Node 22 / ESM)
// Backend provides: static hosting, health, DexScreener helpers,
// Jupiter v6 quote/swap proxies, SOL price, token list cache, and URL AI ingest.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Node 18+ has global fetch; no node-fetch needed.
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Basics ---------- */
app.use(cors()); // tighten later with your domain
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

/* ---------- Static hosting ---------- */
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : null;
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR));

/* ---------- Health ---------- */
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Jupiter v6: Quote ---------- */
app.get("/api/jup/quote", async (req, res) => {
  try {
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    const pass = [
      "inputMint",
      "outputMint",
      "amount",          // integer, smallest units
      "slippageBps",     // integer bps
      "feeBps",
      "onlyDirectRoutes",
      "preferDex",
      "asLegacyTransaction"
    ];
    pass.forEach((k) => {
      if (req.query[k] != null) url.searchParams.set(k, String(req.query[k]));
    });
    const r = await fetch(url.toString());
    const j = await r.json();
    res.json(j);
  } catch (e) {
    console.error("quote_error", e);
    res.status(500).json({ error: "quote_error", detail: String(e) });
  }
});

/* ---------- Jupiter v6: Swap (serialized tx; you sign on client) ---------- */
app.post("/api/jup/swap", async (req, res) => {
  try {
    const {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol = true,
      prioritizationFeeLamports = "auto",
      dynamicComputeUnitLimit = true
    } = req.body || {};

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: "missing_swap_fields" });
    }

    const payload = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      dynamicComputeUnitLimit,
      prioritizationFeeLamports // "auto" or number
    };

    const r = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const j = await r.json();
    res.json(j);
  } catch (e) {
    console.error("swap_error", e);
    res.status(500).json({ error: "swap_error", detail: String(e) });
  }
});

/* ---------- DexScreener: latest SOL pairs feed ---------- */
app.get("/api/dexscreener/new", async (_req, res) => {
  try {
    // Broad “solana” search then sort newest first.
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
    const j = await r.json();
    const items = (j?.pairs || [])
      .filter((p) => p.chainId === "solana")
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
      .slice(0, 50)
      .map((p) => ({
        baseSymbol: p.baseToken?.symbol,
        baseAddress: p.baseToken?.address,
        quoteSymbol: p.quoteToken?.symbol,
        dexId: p.dexId,
        url: p.url, // includes pairAddress in path
        fdv: Number(p.fdv || 0),
        liquidityUsd: Number(p.liquidity?.usd || 0),
        pairCreatedAt: p.pairCreatedAt || null,
        labels: p.labels || []
      }));
    res.json({ items });
  } catch (e) {
    console.error("dex_new_error", e);
    res.status(500).json({ error: "dex_new_error", detail: String(e) });
  }
});

/* ---------- DexScreener: price by mint (best SOL pair) ---------- */
app.get("/api/dex/price", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "no_token" });
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const j = await r.json();
    const pairs = (j?.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return res.json({ priceUsd: null });

    // Pick highest-liquidity SOL pair
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0];
    res.json({
      priceUsd: Number(p.priceUsd || 0),
      url: p.url,
      pairAddress: p.pairAddress,
      liquidityUsd: p.liquidity?.usd || 0,
      baseSymbol: p.baseToken?.symbol,
      baseAddress: p.baseToken?.address,
      quoteSymbol: p.quoteToken?.symbol
    });
  } catch (e) {
    console.error("dex_price_error", e);
    res.status(500).json({ error: "dex_price_error", detail: String(e) });
  }
});

/* ---------- Token list (Jupiter cache) ---------- */
let _tokenList = null;
let _tokenListTime = 0;
async function getJupTokens() {
  const now = Date.now();
  if (_tokenList && now - _tokenListTime < 5 * 60 * 1000) return _tokenList;
  const r = await fetch("https://cache.jup.ag/tokens");
  _tokenList = await r.json();
  _tokenListTime = now;
  return _tokenList;
}
app.get("/api/jup/token", async (req, res) => {
  try {
    const { mint } = req.query;
    const list = await getJupTokens();
    const t = list.find((x) => x.address === mint);
    if (!t) return res.json({ found: false });
    res.json({ found: true, decimals: t.decimals, symbol: t.symbol, name: t.name });
  } catch (e) {
    res.status(500).json({ error: "jup_token_error", detail: String(e) });
  }
});

/* ---------- SOL spot USD ---------- */
app.get("/api/price/sol", async (_req, res) => {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    res.json({ usd: j?.solana?.usd ?? null });
  } catch (e) {
    res.status(500).json({ error: "sol_price_error", detail: String(e) });
  }
});

/* ---------- URL ingest + optional AI summarize ---------- */
app.post("/api/ingest", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no_url" });

    // best-effort page text (good for articles/YouTube/TikTok pages)
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await r.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12000);

    let summary = null;
    if (process.env.OPENAI_API_KEY) {
      try {
        const { default: OpenAI } = await import("openai"); // lazy import
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const out = await client.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.3,
          messages: [
            { role: "system", content: "Summarize for a fast crypto sniper. 5–10 bullets, tickers/risks, concise." },
            { role: "user", content: `URL: ${url}\n\nTEXT:\n${text}` }
          ]
        });
        summary = out?.choices?.[0]?.message?.content || null;
      } catch (e) {
        console.warn("OpenAI summarize failed:", e.message);
      }
    }

    if (!summary) {
      summary = "AI summarization unavailable. Preview:\n" +
        text.slice(0, 500) + (text.length > 500 ? "…" : "");
    }
    res.json({ ok: true, summary });
  } catch (e) {
    console.error("ingest_error", e);
    res.status(500).json({ error: "ingest_error", detail: String(e) });
  }
});

/* ---------- SPA fallback ---------- */
app.get("*", (_req, res) => {
  if (PUBLIC_DIR) {
    const idx = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(idx)) return res.sendFile(idx);
    return res.status(200).send("index.html not found — commit /public/index.html");
  }
  res.status(200).send("No /public folder found — create /public/index.html and redeploy.");
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
  // Warm the token cache (non-blocking)
  getJupTokens().catch(() => {});
});