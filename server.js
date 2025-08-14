// server.js – Ghost Sniper AI Backend

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

// ====== CONFIG ======
const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ====== Health Check ======
app.get("/health", (_req, res) => {
  res.json({ status: "Ghost Sniper AI backend is running" });
});

// ====== Wallet Connect - Phantom (Solana) ======
app.post("/connect-phantom", async (req, res) => {
  try {
    const { publicKey } = req.body;
    console.log(`Phantom wallet connected: ${publicKey}`);
    res.json({ success: true, message: "Phantom wallet connected", publicKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Phantom connection failed" });
  }
});

// ====== Wallet Connect - MetaMask (Ethereum) ======
app.post("/connect-metamask", async (req, res) => {
  try {
    const { address } = req.body;
    console.log(`MetaMask wallet connected: ${address}`);
    res.json({ success: true, message: "MetaMask wallet connected", address });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "MetaMask connection failed" });
  }
});

// ====== Sniper Bot Trade Execution ======
app.post("/execute-trade", async (req, res) => {
  try {
    const { chain, tokenAddress, amount } = req.body;
    console.log(`Executing trade on ${chain}: ${amount} of ${tokenAddress}`);
    // TODO: Add Solana/Ethereum trade execution logic here
    res.json({ success: true, message: `Trade executed on ${chain}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Trade execution failed" });
  }
});

// ====== AI Assistant ======
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: message }],
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "AI chat failed" });
  }
});

// ====== Start Server ======
app.listen(PORT, () => {
  console.log(`Ghost Sniper AI backend running on port ${PORT}`);
});
