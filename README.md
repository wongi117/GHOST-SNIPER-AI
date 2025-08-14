
# Ghost Sniper — Day‑0 MVP (Trade Today)

This is a minimal, safe starter so you can **trade today** while we build full auto-trading later.

## What you get
- **Jupiter Terminal** embedded (wallet connect + swaps in your browser).
- **Simple Chat** box (talk to "Ghost Sniper").
- **/quote** API that calls Jupiter Quote v6 to fetch real swap quotes.
- **/chat** API wired for OpenAI (function calling stub).

> The AI suggests; **you sign in your wallet**. No private keys on the server.

## Quick start

1. **Install Node 20+** (https://nodejs.org)
2. In this folder, run:
   ```bash
   npm install
   cp .env.example .env
   # edit .env to add your OPENAI_API_KEY (optional for chat)
   npm start
   ```
3. Open **http://localhost:3000** and click **Connect Wallet** in the swap box.
4. Try a small swap (e.g., USDC ↔ SOL). Confirm in Phantom/Solflare, then verify on Solscan.

## Environment Variables

Edit `.env`:
```
# Optional but recommended for Chat:
OPENAI_API_KEY=sk-...
# Optional: choose Helius or your preferred RPC for server-side sanity checks (not used by the Terminal)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PORT=3000
```

## Notes
- Jupiter Terminal handles wallet connection in the browser. Your keys never touch the server.
- The `/quote` endpoint proxies Jupiter Quote so your browser avoids CORS/rate limits.
- The `/chat` endpoint is prepped for OpenAI tool-calling; it can be extended to suggest trades.
- **Keep trade sizes small** until you're comfortable.
- Deploy anywhere (Railway, Render, Fly.io, VPS).

## Deploy (Railway example)
- Create a new project from this folder/repo.
- Add `OPENAI_API_KEY` in Variables (optional).
- Deploy. Visit your URL and connect your wallet to trade.

Stay safe and trade small while testing.
