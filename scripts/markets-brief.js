// Builds data/markets.json from live prices and news feeds. No AI: text is assembled from
// numbers and from headlines/excerpts in public RSS feeds, with links to the original articles.
// Run: node scripts/markets-brief.js   (GitHub Actions runs it hourly)
const L = require("./lib");
const cryptoApi = require("../api/crypto.js");
const stocksApi = require("../api/stocks.js");

// Call the site's own API functions directly (no HTTP, no Vercel protection to get past).
function callApi(handler, query) {
  return new Promise((resolve, reject) => {
    const res = { headers: {}, code: 200, setHeader() {}, status(c) { this.code = c; return this; },
      json(b) { this.code < 400 ? resolve(b) : reject(new Error(b && b.error || `status ${this.code}`)); } };
    Promise.resolve(handler({ query }, res)).catch(reject);
  });
}

const CRYPTO_FEEDS = [
  ["https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"],
  ["https://cointelegraph.com/rss", "Cointelegraph"],
  ["https://decrypt.co/feed", "Decrypt"],
  ["https://www.theblock.co/rss.xml", "The Block"],
];
const MARKET_FEEDS = [
  ["https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", "CNBC"],
  ["https://finance.yahoo.com/news/rssindex", "Yahoo Finance"],
  ["https://www.cbc.ca/webfeed/rss/rss-business", "CBC News"],
  ["https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/", "Globe and Mail"],
];
const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-CA&gl=CA&ceid=CA:en`;
const yfeed = (s) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`;

// ---------- formatting ----------
const abs = Math.abs;
function num(x, d) { return Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function usd(p, cur = "USD") {
  if (p == null || !isFinite(p)) return "n/a";
  const sym = cur === "CAD" ? "C$" : "$";
  if (p >= 1000) return sym + num(p, 0);
  if (p >= 1) return sym + num(p, 2);
  if (p >= 0.01) return sym + num(p, 4);
  return sym + Number(p.toPrecision(3)).toString();
}
const pc = (x, d = 1) => `${num(abs(x), d)}%`;
const dir = (x) => (x >= 0 ? "Up" : "Down");
const dirl = (x) => (x >= 0 ? "up" : "down");
const signed = (x, d = 1) => `${x >= 0 ? "+" : "−"}${num(abs(x), d)}%`;
const big = (x) => x >= 1e12 ? `$${num(x / 1e12, 2)} trillion` : x >= 1e9 ? `$${num(x / 1e9, 1)} billion` : `$${num(x / 1e6, 0)} million`;

const BULL = /\b(rall(y|ies|ied)|surg|soar|jump|gain|climb|rebound|record high|beats?|upgrade|inflows?|rises?|rose|higher|boost)/i;
const BEAR = /\b(fall|fell|drop|slump|plunge|tumble|sink|slide|crash|loss|miss|downgrade|outflows?|cut|lower|hack|exploit|sell-?off|fears?|war|strike|tariff)/i;
const effectOf = (t) => { const b = BULL.test(t), r = BEAR.test(t); return b && !r ? "bullish" : r && !b ? "bearish" : "mixed"; };
const ASSET_WORDS = [
  [/bitcoin|btc\b/i, "Bitcoin"], [/ether(eum)?\b|eth\b/i, "Ether"], [/crypto|token|stablecoin|altcoin/i, "Crypto"],
  [/nvidia|chip|semiconductor|ai\b|artificial intelligence/i, "Tech and chip stocks"], [/oil|crude|opec|brent/i, "Oil, energy stocks"],
  [/gold/i, "Gold, miners"], [/fed\b|federal reserve|powell|warsh|treasur|yield|bond/i, "Bonds, interest rates"],
  [/bank of canada|loonie|canadian dollar|tsx/i, "TSX, loonie"], [/tariff|trade/i, "Trade-exposed stocks"], [/bank/i, "Banks"],
  [/s&p|nasdaq|dow|wall street|stocks/i, "U.S. stocks"],
];
const assetsOf = (t) => [...new Set(ASSET_WORDS.filter(([r]) => r.test(t)).map(([, n]) => n))].slice(0, 3).join(", ") || "Broad market";

const HOURS = 3600e3;
function recent(items, maxAgeH) { const now = Date.now(); return items.filter((i) => !i.date || now - i.date < maxAgeH * HOURS).sort((a, b) => (b.date || 0) - (a.date || 0)); }
function dedupe(items) { const out = []; for (const i of items) if (!out.some((o) => L.similarity(o.title, i.title) > 0.6)) out.push(i); return out; }
const srcOf = (i) => ({ title: `${i.source}: ${i.title.length > 80 ? i.title.slice(0, 77).replace(/\s+\S*$/, "") + "…" : i.title}`, url: i.link });

const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const JUNK = /^(BC-|“|")|\?$|price prediction|how to buy|^convert \d|price today|live chart|market report 20\d\d|\b(i'm|my wife|my husband)\b/i;
function relevant(items, terms) {
  const rx = new RegExp(`\\b(${terms.filter(Boolean).map(esc).join("|")})\\b`, "i");
  return items.filter((i) => !JUNK.test(i.title) && rx.test(i.title));
}
const GENERIC = /^(canadian|the|american|first|general|united|royal|national|bank|advanced)$/i;
function nameTerms(name) {
  const w = String(name).replace(/,?\s+(inc\.?|corporation|corp\.?|limited|ltd\.?|plc|co\.?|company|holdings|group)$/i, "").replace(/[.,]/g, "").split(/\s+/);
  return [GENERIC.test(w[0]) && w[1] ? w.slice(0, 2).join(" ") : w[0], w.join(" ")];
}

function coverage(news) {
  if (!news.length) return "";
  return "Recent coverage: " + news.slice(0, 3).map((n) => `“${n.title}” (${n.source})`).join("; ") + ".";
}

// ---------- crypto ----------
function isStable(c) { return (c.price > 0.97 && c.price < 1.03 && abs(c.ch7d || 0) < 1.5) || /usd|eur/i.test(c.symbol) && abs(c.ch24h || 0) < 1; }
function isWrapped(c) { return /wrapped|bridged|staked|liquid staked|restaked/i.test(c.name) || /^(w|st|ws|we|cb|jito|r)(btc|eth|sol)$/i.test(c.symbol); }

async function cryptoCard(c, btc) {
  const q = c.id === "bitcoin" ? "bitcoin price" : c.id === "ethereum" ? "ether OR ethereum price" : `"${c.name}" crypto`;
  const terms = [c.name, c.symbol.length >= 3 ? c.symbol : null, c.id === "ethereum" ? "ether" : null, c.id === "bitcoin" ? "BTC" : null];
  const news = dedupe(relevant(recent(await L.readFeed(gnews(q), "Google News"), 36), terms)).slice(0, 3);
  const move = `${dir(c.ch24h)} ${pc(c.ch24h)} in 24h and ${dirl(c.ch7d)} ${pc(c.ch7d)} this week, at about ${usd(c.price)} (${dirl(c.ch30d)} ${pc(c.ch30d, 0)} over 30 days)`;
  let why = coverage(news);
  if (c.id !== "bitcoin" && btc) {
    const diff = (c.ch24h || 0) - (btc.ch24h || 0);
    why += (why ? " " : "") + (abs(diff) < 2
      ? `Bitcoin moved ${signed(btc.ch24h)} over the same 24 hours, so this looks like a market-wide move rather than coin-specific news.`
      : `That is ${num(abs(diff), 1)} points ${diff > 0 ? "better" : "worse"} than bitcoin (${signed(btc.ch24h)}), so something specific to this coin is likely driving it.`);
  }
  if (!news.length) why = "No specific headlines turned up in our news feeds over the past day. " + why;
  const athGap = c.ath ? (c.price / c.ath - 1) * 100 : null;
  let meaning = `It is ${athGap != null ? `${pc(athGap, 0)} below its all-time high of ${usd(c.ath)}` : "well off its highs"} and has a market value of about ${big(c.mcap)}.`;
  meaning += abs(c.ch24h) >= 10 ? " Moves this big in a day are often partly reversed, so expect large swings either way." : abs(c.ch30d) >= 15 ? ` The ${c.ch30d > 0 ? "uptrend" : "downtrend"} over the past month is the bigger picture to keep in mind.` : " Price action has been fairly contained for a crypto asset.";
  const p7 = c.price / (1 + (c.ch7d || 0) / 100), p30 = c.price / (1 + (c.ch30d || 0) / 100);
  const above = [p7, p30, c.ath].filter((x) => x && x > c.price * 1.005).sort((a, b) => a - b)[0];
  const below = [p7, p30].filter((x) => x && x < c.price * 0.995).sort((a, b) => b - a)[0];
  const outlook = {
    lean: abs(c.ch7d || 0) < 3 ? "sideways" : "unclear", confidence: "low", horizon: "next few days",
    bullCase: `Breaking above the 24-hour high of about ${usd(c.high24)} would show buyers in control${above ? `; the next reference is about ${usd(above)}, where it traded ${above === c.ath ? "at its record" : above === p7 ? "a week ago" : "a month ago"}` : ""}.`,
    bearCase: `Falling below the 24-hour low of about ${usd(c.low24)} would point to more selling${below ? `; about ${usd(below)}, where it traded ${below === p7 ? "a week ago" : "a month ago"}, is the next reference` : ""}.`,
    watch: c.id === "bitcoin" || c.id === "ethereum" ? "Daily ETF flows, the Fed and U.S. bond yields, and whether price holds its 24-hour range." : `Whether it holds between ${usd(c.low24)} and ${usd(c.high24)}, trading volume, and bitcoin's direction.`,
  };
  return { id: c.id, symbol: c.symbol, name: c.name, move, why, meaning, outlook,
    sources: [...news.map(srcOf), { title: `CoinGecko: ${c.name} price and data`, url: `https://www.coingecko.com/en/coins/${c.id}` }].slice(0, 4) };
}

// ---------- stocks ----------
const INDEX = new Set(["^GSPC", "^IXIC", "^DJI", "^GSPTSE"]);
const NICE = { "^GSPC": "S&P 500", "^IXIC": "Nasdaq Composite", "^DJI": "Dow Jones", "^GSPTSE": "S&P/TSX Composite", "CL=F": "U.S. crude oil (WTI)", "GC=F": "Gold" };
async function stockCard(q) {
  const isIdx = INDEX.has(q.symbol);
  let news = recent(await L.readFeed(yfeed(q.symbol), "Yahoo Finance"), 36);
  if (news.length < 2) news = news.concat(recent(await L.readFeed(gnews(`${NICE[q.symbol] || q.name} ${isIdx ? "" : "stock"}`), "Google News"), 36));
  const terms = isIdx ? ["stocks?", "S&P", "Nasdaq", "Dow", "TSX", "Wall Street", "markets?", "index"] : q.symbol === "CL=F" ? ["oil", "crude", "OPEC", "Brent", "WTI"] : [...nameTerms(q.name), q.symbol.replace(/\.TO$/, "")];
  news = dedupe(news.filter((i) => !JUNK.test(i.title) && new RegExp(`\\b(${terms.join("|")})\\b`, "i").test(i.title))).slice(0, 3);
  const when = q.state === "open" ? "today" : q.state === "pre-market" ? "at the last close (pre-market)" : "at the last close";
  const lvl = isIdx ? num(q.price, 0) : usd(q.price, q.currency);
  const pts = isIdx && q.change != null ? ` (${num(abs(q.change), 0)} points)` : "";
  const hi = q.high52 ? (q.price / q.high52 - 1) * 100 : null;
  const move = `${dir(q.changePct)} ${pc(q.changePct, 2)}${pts} ${when}, at about ${lvl}${hi != null ? `; ${hi > -0.5 ? "near its 52-week high" : `${pc(hi)} below its 52-week high`}` : ""}`;
  let why = coverage(news);
  if (!news.length) why = "No specific headlines turned up in our news feeds over the past day; the move may simply reflect the broader market.";
  const closes = (q.closes || []).filter((x) => x != null);
  const m1 = closes.length > 22 ? (q.price / closes[closes.length - 22] - 1) * 100 : null;
  const m6 = closes.length > 100 ? (q.price / closes[0] - 1) * 100 : null;
  let meaning = m1 != null ? `Over the past month it is ${dirl(m1)} about ${pc(m1)}${m6 != null ? `, and ${dirl(m6)} about ${pc(m6, 0)} over six months` : ""}.` : "";
  if (q.low52 && q.high52) meaning += ` Its 52-week range is ${isIdx ? num(q.low52, 0) : usd(q.low52, q.currency)} to ${isIdx ? num(q.high52, 0) : usd(q.high52, q.currency)}.`;
  const fmt = (x) => (isIdx ? num(x, 0) : usd(x, q.currency));
  const outlook = {
    lean: m1 != null && abs(m1) < 2 ? "sideways" : "unclear", confidence: "low", horizon: "next few days",
    bullCase: q.dayHigh ? `Closing above today's high of about ${fmt(q.dayHigh)} would extend the move${q.high52 && q.high52 > q.price * 1.01 ? `; the 52-week high near ${fmt(q.high52)} is the bigger test` : ""}.` : "A close above recent highs would signal buyers are in control.",
    bearCase: q.dayLow ? `Closing below today's low of about ${fmt(q.dayLow)} would suggest more selling${m1 != null && closes.length > 22 ? `; about ${fmt(closes[closes.length - 22])}, where it was a month ago, is a reference` : ""}.` : "A close below recent lows would signal more selling.",
    watch: isIdx ? "Big-tech earnings, the Fed and bond yields, oil prices, and economic data releases." : "Company news and earnings dates, analyst rating changes, and the direction of the broader index.",
  };
  return { symbol: q.symbol, name: NICE[q.symbol] || q.name, move, why, meaning: meaning.trim(), outlook,
    sources: [...news.map(srcOf), { title: `Yahoo Finance: ${q.symbol} quote`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(q.symbol)}` }].slice(0, 4) };
}

// ---------- main ----------
(async () => {
  const now = L.torontoParts();
  const prev = L.readJSON("data/markets.json", {});
  const [mk, gl, tr, st] = await Promise.all([
    callApi(cryptoApi, { part: "markets", n: "100" }).catch((e) => (console.warn("crypto markets", e.message), null)),
    callApi(cryptoApi, { part: "global" }).catch((e) => (console.warn("crypto global", e.message), null)),
    callApi(cryptoApi, { part: "trending" }).catch((e) => (console.warn("crypto trending", e.message), null)),
    callApi(stocksApi, {}).catch((e) => (console.warn("stocks", e.message), null)),
  ]);
  if (!mk && !st) { console.error("All price feeds failed; leaving markets.json unchanged."); process.exit(0); }

  const coins = (mk && mk.coins || []).filter((c) => c.price != null && c.ch24h != null);
  const by = Object.fromEntries(coins.map((c) => [c.id, c]));
  const btc = by.bitcoin, eth = by.ethereum;
  const quotes = (st && st.quotes || []).filter((q) => !q.error && q.price != null);
  const Q = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
  const fg = gl && gl.fearGreed && gl.fearGreed[0];

  // Crypto picks: BTC, ETH, biggest movers, trending coins in the top 100.
  const pool = coins.filter((c) => !isStable(c) && !isWrapped(c));
  const picks = [btc, eth].filter(Boolean);
  const add = (c) => { if (c && !picks.includes(c) && picks.length < 9) picks.push(c); };
  [...pool].sort((a, b) => abs(b.ch24h) - abs(a.ch24h)).slice(0, 4).forEach(add);
  (tr && tr.coins || []).filter((t) => by[t.id]).slice(0, 3).forEach((t) => add(by[t.id]));
  [...pool].sort((a, b) => abs(b.ch7d || 0) - abs(a.ch7d || 0)).forEach(add);
  const crypto = [];
  for (const c of picks) crypto.push(await cryptoCard(c, btc));

  // Stock picks: three indexes, oil, two Canadian names, then the biggest movers.
  const sp = ["^GSPC", "^IXIC", "^GSPTSE", "CL=F"].map((s) => Q[s]).filter(Boolean);
  const eq = quotes.filter((q) => q.type === "EQUITY" || q.type === "ETF");
  eq.filter((q) => /\.TO$/.test(q.symbol)).sort((a, b) => abs(b.changePct) - abs(a.changePct)).slice(0, 2).forEach((q) => sp.push(q));
  eq.filter((q) => !sp.includes(q)).sort((a, b) => abs(b.changePct) - abs(a.changePct)).slice(0, 4).forEach((q) => sp.push(q));
  const stocks = [];
  for (const q of sp) stocks.push(await stockCard(q));

  // Drivers: the most-covered recent market headlines.
  const feeds = await Promise.all([...CRYPTO_FEEDS, ...MARKET_FEEDS].map(([u, n]) => L.readFeed(u, n)));
  const items = recent(feeds.flat(), 14).filter((i) => !JUNK.test(i.title) && (assetsOf(i.title + " " + i.desc) !== "Broad market" || /\b(stocks?|markets?|economy|earnings|shares)\b/i.test(i.title)));
  const clusters = [];
  for (const i of items) { const c = clusters.find((k) => L.similarity(k[0].title, i.title) > 0.5); c ? c.push(i) : clusters.push([i]); }
  clusters.sort((a, b) => new Set(b.map((x) => x.source)).size - new Set(a.map((x) => x.source)).size || (b[0].date || 0) - (a[0].date || 0));
  const drivers = clusters.slice(0, 5).map((k) => {
    const lead = k.find((x) => x.desc && x.desc.length > 40) || k[0];
    const outlets = [...new Set(k.map((x) => x.source))];
    const detail = (L.excerpt(lead.desc, 2) || lead.title) + ` (${outlets.slice(0, 3).join(", ")}${outlets.length > 1 ? " are covering it" : ""}.)`;
    return { title: k[0].title, detail, effect: effectOf(k.map((x) => x.title).join(" ")), assets: assetsOf(k.map((x) => x.title + " " + x.desc).join(" ")), link: lead.link };
  });

  // New and notable coins: trending coins outside the top 100.
  const newCoins = [];
  for (const t of (tr && tr.coins || []).filter((t) => !by[t.id]).slice(0, 4)) {
    const news = dedupe(relevant(recent(await L.readFeed(gnews(`"${t.name}" crypto`), "Google News"), 72), [t.name, t.symbol.length >= 3 ? t.symbol : null])).slice(0, 2);
    const mcap = typeof t.mcap === "string" ? t.mcap : t.mcap ? big(t.mcap) : null;
    newCoins.push({
      name: t.name, symbol: t.symbol,
      what: `${t.name} (${t.symbol}) is ${t.rank ? `ranked #${t.rank} by market value` : "unranked by market value"}${mcap ? ` (about ${mcap})` : ""} and is one of the most-searched coins on CoinGecko right now.`,
      why: news.length ? coverage(news) : `It is trending on CoinGecko${t.ch24h != null ? ` after moving ${signed(t.ch24h)} in 24 hours` : ""}; we found no specific headlines in our feeds.`,
      risk: !t.rank || t.rank > 300 ? "very high" : "high",
      redFlags: [t.rank && t.rank > 300 || !t.rank ? "Small market value, so a few large trades can swing the price" : "Smaller than the top 100, so liquidity is thinner",
        t.ch24h != null && abs(t.ch24h) > 15 ? `a ${pc(t.ch24h, 0)} move in a day shows extreme volatility` : null,
        "check who holds the supply and upcoming token unlocks before trusting the price"].filter(Boolean).join("; ") + ".",
      sources: [...news.map(srcOf), { title: `CoinGecko: ${t.name}`, url: `https://www.coingecko.com/en/coins/${t.id}` }],
    });
  }

  // Calendar: hand-kept list plus earlier entries, upcoming only.
  const cal = L.readJSON("scripts/market-calendar.json", []); // edit this file to add events
  const seen = new Set();
  const calendar = cal.filter((e) => e.date >= now.date && !seen.has(e.date + e.label) && seen.add(e.date + e.label)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);

  // Mood, headline and summary from the numbers.
  const spx = Q["^GSPC"], ndq = Q["^IXIC"], tsx = Q["^GSPTSE"], oil = Q["CL=F"], vix = Q["^VIX"], tnx = Q["^TNX"], cad = Q["CADUSD=X"], gold = Q["GC=F"];
  const cLabel = !btc ? "Mixed" : fg && fg.value >= 75 ? "Euphoric" : fg && fg.value <= 25 ? "Fearful" : btc.ch24h > 3 ? "Risk-on" : btc.ch24h < -3 ? "Risk-off" : "Cautious";
  const sLabel = !spx ? "Mixed" : vix && vix.price >= 28 ? "Fearful" : spx.changePct > 0.75 ? "Risk-on" : spx.changePct < -0.75 ? "Risk-off" : "Mixed";
  const mood = {
    crypto: { label: cLabel, why: btc ? `Bitcoin is ${dirl(btc.ch24h)} ${pc(btc.ch24h)} over 24 hours and ${dirl(btc.ch7d)} ${pc(btc.ch7d)} this week${fg ? `, and the Fear & Greed index reads ${fg.value} (${fg.label})` : ""}.` : "Crypto prices were unavailable this hour." },
    stocks: { label: sLabel, why: spx ? `The S&P 500 is ${dirl(spx.changePct)} ${pc(spx.changePct, 2)}${vix ? `, the VIX volatility gauge is ${num(vix.price, 1)}` : ""}${tnx ? ` and the 10-year Treasury yield is ${num(tnx.price, 2)}%` : ""}.` : "Stock prices were unavailable this hour." },
  };
  const bits = [];
  if (btc) bits.push(`Bitcoin ${usd(btc.price)} (${signed(btc.ch24h)})`);
  if (spx) bits.push(`S&P 500 ${signed(spx.changePct, 2)}`);
  if (tsx) bits.push(`TSX ${signed(tsx.changePct, 2)}`);
  if (oil) bits.push(`oil ${usd(oil.price)}`);
  const headline = bits.join(" · ");
  const s1 = [spx && `the S&P 500 is ${dirl(spx.changePct)} ${pc(spx.changePct, 2)} at about ${num(spx.price, 0)}`, ndq && `the Nasdaq ${dirl(ndq.changePct)} ${pc(ndq.changePct, 2)}`, tsx && `the TSX ${dirl(tsx.changePct)} ${pc(tsx.changePct, 2)} at about ${num(tsx.price, 0)}`].filter(Boolean);
  const s2 = [oil && `U.S. crude is ${usd(oil.price)} (${signed(oil.changePct)})`, gold && `gold ${usd(gold.price)}`, tnx && `the 10-year yield ${num(tnx.price, 2)}%`, cad && `the loonie ${num(cad.price * 100, 2)} U.S. cents`].filter(Boolean);
  const s3 = btc ? `Bitcoin is about ${usd(btc.price)} (${signed(btc.ch24h)} over 24 hours, ${signed(btc.ch7d)} this week)${eth ? `, ether about ${usd(eth.price)} (${signed(eth.ch24h)})` : ""}${gl && gl.totalMcap ? `, and all crypto together is worth about ${big(gl.totalMcap)}` : ""}${fg ? `; Fear & Greed is ${fg.value} (${fg.label})` : ""}.` : "";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const summary = [s1.length ? cap(s1.join(", ")) + (spx && spx.state !== "open" ? " (last close)." : ".") : "", s2.length ? cap(s2.join(", ")) + "." : "", s3].filter(Boolean).join(" ");

  const nh = (now.hour + (now.minute >= 22 ? 1 : 0)) % 24;
  const out = {
    updatedAt: now.iso, nextRefresh: `around ${L.clock(nh, 22)}`, generatedBy: "feeds (no AI)",
    headline, summary, mood,
    drivers: drivers.length ? drivers.map(({ link, ...d }) => d) : (prev.drivers || []),
    crypto: crypto.length ? crypto : (prev.crypto || []),
    stocks: stocks.length ? stocks : (prev.stocks || []),
    newCoins: newCoins.length ? newCoins : (prev.newCoins || []),
    calendar,
  };
  L.writeJSON("data/markets.json", out);
  console.log(`markets.json: ${out.crypto.length} coins, ${out.stocks.length} stocks, ${out.drivers.length} drivers, ${out.newCoins.length} new coins, ${out.calendar.length} events`);
})().catch((e) => { console.error(e); process.exit(1); });
