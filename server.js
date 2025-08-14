// server.js — Ghost Sniper (fast intel + sniping)
// Node 22 / ESM

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import LRU from "lru-cache";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve /public if present; else serve repo root
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "200kb" }));
app.use(express.static(PUBLIC_DIR));

// ------------ Health ------------
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ====================================================================
//                    🔥 PUMP.FUN SNIPER (PumpPortal)
// ====================================================================
// Docs: trade-local returns a serialized (versioned) Solana tx you sign in Phantom.  [oai_citation:0‡pumpportal.fun](https://pumpportal.fun/local-trading-api/trading-api/?utm_source=chatgpt.com)
async function pumpTradeLocal(body) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`PumpPortal ${r.status}: ${txt}`);
  }
  const buf = Buffer.from(new Uint8Array(await r.arrayBuffer()));
  return buf.toString("base64"); // serialized versioned tx
}

// Live feed of *new tokens* via PumpPortal WS -> SSE (low latency)
app.get("/api/pump/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  let open = false;
  const hb = setInterval(() => open && res.write(`event: ping\ndata: {}\n\n`), 20000);

  ws.on("open", () => {
    open = true;
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    // You may also subscribe per-token trades later:
    // ws.send(JSON.stringify({ method: "subscribeTokenTrade", mint: "<MINT>" }));
  });
  ws.on("message", (data) => res.write(`data: ${data.toString()}\n\n`));
  const done = () => { clearInterval(hb); try { res.end(); } catch {} };
  ws.on("close", done);
  ws.on("error", done);
  req.on("close", () => { try { ws.close(); } catch {}; done(); });
});

// BUY (snipe)
app.post("/api/pump/snipe", async (req, res) => {
  try {
    const {
      publicKey, mint, amount,
      denominatedInSol = true,
      slippage = Number(process.env.PUMP_SLIPPAGE || 1),
      priorityFee = Number(process.env.PUMP_PRIORITY_FEE || 0.00002), // SOL
      pool = process.env.PUMP_POOL || "pump"                         // "pump"|"raydium"
    } = req.body || {};
    if (!publicKey || !mint || !amount) return res.status(400).json({ error: "Missing publicKey, mint or amount" });
    const tx = await pumpTradeLocal({ publicKey, action: "buy", mint, amount, denominatedInSol: String(!!denominatedInSol), slippage, priorityFee, pool });
    res.json({ tx });
  } catch (e) { res.status(500).json({ error: "snipe_build_failed", detail: String(e) }); }
});

// SELL (exit)
app.post("/api/pump/exit", async (req, res) => {
  try {
    const {
      publicKey, mint,
      amount = "100%",
      denominatedInSol = false,
      slippage = Number(process.env.PUMP_SLIPPAGE || 1),
      priorityFee = Number(process.env.PUMP_PRIORITY_FEE || 0.00002),
      pool = process.env.PUMP_POOL || "pump"
    } = req.body || {};
    if (!publicKey || !mint) return res.status(400).json({ error: "Missing publicKey or mint" });
    const tx = await pumpTradeLocal({ publicKey, action: "sell", mint, amount, denominatedInSol: String(!!denominatedInSol), slippage, priorityFee, pool });
    res.json({ tx });
  } catch (e) { res.status(500).json({ error: "exit_build_failed", detail: String(e) }); }
});

// ====================================================================
//                    📊 DEX SCREENER INTEGRATION
// ====================================================================
// Reference API (pairs, tokens, search). Rates: ~300 RPM on “latest/dex/*”.  [oai_citation:1‡docs.dexscreener.com](https://docs.dexscreener.com/api/reference?utm_source=chatgpt.com)
const dxsBase = "https://api.dexscreener.com";
const cgProBase = process.env.COINGECKO_API_KEY ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
const dxsCache = new LRU({ max: 500, ttl: 5_000 }); // 5s cache to shave latency

app.get("/api/dxs/pairs", async (req, res) => {
  try {
    const { chain = "solana", pair } = req.query;
    if (!pair) return res.status(400).json({ error: "pair required" });
    const key = `pairs:${chain}:${pair}`;
    if (dxsCache.has(key)) return res.json(dxsCache.get(key));
    const r = await fetch(`${dxsBase}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}`);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    dxsCache.set(key, j);
    res.json(j);
  } catch (e) { res.status(500).json({ error: "dxs_pairs_error", detail: String(e) }); }
});

app.get("/api/dxs/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "q required" });
    const key = `search:${q}`;
    if (dxsCache.has(key)) return res.json(dxsCache.get(key));
    const r = await fetch(`${dxsBase}/latest/dex/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    dxsCache.set(key, j);
    res.json(j);
  } catch (e) { res.status(500).json({ error: "dxs_search_error", detail: String(e) }); }
});

app.get("/api/dxs/tokens", async (req, res) => {
  try {
    const { chain = "solana", addresses } = req.query;
    if (!addresses) return res.status(400).json({ error: "addresses required (comma-separated)" });
    const key = `tokens:${chain}:${addresses}`;
    if (dxsCache.has(key)) return res.json(dxsCache.get(key));
    const r = await fetch(`${dxsBase}/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(addresses)}`);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    dxsCache.set(key, j);
    res.json(j);
  } catch (e) { res.status(500).json({ error: "dxs_tokens_error", detail: String(e) }); }
});

// ====================================================================
//                    🦎 COINGECKO (price feed)
// ====================================================================
// Simple price by IDs. If you set COINGECKO_API_KEY, we use the Pro host & header.  [oai_citation:2‡CoinGecko API Documentation](https://docs.coingecko.com/reference/simple-price?utm_source=chatgpt.com)
app.get("/api/cg/price", async (req, res) => {
  try {
    const ids = String(req.query.ids || "").trim();         // e.g., "solana,ethereum"
    const vs  = String(req.query.vs  || "usd").trim();      // e.g., "usd,aud"
    if (!ids) return res.status(400).json({ error: "ids required" });
    const url = `${cgProBase}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true&precision=full`;
    const headers = process.env.COINGECKO_API_KEY ? { "x-cg-pro-api-key": process.env.COINGECKO_API_KEY } : {};
    const r = await fetch(url, { headers });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    res.json(j);
  } catch (e) { res.status(500).json({ error: "cg_error", detail: String(e) }); }
});

// ====================================================================
//                    📐 TECHNICAL INDICATORS (RSI/EMA/MACD)
// ====================================================================
// Client posts { closes: number[], highs?:[], lows?:[], fast?:, slow?:, signal? }
import { RSI, EMA, MACD } from "technicalindicators"; // pure JS (no native build)

app.post("/api/ta", (req, res) => {
  try {
    const { closes = [], period = 14, emaFast = 12, emaSlow = 26, signal = 9 } = req.body || {};
    if (!Array.isArray(closes) || closes.length < Math.max(period, emaSlow) + 2)
      return res.status(400).json({ error: "not enough closes" });

    const rsi = RSI.calculate({ values: closes, period });
    const emaFastA = EMA.calculate({ values: closes, period: emaFast });
    const emaSlowA = EMA.calculate({ values: closes, period: emaSlow });
    const macd = MACD.calculate({ values: closes, fastPeriod: emaFast, slowPeriod: emaSlow, signalPeriod: signal, SimpleMAOscillator: false, SimpleMASignal: false });

    res.json({
      rsiLast: rsi[rsi.length - 1],
      emaFastLast: emaFastA[emaFastA.length - 1],
      emaSlowLast: emaSlowA[emaSlowA.length - 1],
      macdLast: macd[macd.length - 1],
    });
  } catch (e) { res.status(500).json({ error: "ta_error", detail: String(e) }); }
});

// ====================================================================
//                    🤖 AI Chat (OpenAI)
// ====================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let openai = null;
if (OPENAI_API_KEY) openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.post("/api/chat", async (req, res) => {
  try {
    if (!openai) return res.json({ role: "assistant", content: "OpenAI key not set." });
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [{ role: "user", content: String(req.body?.message || "Hi")) }];
    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages
    });
    res.json(out.choices[0].message);
  } catch (e) { res.status(500).json({ role: "assistant", content: "Chat error." }); }
});

// ====================================================================
//                    🧠 (Optional) Axiom hook (ETH history)
// ====================================================================
// Axiom lets you prove historic ETH data on-chain; integrate later with @axiom-crypto/client.  [oai_citation:3‡docs.axiom.xyz](https://docs.axiom.xyz/docs/axiom-developer-flow/deployment/querying-with-node-js?utm_source=chatgpt.com) [oai_citation:4‡npm](https://www.npmjs.com/package/%40axiom-crypto/client?utm_source=chatgpt.com)
// Placeholder endpoint to show wiring (no query runs unless you add your key & script):
app.post("/api/axiom/ping", async (_req, res) => {
  res.json({ ok: true, note: "Wire @axiom-crypto/client here to dispatch queries for ETH historical proofs." });
});

// ------------ Fallback: SPA ------------
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on :${PORT}`);
});