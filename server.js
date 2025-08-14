// ============== MARKET INTEL: Dexscreener + CoinGecko + TA =================
import { RSI, EMA, MACD, BollingerBands } from "technicalindicators";

/** Dexscreener: pairs by token (fast, no key) */
app.get("/api/alpha/dxscreener/tokens", async (req, res) => {
  try {
    const { chainId = "solana", addresses = "" } = req.query;
    if (!addresses) return res.status(400).json({ error: "addresses required (comma-separated mints)" });
    const url = `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(addresses)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    res.status(500).json({ error: "dxs_tokens_error", detail: String(e) });
  }
});

/** Dexscreener: single pair (liquidity/txns/priceChange) */
app.get("/api/alpha/dxscreener/pair", async (req, res) => {
  try {
    const { chainId = "solana", pair } = req.query;
    if (!pair) return res.status(400).json({ error: "pair required" });
    const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pair)}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    res.status(500).json({ error: "dxs_pair_error", detail: String(e) });
  }
});

/** Quick risk/quality score for a Solana mint using Dexscreener data */
app.get("/api/alpha/score", async (req, res) => {
  try {
    const { chainId = "solana", tokenAddress } = req.query;
    if (!tokenAddress) return res.status(400).json({ error: "tokenAddress required" });
    const url = `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
    const r = await fetch(url);
    const pairs = await r.json(); // array of pools
    if (!Array.isArray(pairs) || !pairs.length) {
      return res.json({ ok: true, score: 0, reason: "no_pools_found", pairs: [] });
    }
    // Heuristic score (fast + explainable)
    const best = pairs[0];
    const liq = best?.liquidity?.usd || 0;
    const tx5m = best?.txns?.m5?.buys + best?.txns?.m5?.sells || 0;
    const buys5m = best?.txns?.m5?.buys || 0;
    const change5m = best?.priceChange?.m5 ?? 0;
    const ageMin = Math.max(0, (Date.now() - (best?.pairCreatedAt || Date.now())) / 60000);

    let score = 0;
    if (liq >= 5000) score += 2;
    if (liq >= 20000) score += 2;
    if (tx5m >= 30) score += 2;
    if (buys5m > (best?.txns?.m5?.sells || 0)) score += 1;
    if (change5m > -15 && change5m < 150) score += 1;      // avoid nukes + insane spikes
    if (ageMin >= 1 && ageMin <= 180) score += 1;          // not too old, not 0 sec
    res.json({
      ok: true,
      score,
      inputs: { liq, tx5m, buys5m, change5m, ageMin },
      pair: best
    });
  } catch (e) {
    res.status(500).json({ error: "score_error", detail: String(e) });
  }
});

/** CoinGecko OHLC (requires Pro API key now). Set CG_API_KEY in Railway. */
app.get("/api/alpha/gecko/ohlc", async (req, res) => {
  try {
    const { id = "bitcoin", days = "1" } = req.query;
    const key = process.env.CG_API_KEY || "";
    if (!key) return res.status(400).json({ error: "CG_API_KEY not set" });
    const url = `https://pro-api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/ohlc?days=${encodeURIComponent(days)}`;
    const r = await fetch(url, { headers: { "accept": "application/json", "x-cg-pro-api-key": key } });
    const j = await r.json();
    return res.json(j);
  } catch (e) {
    res.status(500).json({ error: "gecko_ohlc_error", detail: String(e) });
  }
});

/** TA endpoint: send closes[], get RSI/EMA/MACD/BB back */
app.post("/api/alpha/ta", async (req, res) => {
  try {
    const closes = (req.body?.closes || []).map(Number).filter(x => Number.isFinite(x));
    if (closes.length < 30) return res.status(400).json({ error: "need >=30 closes" });

    const rsi = RSI.calculate({ period: 14, values: closes });
    const ema20 = EMA.calculate({ period: 20, values: closes });
    const macd = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false
    });
    const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });

    res.json({ rsi, ema20, macd, bb });
  } catch (e) {
    res.status(500).json({ error: "ta_error", detail: String(e) });
  }
});
