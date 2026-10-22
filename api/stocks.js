// Live stock, index, commodity and FX quotes for the Markets page (Yahoo Finance, with a Stooq fallback for U.S. tickers).
// GET /api/stocks?symbols=AAPL,^GSPC,SHOP.TO
const HEADERS = { accept: "application/json,text/csv,*/*", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const VALID = /^[A-Za-z0-9.^=\-]{1,15}$/;
const DEFAULTS = ["^GSPC","^IXIC","^DJI","^GSPTSE","^VIX","CL=F","GC=F","^TNX","CADUSD=X","AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","AVGO","JPM","SHOP.TO","RY.TO","TD.TO","ENB.TO","CNQ.TO","COIN","MSTR","IBIT"];

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { headers: HEADERS, signal: ctl.signal }); } finally { clearTimeout(timer); }
}
const r4 = (x) => (typeof x === "number" && isFinite(x) ? Number(x.toPrecision(8)) : null);

function marketState(meta, now) {
  const p = meta.currentTradingPeriod || {};
  const inP = (x) => x && now >= x.start && now < x.end;
  if (inP(p.regular)) return "open";
  if (inP(p.pre)) return "pre-market";
  if (inP(p.post)) return "after-hours";
  return "closed";
}

async function yahoo(sym) {
  let lastErr;
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetchWithTimeout(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d&includePrePost=false`);
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      const d = await r.json();
      const res = d.chart && d.chart.result && d.chart.result[0];
      if (!res) throw new Error((d.chart && d.chart.error && d.chart.error.description) || "No data");
      const m = res.meta || {};
      const ts = res.timestamp || [];
      const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
      const bars = [];
      for (let i = 0; i < ts.length; i++) if (q.close && q.close[i] != null) bars.push([ts[i], q.close[i]]);
      const price = m.regularMarketPrice ?? (bars.length ? bars[bars.length - 1][1] : null);
      const off = m.gmtoffset || 0;
      const day = (t) => Math.floor((t + off) / 86400);
      let prev = null;
      if (bars.length) {
        const last = bars[bars.length - 1];
        prev = m.regularMarketTime && day(last[0]) === day(m.regularMarketTime) ? (bars[bars.length - 2] || [])[1] : last[1];
      }
      if (prev == null) prev = m.previousClose ?? null;
      const now = Math.floor(Date.now() / 1000);
      return {
        symbol: sym, name: m.longName || m.shortName || sym, currency: m.currency, exchange: m.fullExchangeName || m.exchangeName,
        type: m.instrumentType, price: r4(price), prevClose: r4(prev),
        change: price != null && prev ? r4(price - prev) : null, changePct: price != null && prev ? r4((price / prev - 1) * 100) : null,
        dayHigh: r4(m.regularMarketDayHigh), dayLow: r4(m.regularMarketDayLow), high52: r4(m.fiftyTwoWeekHigh), low52: r4(m.fiftyTwoWeekLow),
        volume: m.regularMarketVolume, time: m.regularMarketTime, state: marketState(m, now), source: "Yahoo Finance",
        closes: bars.slice(-130).map((b) => r4(b[1])),
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const STOOQ = { "^GSPC": "^spx", "^DJI": "^dji", "^IXIC": "^ndq" };
async function stooq(sym) {
  const code = STOOQ[sym] || (/^[A-Z]{1,5}$/.test(sym) ? sym.toLowerCase() + ".us" : null);
  if (!code) throw new Error("No fallback for " + sym);
  const r = await fetchWithTimeout(`https://stooq.com/q/d/l/?s=${encodeURIComponent(code)}&i=d`);
  if (!r.ok) throw new Error("Stooq " + r.status);
  const rows = (await r.text()).trim().split("\n").slice(1).map((l) => l.split(",")).filter((c) => c.length >= 5 && !isNaN(+c[4]));
  if (rows.length < 2) throw new Error("Stooq: no data");
  const closes = rows.slice(-130).map((c) => +c[4]);
  const price = closes[closes.length - 1], prev = closes[closes.length - 2];
  return { symbol: sym, name: sym, price: r4(price), prevClose: r4(prev), change: r4(price - prev), changePct: r4((price / prev - 1) * 100),
    closes, state: "delayed", source: "Stooq (delayed)", time: Math.floor(Date.parse(rows[rows.length - 1][0]) / 1000) };
}

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.symbols) || "");
  let symbols = raw ? raw.split(",").map((s) => s.trim()).filter((s) => VALID.test(s)) : DEFAULTS;
  symbols = [...new Set(symbols)].slice(0, 45);
  const out = await Promise.all(symbols.map(async (s) => {
    try { return await yahoo(s); } catch (e1) {
      try { return await stooq(s); } catch (e2) { return { symbol: s, error: String(e1 && e1.message || e1) }; }
    }
  }));
  const ok = out.filter((x) => !x.error).length;
  res.setHeader("Cache-Control", ok ? "public, s-maxage=60, stale-while-revalidate=300" : "public, s-maxage=15");
  res.status(ok ? 200 : 502).json({ fetchedAt: Date.now(), quotes: out });
};
