// Live crypto data for the Markets page. Cached at Vercel's edge so every viewer shares one upstream call.
// GET /api/crypto?part=markets|global|trending|new
const HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; NorthlineBriefing/1.0)" };

async function getJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const round = (x) => (typeof x === "number" && isFinite(x) ? Number(x.toPrecision(7)) : null);

async function markets(n) {
  const data = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d`);
  return {
    source: "CoinGecko",
    coins: data.map((c) => ({
      id: c.id, symbol: String(c.symbol || "").toUpperCase(), name: c.name, image: c.image,
      rank: c.market_cap_rank, price: round(c.current_price), mcap: c.market_cap, vol: c.total_volume,
      high24: round(c.high_24h), low24: round(c.low_24h), ath: round(c.ath), athChange: round(c.ath_change_percentage),
      ch1h: round(c.price_change_percentage_1h_in_currency),
      ch24h: round(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      ch7d: round(c.price_change_percentage_7d_in_currency), ch30d: round(c.price_change_percentage_30d_in_currency),
      spark: ((c.sparkline_in_7d && c.sparkline_in_7d.price) || []).map(round),
    })),
  };
}

async function global() {
  const [g, fng] = await Promise.all([
    getJSON("https://api.coingecko.com/api/v3/global"),
    getJSON("https://api.alternative.me/fng/?limit=31").catch(() => null),
  ]);
  const d = g.data || {};
  return {
    totalMcap: d.total_market_cap && d.total_market_cap.usd,
    totalVol: d.total_volume && d.total_volume.usd,
    mcapChange24h: round(d.market_cap_change_percentage_24h_usd),
    btcDominance: round(d.market_cap_percentage && d.market_cap_percentage.btc),
    ethDominance: round(d.market_cap_percentage && d.market_cap_percentage.eth),
    activeCoins: d.active_cryptocurrencies,
    fearGreed: fng && fng.data ? fng.data.map((x) => ({ value: Number(x.value), label: x.value_classification, time: Number(x.timestamp) })) : [],
  };
}

async function trending() {
  const t = await getJSON("https://api.coingecko.com/api/v3/search/trending");
  return {
    coins: (t.coins || []).map(({ item }) => ({
      id: item.id, symbol: String(item.symbol || "").toUpperCase(), name: item.name, rank: item.market_cap_rank,
      thumb: item.thumb, price: round(item.data && item.data.price),
      ch24h: round(item.data && item.data.price_change_percentage_24h && item.data.price_change_percentage_24h.usd),
      mcap: item.data && item.data.market_cap,
    })),
  };
}

async function newPools() {
  const nets = ["solana", "eth", "base", "bsc"];
  const all = await Promise.all(nets.map((n) =>
    getJSON(`https://api.geckoterminal.com/api/v2/networks/${n}/new_pools?page=1`, 8000).then((r) => ({ n, r })).catch(() => null)));
  const pools = [];
  for (const x of all) {
    if (!x || !x.r || !x.r.data) continue;
    for (const p of x.r.data) {
      const a = p.attributes || {};
      pools.push({
        network: x.n, address: a.address, name: a.name, created: a.pool_created_at,
        price: round(Number(a.base_token_price_usd)), liquidity: Number(a.reserve_in_usd) || 0,
        vol24: Number(a.volume_usd && a.volume_usd.h24) || 0,
        ch1h: round(Number(a.price_change_percentage && a.price_change_percentage.h1)),
        ch24h: round(Number(a.price_change_percentage && a.price_change_percentage.h24)),
        buys24: a.transactions && a.transactions.h24 && a.transactions.h24.buys,
        sells24: a.transactions && a.transactions.h24 && a.transactions.h24.sells,
        url: `https://www.geckoterminal.com/${x.n}/pools/${a.address}`,
      });
    }
  }
  pools.sort((a, b) => b.liquidity - a.liquidity);
  return { pools: pools.slice(0, 40) };
}

module.exports = async (req, res) => {
  const part = String((req.query && req.query.part) || "markets");
  const ttl = { markets: 60, global: 300, trending: 300, new: 120 }[part];
  if (!ttl) { res.status(400).json({ error: "Unknown part. Use markets, global, trending or new." }); return; }
  try {
    const n = Math.min(250, Math.max(10, parseInt((req.query && req.query.n) || "250", 10) || 250));
    let body = part === "markets" ? await markets(n) : part === "global" ? await global() : part === "trending" ? await trending() : await newPools();
    // Optional ?symbols=BTC,ETH filter for the markets list (used by the Portfolio page)
    const want = String((req.query && req.query.symbols) || "").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean);
    if (part === "markets" && want.length) body = { ...body, coins: body.coins.filter((c) => want.includes(c.symbol) || want.includes(String(c.id).toUpperCase())) };
    res.setHeader("Cache-Control", `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}`);
    res.status(200).json({ fetchedAt: Date.now(), ...body });
  } catch (e) {
    res.setHeader("Cache-Control", "public, s-maxage=15");
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
