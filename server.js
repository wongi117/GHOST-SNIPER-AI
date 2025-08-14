// server.js — Ghost Sniper AI (all-in-one)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Static dir: serve /public if present, else repo root
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ================== Health ==================
app.get("/health", (_req, res) => res.json({ ok: true }));

// ================== OpenAI chat ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

app.post("/api/chat", async (req, res) => {
  try {
    if (!openai) return res.json({ role: "assistant", content: "OPENAI_API_KEY not set." });
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [{ role:"user", content: String(req.body?.message || "Hello")}];
    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages
    });
    return res.json(out.choices[0].message);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ role:"assistant", content:"Chat error." });
  }
});

// ================== Dexscreener (proxies) ==================
// Search pairs
app.get("/api/dex/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    return res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) { return res.status(500).json({ error:"dex_search_error", detail:String(e) }); }
});

// Get pairs by chain/pair address
app.get("/api/dex/pairs/:chain/:pair", async (req, res) => {
  try {
    const { chain, pair } = req.params;
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pair)}`);
    const j = await r.json();
    return res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) { return res.status(500).json({ error:"dex_pairs_error", detail:String(e) }); }
});

// Token → list of pools/pairs by token address
app.get("/api/dex/tokenpairs/:chain/:token", async (req, res) => {
  try {
    const { chain, token } = req.params;
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`);
    const j = await r.json();
    return res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) { return res.status(500).json({ error:"dex_tokenpairs_error", detail:String(e) }); }
});

// ================== CoinGecko simple price (pro key supported) ==================
const CG_KEY = process.env.COINGECKO_API_KEY || "";
app.get("/api/market/simple", async (req, res) => {
  try {
    const ids = (req.query.ids || "solana,ethereum").toString();
    const vs  = (req.query.vs  || "usd").toString();
    const u = new URL("https://pro-api.coingecko.com/api/v3/simple/price");
    u.searchParams.set("ids", ids);
    u.searchParams.set("vs_currencies", vs);
    const headers = { accept: "application/json" };
    if (CG_KEY) headers["x-cg-pro-api-key"] = CG_KEY;
    const r = await fetch(u.toString(), { headers });
    const j = await r.json();
    return res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) { return res.status(500).json({ error:"coingecko_error", detail:String(e) }); }
});

// ================== Pump.fun (PumpPortal) ==================
// SSE relay of new token launches (client reads this)
app.get("/api/pump/stream", (req, res) => {
  res.set({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.flushHeaders();
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  let open = false;
  const heartbeat = setInterval(() => { if (open) res.write(`event: ping\ndata: {}\n\n`); }, 20000);

  ws.on("open", () => { open = true; ws.send(JSON.stringify({ method:"subscribeNewToken" })); });
  ws.on("message", (data) => res.write(`data: ${data.toString()}\n\n`) );
  const end = () => { clearInterval(heartbeat); try { res.end(); } catch {} };
  ws.on("close", end); ws.on("error", end);
  req.on("close", () => { try { ws.close(); } catch{}; end(); });
});

// Helper: build PumpPortal tx and return base64
async function pumpTradeLocal(body) {
  const resp = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`pumpportal ${resp.status} ${await resp.text().catch(()=> "")}`);
  const buf = Buffer.from(new Uint8Array(await resp.arrayBuffer()));
  return buf.toString("base64"); // serialized versioned tx
}

// BUY (snipe)
app.post("/api/pump/snipe", async (req, res) => {
  try {
    const {
      publicKey, mint, amount,
      denominatedInSol = true,
      slippage = Number(process.env.PUMP_SLIPPAGE || 1),
      priorityFee = Number(process.env.PUMP_PRIORITY_FEE || 0.00002),
      pool = process.env.PUMP_POOL || "pump",
    } = req.body || {};
    if (!publicKey || !mint || !amount) return res.status(400).json({ error:"Missing publicKey, mint or amount" });
    const tx = await pumpTradeLocal({ publicKey, action:"buy", mint, amount, denominatedInSol:String(!!denominatedInSol), slippage, priorityFee, pool });
    return res.json({ tx });
  } catch (e) { console.error(e); return res.status(500).json({ error:"snipe_build_failed", detail:String(e) }); }
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
      pool = process.env.PUMP_POOL || "pump",
    } = req.body || {};
    if (!publicKey || !mint) return res.status(400).json({ error:"Missing publicKey or mint" });
    const tx = await pumpTradeLocal({ publicKey, action:"sell", mint, amount, denominatedInSol:String(!!denominatedInSol), slippage, priorityFee, pool });
    return res.json({ tx });
  } catch (e) { console.error(e); return res.status(500).json({ error:"exit_build_failed", detail:String(e) }); }
});

// ================== Server-side “Auto-Snipe signal” (filters + SSE) ==================
const clients = new Set();

// Client subscribes to signals
app.get("/api/sniper/events", (req, res) => {
  res.set({ "Content-Type":"text/event-stream", "Cache-Control":"no-cache", Connection:"keep-alive" });
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// Server: open one shared WS to PumpPortal and analyze
(function startSignalEngine(){
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  ws.on("open", () => { ws.send(JSON.stringify({ method:"subscribeNewToken" })); });
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // msg is new token launch (shape depends on PumpPortal)
      const mint = msg.mint || msg.tokenAddress || msg.ca;
      const name = msg.name || msg.tokenName || "New Token";
      if (!mint) return;

      // Fetch Dexscreener pools for this mint (Solana)
      const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`);
      const pools = await r.json().catch(()=>[]);
      const p = Array.isArray(pools) && pools[0] ? pools[0] : null;

      // Quick heuristics (tune in UI later)
      const liq = p?.liquidity?.usd || 0;
      const m5 = (p?.priceChange?.m5 ?? 0);
      const buys5 = p?.txns?.m5?.buys ?? 0;
      const sells5 = p?.txns?.m5?.sells ?? 0;
      const score = (liq >= 5000 ? 1 : 0) + (m5 > 5 ? 1 : 0) + (buys5 > sells5 ? 1 : 0);

      const signal = {
        t: Date.now(),
        mint, name,
        pairUrl: p?.url || null,
        liquidityUsd: liq,
        change5m: m5,
        buys5m: buys5, sells5m: sells5,
        score
      };

      // Push to all connected clients
      for (const res of clients) res.write(`data: ${JSON.stringify(signal)}\n\n`);
    } catch (e) {
      // ignore parse errors
    }
  });
  ws.on("error", (e)=> console.warn("signal engine ws error", e.message));
  ws.on("close", ()=> setTimeout(startSignalEngine, 1500));
})();

// =============== Fallback: serve front-end ===============
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, () => console.log(`🚀 Ghost Sniper running on port ${PORT}`));