// server.js — Ghost Sniper AI (Node 22 on Railway)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---- Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Jupiter v6 quote
app.get("/api/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 50 } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "Missing params" });
    }
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("slippageBps", String(slippageBps));
    const r = await fetch(url.toString());
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "quote_error", detail: String(e) });
  }
});

// ---- Jupiter v6 swap (build tx for Phantom to sign)
app.post("/api/swap", async (req, res) => {
  try {
    const {
      route,
      userPublicKey,
      wrapAndUnwrapSol = true,
      prioritizationFeeLamports = "auto",
    } = req.body || {};
    if (!route || !userPublicKey) {
      return res.status(400).json({ error: "Missing route or userPublicKey" });
    }
    const r = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userPublicKey,
        wrapAndUnwrapSol,
        quoteResponse: route,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports, // "auto" or number string
      }),
    });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "swap_error", detail: String(e) });
  }
});

// ---- Dexscreener: unified search (token, pair, text)
app.get("/api/dexscreener", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "Missing q" });
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(
      q
    )}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "dexscreener_error", detail: String(e) });
  }
});

// ---- Dexscreener: candles by timeframe + pairAddress
// timeframes Dexscreener supports commonly: 1m,5m,15m,1h,4h,1d
app.get("/api/dexscreener-candles", async (req, res) => {
  try {
    const { timeframe = "5m", pairAddress = "" } = req.query;
    if (!pairAddress) return res.status(400).json({ error: "Missing pairAddress" });
    const url = `https://api.dexscreener.com/latest/dex/candles/${encodeURIComponent(
      timeframe
    )}/${encodeURIComponent(pairAddress)}?limit=200`;
    const r = await fetch(url);
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "candles_error", detail: String(e) });
  }
});

// ---- CoinGecko: simple price (ids comma-separated)
app.get("/api/coingecko-price", async (req, res) => {
  try {
    const { ids = "", vs = "usd" } = req.query;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      ids
    )}&vs_currencies=${encodeURIComponent(vs)}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "coingecko_error", detail: String(e) });
  }
});

// ---- AI Coach: explain TA snapshot / scenario
app.post("/api/ai-coach", async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: "OpenAI key not set" });
    const { snapshot } = req.body || {};
    const messages = [
      {
        role: "system",
        content:
          "You are Ghost Sniper's trading coach. Be concise, factual, and risk-aware. Avoid promises; highlight uncertainty.",
      },
      {
        role: "user",
        content:
          "Given the following candle stats and indicators, summarize current state, risks, and a plan:\n\n" +
          JSON.stringify(snapshot, null, 2),
      },
    ];
    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages,
    });
    return res.json({ message: out.choices[0].message });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "coach_error", detail: String(e) });
  }
});

// ---- Fallback to SPA
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});