// server.js — Ghost Sniper AI (3-bot stack)
// Node 22 compatible (ESM). Paper mode ON by default.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Config
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const LIVE_TRADING = String(process.env.LIVE_TRADING || "false").toLowerCase() === "true";

// Optional RPCs (required for live mode)
const ALCHEMY_MAINNET = process.env.ALCHEMY_MAINNET || ""; // EVM mainnet (for 0x/uniswap)
const SOLANA_RPC = process.env.SOLANA_RPC || ""; // e.g. https://api.mainnet-beta.solana.com

// ---------- OpenAI client (for chat & URL intel)
const ai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---------- Web server: static UI
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ---------- WebSocket: live logs/feeds
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
function push(event, payload) {
  const msg = JSON.stringify({ event, time: Date.now(), payload });
  for (const ws of clients) {
    try { ws.send(msg); } catch {}
  }
  console.log(`[WS] ${event}`, payload);
}

// attach WS to same HTTP server later
const server = app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper AI listening on ${PORT} | LIVE_TRADING=${LIVE_TRADING}`);
});

// Upgrade handler
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.send(JSON.stringify({ event: "hello", payload: { ok: true, LIVE_TRADING } }));
  });
});

// ---------- Tiny in-memory bot registry
const bots = new Map(); // id -> bot

// Util: delay
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ========== Strategy / Signal abstractions ==========

class BaseBot {
  constructor(id, opts) {
    this.id = id;
    this.opts = {
      label: opts.label || id,
      chain: opts.chain || "paper",
      pool: opts.pool || "paper",
      amount: Number(opts.amount || 0.01),
      slippage: Number(opts.slippage || 1),
      priorityFee: Number(opts.priorityFee || 0),
      paper: !LIVE_TRADING || !!opts.paper,
      sources: opts.sources || ["dexscreener", "coingecko", "pumpfun"],
      minMcap: Number(opts.minMcap || 0),
      minLiquidity: Number(opts.minLiquidity || 0),
      maxAgeSec: Number(opts.maxAgeSec || 900)
    };
    this._running = false;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    push("bot:start", { id: this.id, opts: this.opts });
    this.loop().catch(err => {
      push("bot:error", { id: this.id, error: String(err?.message || err) });
      this._running = false;
    });
  }

  async stop() {
    this._running = false;
    push("bot:stop", { id: this.id });
  }

  async loop() {
    // Overridden by child
  }

  async trade({ side, token, amount, extra }) {
    if (this.opts.paper) {
      // simulate fill instantly
      const price = extra?.price || Math.max(0.000001, (Math.random() * 0.005));
      const qty = side === "buy" ? amount / price : amount; // very rough
      push("trade:paper", { id: this.id, side, token, amount, price, qty, chain: this.opts.chain });
      return { ok: true, paper: true, txid: `paper_${Date.now()}` };
    } else {
      // Live trade stubs per chain
      if (this.opts.chain === "sol") return this.tradeSolana({ side, token, amount, extra });
      if (this.opts.chain === "evm") return this.tradeEvm({ side, token, amount, extra });
      throw new Error("Unsupported chain for live mode");
    }
  }

  // ---- Live Solana via Jupiter (client must sign; server builds swap tx b64)
  async tradeSolana({ side, token, amount, extra }) {
    // NOTE: For true live, build swap tx with Jupiter API, return tx b64 to client for signing with Phantom.
    // Here we only log + return stub (you’ll wire to front-end signer).
    push("trade:live_stub", { id: this.id, chain: "sol", side, token, amount });
    return { ok: true, needsClientSign: true, provider: "jupiter", b64: null };
  }

  // ---- Live EVM via 0x swap API (client must send tx with MetaMask)
  async tradeEvm({ side, token, amount, extra }) {
    push("trade:live_stub", { id: this.id, chain: "evm", side, token, amount });
    return { ok: true, needsClientSign: true, provider: "0x", txData: null };
  }
}

// Quick “signal” helper — polls a list endpoint and yields fresh tokens once
async function* pollJsonList(url, key = "items", periodMs = 4000) {
  const seen = new Set();
  while (true) {
    try {
      const r = await fetch(url);
      const data = await r.json();
      const arr = (data?.[key] ?? data ?? []);
      for (const item of arr) {
        const id = item.address || item.tokenAddress || item.symbol || JSON.stringify(item);
        if (id && !seen.has(id)) {
          seen.add(id);
          yield item;
        }
      }
    } catch (e) {
      // swallow and continue
    }
    await wait(periodMs);
  }
}

// ========== Bot 1: Solana “PumpFun watcher” (signals) ==========
class SolPumpFunBot extends BaseBot {
  constructor(id, opts = {}) {
    super(id, { chain: "sol", pool: "pumpfun", ...opts });
  }
  async loop() {
    // This is a **signal** example. Replace with your preferred feed or on-chain listener.
    // Demo: use DexScreener Solana feed just for fresh tokens (approximate).
    const feed = "https://api.dexscreener.com/latest/dex/tokens/solana";
    for await (const token of pollJsonList(feed, "pairs", 6000)) {
      if (!this._running) break;

      const addr = token.baseToken?.address || token.pairAddress || token.address;
      const ageSec = Number(token.pairCreatedAt ? (Date.now() - token.pairCreatedAt) / 1000 : 9999);
      const liq = Number(token.liquidity?.usd || 0);
      const mcap = Number(token.fdv || token.marketCap || 0);

      if (!addr) continue;
      if (ageSec > this.opts.maxAgeSec) continue;
      if (liq < this.opts.minLiquidity) continue;
      if (mcap < this.opts.minMcap) continue;

      push("signal", { bot: this.id, source: "dexscreener", addr, mcap, liq, ageSec });
      // BUY once per new signal (paper by default)
      await this.trade({ side: "buy", token: addr, amount: this.opts.amount, extra: { price: token.priceUsd } });
    }
  }
}

// ========== Bot 2: EVM Sniper (0x aggregator signals) ==========
class EvmZeroXBot extends BaseBot {
  constructor(id, opts = {}) {
    super(id, { chain: "evm", pool: "uniswap", ...opts });
  }
  async loop() {
    // Example: poll top trending on DexScreener EVM (broad)
    const feed = "https://api.dexscreener.com/latest/dex/tokens/ethereum";
    for await (const token of pollJsonList(feed, "pairs", 7000)) {
      if (!this._running) break;
      const addr = token.baseToken?.address;
      if (!addr) continue;
      const mcap = Number(token.fdv || 0);
      const liq = Number(token.liquidity?.usd || 0);
      if (mcap < this.opts.minMcap || liq < this.opts.minLiquidity) continue;

      push("signal", { bot: this.id, source: "dexscreener", addr, mcap, liq });
      await this.trade({ side: "buy", token: addr, amount: this.opts.amount, extra: { price: token.priceUsd } });
    }
  }
}

// ========== Bot 3: PaperSim (training) ==========
class PaperSimBot extends BaseBot {
  constructor(id, opts = {}) {
    super(id, { chain: "paper", pool: "sim", paper: true, ...opts });
  }
  async loop() {
    // Generate synthetic signals to practice AI prompts & buttons
    while (this._running) {
      const addr = `SIM_${Math.random().toString(36).slice(2, 8)}`;
      push("signal", { bot: this.id, source: "sim", addr, mcap: 120000 + Math.random()*1e6, liq: 10000 + Math.random()*100000 });
      await this.trade({ side: "buy", token: addr, amount: this.opts.amount });
      await wait(4000 + Math.random() * 4000);
      await this.trade({ side: "sell", token: addr, amount: this.opts.amount * (0.98 + Math.random()*0.06) });
      await wait(3000);
    }
  }
}

// ---------- Bot management endpoints
function ensureBot(id, kind, opts) {
  if (bots.has(id)) return bots.get(id);
  let bot;
  if (kind === "sol-pumpfun") bot = new SolPumpFunBot(id, opts);
  else if (kind === "evm-0x") bot = new EvmZeroXBot(id, opts);
  else bot = new PaperSimBot(id, opts);
  bots.set(id, bot);
  return bot;
}

app.post("/api/bots/start", async (req, res) => {
  try {
    const { id, kind, opts } = req.body || {};
    const bot = ensureBot(id || kind || `bot_${Date.now()}`, kind || "paper", opts || {});
    await bot.start();
    return res.json({ ok: true, id: bot.id, opts: bot.opts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/bots/stop", async (req, res) => {
  try {
    const { id } = req.body || {};
    const bot = bots.get(id);
    if (!bot) return res.status(404).json({ ok: false, error: "bot not found" });
    await bot.stop();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/bots/list", (_req, res) => {
  res.json({
    ok: true,
    bots: [...bots.values()].map(b => ({ id: b.id, opts: b.opts, running: b._running }))
  });
});

// ---------- Chat AI (general + trading commands)
app.post("/api/chat", async (req, res) => {
  try {
    if (!ai) return res.status(400).json({ ok: false, error: "OPENAI_API_KEY missing" });
    const { messages = [], system = "" } = req.body || {};

    const sys = system || `
You are Ghost Sniper AI, a crisp trading assistant.
- You can tell the user how to start/stop bots by calling the /api/bots endpoints.
- When user says "snipe X on pump.fun", suggest: POST /api/bots/start {id:"sol1", kind:"sol-pumpfun", opts:{amount:X}}.
- Never send private keys. Remind that LIVE_TRADING is off by default.
`.trim();

    const out = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [{ role: "system", content: sys }, ...messages]
    });

    const text = out.choices?.[0]?.message?.content || "…";
    push("chat", { from: "ai", text });
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- URL intelligence (YouTube/TikTok oEmbed + summarize)
app.post("/api/url-intel", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "url missing" });

    // Light metadata via oEmbed endpoints
    async function getOEmbed(u) {
      // Try YouTube then TikTok
      const yt = `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`;
      const tk = `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`;
      for (const probe of [yt, tk]) {
        try {
          const r = await fetch(probe);
          if (r.ok) return await r.json();
        } catch {}
      }
      return null;
    }

    const meta = await getOEmbed(url);
    const bulleted = [
      meta?.title ? `Title: ${meta.title}` : null,
      meta?.author_name ? `Author: ${meta.author_name}` : null,
      `Link: ${url}`
    ].filter(Boolean).join("\n");

    let summary = "AI summarization unavailable (no OPENAI_API_KEY).";
    if (ai) {
      const out = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: "Summarize trading-relevant info in 6 bullets, then list 3 actionables." },
          { role: "user", content: `Summarize this content (metadata only; no transcript):\n${bulleted}` }
        ]
      });
      summary = out.choices?.[0]?.message?.content || summary;
    }

    push("intel:url", { url, meta, summary });
    res.json({ ok: true, meta, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Utility: Proxy quotes (e.g., Jupiter) — client can fetch to display
app.get("/api/quote/jup", async (req, res) => {
  try {
    // Pass-through to Jupiter Quote v6 (safe GET)
    const q = new URL("https://quote-api.jup.ag/v6/quote");
    for (const [k, v] of Object.entries(req.query)) q.searchParams.set(k, v);
    const r = await fetch(q.toString());
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Health
app.get("/health", (_req, res) => res.json({ ok: true, LIVE_TRADING, bots: bots.size }));

// ---------- Fallback to UI
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});