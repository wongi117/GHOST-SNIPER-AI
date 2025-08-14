// server.js — Ghost Sniper backend (Node 22 / ESM)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import WebSocket from "ws";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Serve /public if it exists, else serve repo root
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security/CORS (adjust origin if you want to lock it down)
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ========= HEALTH =========
app.get("/health", (_req, res) => res.json({ ok: true }));

// ========= PUMP.FUN (PumpPortal) =========
// 1) Live feed of new tokens (SSE → browser)
app.get("/api/pump/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  let open = false;

  const heartbeat = setInterval(() => {
    if (open) res.write(`event: ping\ndata: {}\n\n`);
  }, 20000);

  ws.on("open", () => {
    open = true;
    ws.send(JSON.stringify({ method: "subscribeNewToken" })); // subscribe to launches
    // You can also subscribe to trades if you want:
    // ws.send(JSON.stringify({ method: "subscribeTokenTrade", mint: "<MINT>" }))
  });

  ws.on("message", (data) => {
    // Relay raw JSON to the browser as SSE
    res.write(`data: ${data.toString()}\n\n`);
  });

  const end = () => {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  };

  ws.on("close", end);
  ws.on("error", end);

  req.on("close", () => {
    try { ws.close(); } catch {}
    end();
  });
});

// Helper to call PumpPortal trade-local and return base64 tx
async function buildPumpTx({
  publicKey, action, mint, amount,
  denominatedInSol, slippage, priorityFee, pool
}) {
  const body = {
    publicKey,
    action, // "buy" | "sell"
    mint,
    amount, // number | "100%"
    denominatedInSol: String(!!denominatedInSol), // expects string "true"/"false"
    slippage,        // %
    priorityFee,     // SOL
    pool             // "pump" | "raydium"
  };

  const resp = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (resp.status !== 200) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PumpPortal ${resp.status}: ${text}`);
  }

  const buf = Buffer.from(new Uint8Array(await resp.arrayBuffer()));
  return buf.toString("base64"); // serialized versioned tx (base64)
}

// 2) BUY (snipe) — non-custodial, user signs in Phantom
app.post("/api/pump/snipe", async (req, res) => {
  try {
    const {
      publicKey, mint, amount,
      denominatedInSol = true,
      slippage = Number(process.env.PUMP_SLIPPAGE || 1),
      priorityFee = Number(process.env.PUMP_PRIORITY_FEE || 0.00002),
      pool = process.env.PUMP_POOL || "pump"
    } = req.body || {};

    if (!publicKey || !mint || !amount) {
      return res.status(400).json({ error: "Missing publicKey, mint or amount" });
    }

    const tx = await buildPumpTx({
      publicKey, action: "buy", mint, amount,
      denominatedInSol, slippage, priorityFee, pool
    });

    return res.json({ tx }); // base64
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "snipe_build_failed", detail: String(e) });
  }
});

// 3) SELL (exit) — non-custodial
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

    if (!publicKey || !mint) {
      return res.status(400).json({ error: "Missing publicKey or mint" });
    }

    const tx = await buildPumpTx({
      publicKey, action: "sell", mint, amount,
      denominatedInSol, slippage, priorityFee, pool
    });

    return res.json({ tx }); // base64
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "exit_build_failed", detail: String(e) });
  }
});

// ========= CHAT (OpenAI) =========
import OpenAI from "openai";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let openai = null;
if (OPENAI_API_KEY) openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// POST /api/chat  -> { messages: [{role, content}, ...] }
app.post("/api/chat", async (req, res) => {
  try {
    if (!openai) return res.json({ role: "assistant", content: "OpenAI key not set." });
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const out = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages
    });
    return res.json(out.choices[0].message);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ role: "assistant", content: "Chat error." });
  }
});

// ========= FALLBACK: serve index.html =========
app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ========= START =========
app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});
