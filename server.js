// server.js — Ghost Sniper AI backend (Node 22 on Railway)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- serve /public (required by Railway) ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// --- Health ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Jupiter v6 quote proxy (Solana) ---
app.get("/api/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 50 } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "Missing params" });
    }
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount)); // in atomic units
    url.searchParams.set("slippageBps", String(slippageBps));
    const r = await fetch(url.toString());
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "quote_error", detail: String(e) });
  }
});

// --- Jupiter v6 swap transaction builder (returns a tx to sign) ---
app.post("/api/swap", async (req, res) => {
  try {
    // client posts best route from /api/quote and their publicKey base58
    const { route, userPublicKey, wrapAndUnwrapSol = true } = req.body || {};
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
        prioritizationFeeLamports: "auto"
      }),
    });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "swap_error", detail: String(e) });
  }
});

// --- Dexscreener passthrough (simple search by token address or pair) ---
app.get("/api/dexscreener", async (req, res) => {
  try {
    const { q } = req.query; // address or search term
    if (!q) return res.status(400).json({ error: "Missing q" });
    // Dexscreener has many endpoints; their unified search is handy:
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "dexscreener_error", detail: String(e) });
  }
});

// --- CoinGecko simple price (id or contract on supported chains) ---
app.get("/api/coingecko-price", async (req, res) => {
  try {
    const { ids = "", vs = "usd" } = req.query; // ids: comma-separated coingecko IDs e.g. "solana"
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

// Fallback to the SPA index (must exist at /public/index.html)
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});