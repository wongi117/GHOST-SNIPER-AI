// server.js — Ghost Sniper AI (Node 22 / ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors()); // tighten later with your domain
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// --- Static site (/public/index.html must exist) ---
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : null;
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR));

// --- Health ---
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Jupiter v6: Quote ----------
app.get("/api/jup/quote", async (req, res) => {
  try {
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    [
      "inputMint",
      "outputMint",
      "amount",
      "slippageBps",
      "feeBps",
      "onlyDirectRoutes",
      "preferDex",
      "asLegacyTransaction"
    ].forEach((k) => {
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

// ---------- Jupiter v6: Swap (build serialized tx; user signs in Phantom) ----------
app.post("/api/jup/swap", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.userPublicKey || !body.quoteResponse) {
      return res.status(400).json({ error: "missing_swap_fields" });
    }
    const r = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: null
      })
    });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    console.error("swap_error", e);
    res.status(500).json({ error: "swap_error", detail: String(e) });
  }
});

// ---------- DexScreener: token price by mint ----------
app.get("/api/dex/price", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "no_token" });
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`
    );
    const j = await r.json();
    const pairs = (j?.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return res.json({ priceUsd: null });

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

// ---------- DexScreener: latest SOL pairs feed ----------
app.get("/api/dexscreener/new", async (_req, res) => {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
    const j = await r.json();
    const items = (j?.pairs || [])
      .filter((p) => p.chainId === "solana")
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
      .slice(0, 30)
      .map((p) => ({
        baseSymbol: p.baseToken?.symbol,
        baseAddress: p.baseToken?.address,
        quoteSymbol: p.quoteToken?.symbol,
        dexId: p.dexId,
        url: p.url,
        fdv: Number(p.fdv || 0),
        liquidityUsd: Number(p.liquidity?.usd || 0),
        pairCreatedAt: p.pairCreatedAt || null
      }));
    res.json({ items });
  } catch (e) {
    console.error("dex_new_error", e);
    res.status(500).json({ error: "dex_new_error", detail: String(e) });
  }
});

// ---------- Jupiter token list (cached) ----------
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

// ---------- SOL spot (usd) ----------
app.get("/api/price/sol", async (_req, res) => {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const j = await r.json();
    res.json({ usd: j?.solana?.usd ?? null });
  } catch (e) {
    res.status(500).json({ error: "sol_price_error", detail: String(e) });
  }
});

// ---------- Ingest & (optional) summarize a URL ----------
app.post("/api/ingest", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no_url" });

    // best-effort page text (works fine for articles/YouTube/TikTok pages)
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
            {
              role: "system",
              content:
                "Summarize for a fast crypto trader. Give 5–10 bullets, mention tickers/risks, keep it punchy."
            },
            { role: "user", content: `URL: ${url}\n\nTEXT:\n${text}` }
          ]
        });
        summary = out?.choices?.[0]?.message?.content || null;
      } catch (e) {
        console.warn("OpenAI summarize failed:", e.message);
      }
    }
    if (!summary) {
      summary =
        "AI summarization unavailable. Preview:\n" +
        text.slice(0, 500) +
        (text.length > 500 ? "…" : "");
    }
    res.json({ ok: true, summary });
  } catch (e) {
    console.error("ingest_error", e);
    res.status(500).json({ error: "ingest_error", detail: String(e) });
  }
});

// --- Fallback SPA route ---
app.get("*", (_req, res) => {
  if (PUBLIC_DIR) {
    const idx = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(idx)) return res.sendFile(idx);
    return res.status(200).send("index.html not found — commit /public/index.html");
  }
  res.status(200).send("No /public folder found — create /public/index.html and redeploy.");
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
  // warm token cache (non-blocking)
  getJupTokens().catch(() => {});
});