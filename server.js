// server.js — Ghost Sniper AI Backend (Node 22 / ESM)

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

// --- Basic security / CORS (set your prod domain if you want to lock down) ---
app.use(cors({ origin: "*"}));
app.use(express.json());

// --- Serve /public if it exists, else serve root folder (for index.html) ---
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

app.use(express.static(PUBLIC_DIR));

// --- Health check
app.get("/health", (_req, res) =>
  res.json({ ok: true, env: "production", time: new Date().toISOString() })
);

// --- Tiny helper
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.json();
}

/**
 * GET /api/dexsearch?q=<symbol|address>
 * Proxies Dexscreener search to avoid CORS in browsers.
 * Example: /api/dexsearch?q=sol
 */
app.get("/api/dexsearch", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(
      q
    )}`;
    const data = await fetchJSON(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "dexsearch_error", detail: String(e) });
  }
});

/**
 * GET /api/price?id=<coingecko-id>&vs=<usd,eur,...>
 * Example: /api/price?id=solana&vs=usd
 */
app.get("/api/price", async (req, res) => {
  try {
    const id = String(req.query.id || "solana");
    const vs = String(req.query.vs || "usd");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
      id
    )}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`;
    const data = await fetchJSON(url, {
      headers: { "x-cg-demo-api-key": "demo" }, // header optional
    });
    res.json({ id, vs, data, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: "coingecko_error", detail: String(e) });
  }
});

/**
 * GET /api/snipe
 * Jupiter v6 quote PREVIEW (no signing or execution here).
 * Params:
 *  - inputMint  (string, e.g. SOL = So11111111111111111111111111111111111111112)
 *  - outputMint (string)
 *  - amount     (number, base units; for SOL it's lamports)
 *  - slippageBps (number, e.g. 100 = 1%)
 *
 * Example:
 * /api/snipe?inputMint=So1111...&outputMint=<MINT>&amount=10000000&slippageBps=100
 */
app.get("/api/snipe", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 100 } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({
        error: "missing_params",
        need: ["inputMint", "outputMint", "amount"],
      });
    }

    const u = new URL("https://quote-api.jup.ag/v6/quote");
    u.searchParams.set("inputMint", String(inputMint));
    u.searchParams.set("outputMint", String(outputMint));
    u.searchParams.set("amount", String(amount));
    u.searchParams.set("slippageBps", String(slippageBps));
    // Optional tunables:
    u.searchParams.set("onlyDirectRoutes", "false");
    u.searchParams.set("asLegacyTransaction", "false");

    const quote = await fetchJSON(u.toString());
    res.json({
      ok: true,
      mode: "preview",
      note:
        "This is a QUOTE ONLY. To execute, call /api/snipe/tx with wallet pubkey and then sign+send on the client.",
      quote,
    });
  } catch (e) {
    res.status(500).json({ error: "jupiter_quote_error", detail: String(e) });
  }
});

/**
 * POST /api/snipe/tx
 * (Scaffold) Prepare a swap transaction using the Jupiter "swap" endpoint.
 * Body should include:
 *  - quoteResponse (the object returned by /v6/quote)
 *  - userPublicKey  (base58 string of the connected wallet)
 *
 * Returns: a base64 transaction you must sign + send from the client wallet.
 * NOTE: We DO NOT sign or keep keys on server.
 */
app.post("/api/snipe/tx", async (req, res) => {
  try {
    const { quoteResponse, userPublicKey } = req.body || {};
    if (!quoteResponse || !userPublicKey) {
      return res
        .status(400)
        .json({ error: "missing_body", need: ["quoteResponse", "userPublicKey"] });
    }

    const swapReq = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    };

    const swapUrl = "https://quote-api.jup.ag/v6/swap";
    const swap = await fetchJSON(swapUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(swapReq),
    });

    // Client must sign & send:
    //   const tx = swap.swapTransaction (base64)
    //   let txid = await wallet.sendTransaction(VersionedTransaction.deserialize(...))
    res.json({
      ok: true,
      mode: "tx_build",
      note:
        "Return this base64 transaction to the client. The client must sign & send via Phantom.",
      swap,
    });
  } catch (e) {
    res.status(500).json({ error: "jupiter_swap_error", detail: String(e) });
  }
});

// --- Optional: simple wallet test page at /wallet-test if present ---
app.get("/wallet-test", (req, res) => {
  const p = path.join(PUBLIC_DIR, "wallet-test.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send("wallet-test.html not found");
});

// --- Fallback: serve index.html for SPA-style routing ---
app.get("*", (req, res) => {
  const p = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  res
    .status(404)
    .send("index.html not found — commit your front-end or push /public/index.html");
});

app.listen(PORT, () =>
  console.log(`🚀 Ghost Sniper backend running on http://localhost:${PORT}`)
);