
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

// --- Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Proxy to Jupiter Quote v6 for convenience (server-side fetch -> avoid CORS in browser)
app.get("/api/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 50, onlyDirectRoutes = false } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "Missing required params: inputMint, outputMint, amount" });
    }
    const url = new URL("https://quote-api.jup.ag/v6/quote");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("onlyDirectRoutes", String(onlyDirectRoutes));

    const r = await fetch(url.toString());
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Quote error", detail: String(e) });
  }
});

// --- Minimal Chat endpoint (OpenAI optional). Adds a "get_quote" tool for the model.
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages[] required" });
    }

    const tools = [
      {
        type: "function",
        function: {
          name: "get_quote",
          description: "Fetch a swap quote using Jupiter v6",
          parameters: {
            type: "object",
            properties: {
              inputMint: { type: "string", description: "Mint address to swap from" },
              outputMint: { type: "string", description: "Mint address to swap to" },
              amount: { type: "string", description: "Raw amount in smallest units (e.g., lamports)" },
              slippageBps: { type: "integer", description: "Slippage in bps (50 = 0.5%)", default: 50 }
            },
            required: ["inputMint", "outputMint", "amount"]
          }
        }
      }
    ];

    // If no key, return a local fallback message so the UI still works.
    if (!OPENAI_API_KEY) {
      return res.json({
        role: "assistant",
        content: "Chat is in local mode. Add OPENAI_API_KEY in .env to enable AI suggestions.",
      });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages,
      tools
    });

    const msg = completion.choices[0].message;

    // If the model requests get_quote, execute it
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const call = msg.tool_calls[0];
      if (call.function?.name === "get_quote") {
        const args = JSON.parse(call.function.arguments || "{}");
        const qUrl = new URL("https://quote-api.jup.ag/v6/quote");
        qUrl.searchParams.set("inputMint", args.inputMint);
        qUrl.searchParams.set("outputMint", args.outputMint);
        qUrl.searchParams.set("amount", String(args.amount));
        qUrl.searchParams.set("slippageBps", String(args.slippageBps ?? 50));

        const r = await fetch(qUrl.toString());
        const data = await r.json();

        // Send tool result back to the model for a final, user-friendly reply
        const completion2 = await client.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.3,
          messages: [
            ...messages,
            msg,
            {
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify({ ok: true, quote: data })
            }
          ]
        });

        const finalMsg = completion2.choices[0].message;
        return res.json(finalMsg);
      }
    }

    // No tool call — return the model's reply
    return res.json(msg);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "chat error", detail: String(e) });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Ghost Sniper Day‑0 running on http://localhost:${PORT}`));
