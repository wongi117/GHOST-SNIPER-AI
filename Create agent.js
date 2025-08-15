// agent.js  — Ghost Sniper Agent (Node 22 ESM)
//
// Responsibilities
// - Run a long-lived AI agent that you can start/stop
// - Understand natural language and map it to tools (markets, snipe, sell,
//   set budget/risk/live, watch wallets, etc.)
// - Paper-mode by default; only live-trades if LIVE_TRADING === 'true'
// - Streams logs and decisions to all connected WebSocket clients
//
// Integration
// - add: import { initAgent } from "./agent.js"; then initAgent(app, wss);
// - env: OPENAI_API_KEY, LIVE_TRADING (default false)
//        JUPITER_BASE (default https://quote-api.jup.ag/v6)
//        ZEROX_BASE (default https://api.0x.org)
//        ENABLE_TELEGRAM (optional true/false) [handled elsewhere]
// - endpoints exposed (see initAgent): /api/agent/*
//
// NOTE: Sniping hooks call placeholders jupiterSnipe() and zeroXSnipe().
// Wire them to your real swap code when you’re ready.
// ---------------------------------------------------------------

import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { EventEmitter } from "events";
dotenv.config();

const cfg = {
  model: process.env.AGENT_MODEL || "gpt-4o-mini",
  live: (process.env.LIVE_TRADING || "false").toLowerCase() === "true",
  jupBase: process.env.JUPITER_BASE || "https://quote-api.jup.ag/v6",
  zeroXBase: process.env.ZEROX_BASE || "https://api.0x.org",
  coinGecko: "https://api.coingecko.com/api/v3",
  dexScreener: "https://api.dexscreener.com",
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --------------- Utilities -----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowISO() {
  return new Date().toISOString();
}

function ok(v) {
  return { ok: true, data: v };
}
function fail(msg, meta = {}) {
  return { ok: false, error: msg, ...meta };
}

// --------------- Market adapters -----------------

async function cgTrending() {
  try {
    const r = await fetch(`${cfg.coinGecko}/search/trending`, {
      headers: { "user-agent": "ghost-sniper" },
    });
    if (!r.ok) throw new Error(`CG ${r.status}`);
    const j = await r.json();
    const items =
      j?.coins?.map((c) => ({
        symbol: c?.item?.symbol,
        name: c?.item?.name,
        id: c?.item?.id,
        score: c?.item?.score,
        market_cap_rank: c?.item?.market_cap_rank,
      })) || [];
    return ok(items);
  } catch (e) {
    return fail(`coingecko trending failed: ${e.message}`);
  }
}

async function dsNewPairs(chain = "solana") {
  // Dexscreener “new pairs” per chain
  const endpoints = [
    `${cfg.dexScreener}/latest/dex/new-pairs/${chain}`,
    `${cfg.dexScreener}/latest/dex/search?q=${encodeURIComponent(chain)}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "ghost-sniper" } });
      if (!r.ok) throw new Error(`Dex ${r.status}`);
      const j = await r.json();
      const pairs = j?.pairs || j?.result || [];
      if (pairs?.length) {
        return ok(
          pairs.slice(0, 20).map((p) => ({
            chainId: p?.chainId ?? chain,
            dexId: p?.dexId,
            pairAddress: p?.pairAddress,
            baseToken: p?.baseToken,
            quoteToken: p?.quoteToken,
            priceUsd: p?.priceUsd,
            volume: p?.volume,
            liquidity: p?.liquidity,
            fdv: p?.fdv,
            url: p?.url,
          }))
        );
      }
    } catch {}
  }
  return fail("dexscreener produced no data");
}

async function pumpfunIntel() {
  // Best-effort public endpoint. If it changes, this will just degrade gracefully.
  const urls = [
    "https://pumpportal.fun/api/data",
    "https://pumpportal.fun/api/trending",
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "ghost-sniper" } });
      if (!r.ok) throw new Error(`pump.fun ${r.status}`);
      const j = await r.json();
      return ok(j);
    } catch {}
  }
  return fail("pump.fun feed unavailable");
}

// --------------- Trade hooks (paper + TODO: live) -----------------

async function jupiterSnipe({ mint, amountSol, slippage = 1, priority = 0 }) {
  // Placeholder for your live Solana swap (Jupiter + wallet signer).
  // Right now: simulate only and return a “paper fill”.
  // Wire to your existing swap function when ready.
  return ok({
    network: "sol",
    router: "jupiter",
    mint,
    amountSol,
    slippage,
    priority,
    txid: cfg.live ? "(TODO wire live signer)" : "paper-" + Date.now(),
    live: cfg.live,
  });
}

async function zeroXSnipe({ chain = "ethereum", buyToken, sellToken, amount }) {
  // Placeholder for your EVM live swap via 0x API (needs wallet signer).
  // Currently paper-only, returning a simulated fill.
  return ok({
    network: chain,
    router: "0x",
    sellToken,
    buyToken,
    amount,
    txid: cfg.live ? "(TODO wire live signer)" : "paper-" + Date.now(),
    live: cfg.live,
  });
}

// --------------- The Agent -----------------

class GhostAgent extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.memory = []; // short rolling memory of events
    this.params = {
      budgetUSD: 200,
      risk: "medium",
      live: cfg.live,
      maxConcurrent: 3,
      confirmBeforeLive: true,
      watchWallets: [],
    };
    this.wsBroadcast = () => {};
    this.loopHandle = null;
  }

  attachBroadcaster(fn) {
    this.wsBroadcast = fn;
  }

  log(level, msg, extra = {}) {
    const entry = { t: nowISO(), level, msg, ...extra };
    this.memory.push(entry);
    if (this.memory.length > 200) this.memory.shift();
    this.wsBroadcast({ type: "agentLog", entry });
    console.log(`[agent ${level}]`, msg);
  }

  status() {
    return {
      running: this.running,
      params: this.params,
      liveEnv: cfg.live,
      model: cfg.model,
      mem: this.memory.slice(-20),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log("info", "Agent started.");
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.log("info", "Agent stopped.");
  }

  schedule(ms) {
    this.loopHandle = setTimeout(() => this.loop(), ms);
  }

  async loop() {
    if (!this.running) return;

    // Lightweight periodic intel
    try {
      const [cg, dex] = await Promise.all([cgTrending(), dsNewPairs("solana")]);
      if (cg.ok) this.wsBroadcast({ type: "intel", source: "coingecko", items: cg.data });
      if (dex.ok) this.wsBroadcast({ type: "intel", source: "dexscreener", items: dex.data });
      this.log("debug", "Refreshed intel snapshots.");
    } catch (e) {
      this.log("warn", `intel loop error: ${e.message}`);
    }

    // Example strategy stub: do nothing automatically right now.
    // (You can extend here to auto-queue paper snipes on signals.)
    this.schedule(20_000);
  }

  // ---------- Natural-language command entry ----------

  async prompt(text, source = "web") {
    const sys = [
      "You are Ghost Sniper, an onchain trading agent.",
      "Default to paper mode. Only trade live if env LIVE_TRADING=true and user explicitly approves.",
      "Be concise. When you want to act, call a TOOL.",
    ].join(" ");

    const tools = [
      {
        type: "function",
        function: {
          name: "markets",
          description: "Get quick market intel. chain can be 'sol' | 'evm' | 'all'",
          parameters: {
            type: "object",
            properties: { chain: { type: "string" } },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "queueSnipe",
          description:
            "Buy a token quickly. For SOL give mint if known; for EVM give buyToken symbol or address.",
          parameters: {
            type: "object",
            properties: {
              chain: { type: "string", description: "sol|evm" },
              token: { type: "string", description: "mint address or symbol" },
              amount: { type: "number", description: "Amount in SOL or ETH" },
              slippage: { type: "number" },
              priority: { type: "number" },
              live: { type: "boolean" },
            },
            required: ["chain", "token", "amount"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "setParams",
          description:
            "Update budget, risk, live, or maxConcurrent. Budget is in USD unless otherwise stated.",
          parameters: {
            type: "object",
            properties: {
              budgetUSD: { type: "number" },
              risk: { type: "string" },
              live: { type: "boolean" },
              maxConcurrent: { type: "number" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "watchWallet",
          description: "Add a wallet to watch",
          parameters: {
            type: "object",
            properties: { address: { type: "string" } },
            required: ["address"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "sell",
          description:
            "Close/sell a position. For SOL give mint; for EVM give token address or symbol.",
          parameters: {
            type: "object",
            properties: {
              chain: { type: "string" },
              token: { type: "string" },
              amountPct: { type: "number", description: "0-100%" },
            },
            required: ["chain", "token"],
          },
        },
      },
    ];

    this.log("user", text, { source });

    const messages = [
      { role: "system", content: sys },
      { role: "user", content: text },
    ];

    const resp = await openai.chat.completions.create({
      model: cfg.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    });

    const msg = resp.choices[0].message;
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        await this.dispatchTool(name, args);
      }
      return { ok: true, toolCalls: msg.tool_calls };
    } else {
      // No tool call; just text
      const content = msg.content?.trim() || "(no response)";
      this.log("assistant", content);
      return { ok: true, text: content };
    }
  }

  // ---------- Tool dispatcher ----------

  async dispatchTool(name, args) {
    try {
      switch (name) {
        case "markets": {
          const chain = (args.chain || "all").toLowerCase();
          const out = {};
          if (chain === "all" || chain === "sol") {
            out.coingecko = (await cgTrending());
            out.dexSol = (await dsNewPairs("solana"));
            out.pumpfun = (await pumpfunIntel());
          }
          if (chain === "all" || chain === "evm") {
            out.coingecko = out.coingecko || (await cgTrending());
            out.dexEvm = (await dsNewPairs("ethereum"));
          }
          this.wsBroadcast({ type: "markets", chain, data: out });
          this.log("ok", `markets snapshot (${chain}) ready`);
          break;
        }

        case "queueSnipe": {
          const {
            chain = "sol",
            token,
            amount,
            slippage = 1,
            priority = 0,
            live = false,
          } = args;

          const wantsLive = !!live || this.params.live;
          if (wantsLive && (!cfg.live || this.params.confirmBeforeLive)) {
            this.log(
              "warn",
              `Live trading requested but gated. LIVE_TRADING=${cfg.live}, confirmBeforeLive=${this.params.confirmBeforeLive}`
            );
          }

          if (chain === "sol") {
            const res = await jupiterSnipe({
              mint: token,
              amountSol: amount,
              slippage,
              priority,
            });
            if (res.ok) {
              this.wsBroadcast({ type: "trade", action: "buy", res: res.data });
              this.log("ok", `SOL snipe queued → ${token}`, { res: res.data });
            } else {
              this.log("error", `SOL snipe failed: ${res.error}`);
            }
          } else {
            const res = await zeroXSnipe({
              chain: "ethereum",
              buyToken: token,
              sellToken: "ETH",
              amount,
            });
            if (res.ok) {
              this.wsBroadcast({ type: "trade", action: "buy", res: res.data });
              this.log("ok", `EVM snipe queued → ${token}`, { res: res.data });
            } else {
              this.log("error", `EVM snipe failed: ${res.error}`);
            }
          }
          break;
        }

        case "setParams": {
          const before = { ...this.params };
          this.params = { ...this.params, ...args };
          if (typeof args.live === "boolean") {
            // Do not exceed env live
            this.params.live = args.live && cfg.live;
          }
          this.wsBroadcast({ type: "agentParams", params: this.params });
          this.log("ok", "Updated params", {
            before,
            after: this.params,
          });
          break;
        }

        case "watchWallet": {
          const { address } = args;
          if (!address) throw new Error("address required");
          if (!this.params.watchWallets.includes(address)) {
            this.params.watchWallets.push(address);
          }
          this.wsBroadcast({ type: "watch", address });
          this.log("ok", `Now watching wallet ${address}`);
          break;
        }

        case "sell": {
          const { chain = "sol", token, amountPct = 100 } = args;
          // Placeholder – wire to your close flow
          this.log("ok", `Sell requested ${amountPct}% of ${token} on ${chain}. (TODO wire)`);
          this.wsBroadcast({ type: "trade", action: "sell", token, chain, amountPct });
          break;
        }

        default:
          this.log("warn", `Unknown tool ${name}`);
      }
    } catch (e) {
      this.log("error", `Tool ${name} error: ${e.message}`, { args });
    }
  }
}

// Singleton
export const agent = new GhostAgent();

// HTTP + WS wiring
export function initAgent(app, wss) {
  // Wire broadcaster to all WS clients
  agent.attachBroadcaster((payload) => {
    const msg = JSON.stringify({ topic: "agent", payload });
    wss.clients.forEach((c) => {
      try {
        if (c.readyState === 1) c.send(msg);
      } catch {}
    });
  });

  // REST endpoints
  app.get("/api/agent/status", (req, res) => {
    res.json(agent.status());
  });

  app.post("/api/agent/start", async (req, res) => {
    agent.start();
    res.json({ ok: true, status: agent.status() });
  });

  app.post("/api/agent/stop", async (req, res) => {
    agent.stop();
    res.json({ ok: true, status: agent.status() });
  });

  app.post("/api/agent/prompt", async (req, res) => {
    try {
      const { text, source = "web" } = await req.json?.() || req.body || {};
      if (!text) return res.status(400).json({ ok: false, error: "text required" });
      const out = await agent.prompt(text, source);
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/agent/params", async (req, res) => {
    try {
      const body = req.json?.() ? await req.json() : req.body;
      await agent.dispatchTool("setParams", body || {});
      res.json({ ok: true, params: agent.params });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Start in idle mode
  agent.log("info", "Agent ready (idle).");
}