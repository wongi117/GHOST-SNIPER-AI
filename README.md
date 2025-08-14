# Ghost Sniper AI — 3 Bot Stack

- **Bots**: `sol-pumpfun`, `evm-0x`, `paper` (sim)  
- **Wallets**: Phantom + MetaMask  
- **AI chat**: /api/chat (OpenAI)  
- **URL Intel**: /api/url-intel (YT/TikTok oEmbed + summary)  
- **WS feed**: /ws (signals, trades, chat)

## Run (Railway)
- Put all files in repo.
- In Railway → Variables:
  - `OPENAI_API_KEY` = `sk-...`
  - `PORT` = `3000`
  - (optional live) `LIVE_TRADING=true`, `ALCHEMY_MAINNET`, `SOLANA_RPC`
- Deploy (Node 22).

## Live trading
Paper is default. For live:
- On **Solana**: implement Jupiter swap building on the server and **sign in client** via Phantom.
- On **EVM**: get 0x quote & tx data, then **send with MetaMask**.

*Until you wire signing flows, “live” endpoints emit stubs for safety.*