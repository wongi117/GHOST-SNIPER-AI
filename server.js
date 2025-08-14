import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve /public if it exists, otherwise serve repo root
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, port: PORT }));

// Quote proxy (Jupiter example)
app.get("/api/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.query;
    if (!inputMint || !outputMint || !amount)
      return res.status(400).json({ error: "Missing required params" });

    const u = new URL("https://quote-api.jup.ag/v6/quote");
    u.searchParams.set("inputMint", inputMint);
    u.searchParams.set("outputMint", outputMint);
    u.searchParams.set("amount", String(amount));
    u.searchParams.set("slippageBps", String(slippageBps || 50));

    const r = await fetch(u.toString());
    res.json(await r.json());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "quote_api_error", detail: String(e) });
  }
});

// Simple AI chat passthrough (needs OPENAI_API_KEY)
app.post("/api/chat", async (req, res) => {
  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const { messages } = req.body || { messages: [{ role: "user", content: "ping" }] };
    const out = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages
    });
    res.json(out.choices[0].message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "chat_error", detail: String(e) });
  }
});

// Serve the UI
app.get("*", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "index.html"))
);

// IMPORTANT for Railway: bind to 0.0.0.0
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Ghost Sniper running on port ${PORT}`)
);