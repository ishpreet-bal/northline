// Builds the news edition (data/current.json, data/days/, data/index.json, data/week.json) from public
// RSS feeds. No AI: headlines and short excerpts come from the outlets, with links to the full stories.
// Run: node scripts/news-refresh.js   (GitHub Actions runs it every 3 hours)
const fs = require("fs");
const path = require("path");
const L = require("./lib");

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-CA&gl=CA&ceid=CA:en`;
const FEEDS = {
  world: [["https://feeds.bbci.co.uk/news/world/rss.xml", "BBC News"], ["https://www.cbc.ca/webfeed/rss/rss-world", "CBC News"], ["https://feeds.npr.org/1004/rss.xml", "NPR"], ["https://www.theguardian.com/world/rss", "The Guardian"], ["https://www.aljazeera.com/xml/rss/all.xml", "Al Jazeera"]],
  us: [["https://feeds.npr.org/1001/rss.xml", "NPR"], ["https://feeds.npr.org/1014/rss.xml", "NPR"], ["https://www.pbs.org/newshour/feeds/rss/headlines", "PBS NewsHour"], ["https://thehill.com/homenews/feed/", "The Hill"], ["https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml", "BBC News"]],
  canada: [["https://www.cbc.ca/webfeed/rss/rss-canada", "CBC News"], ["https://www.cbc.ca/webfeed/rss/rss-politics", "CBC News"], ["https://www.cbc.ca/webfeed/rss/rss-business", "CBC News"], ["https://globalnews.ca/canada/feed/", "Global News"], ["https://globalnews.ca/politics/feed/", "Global News"]],
  ontario: [["https://www.cbc.ca/webfeed/rss/rss-canada-toronto", "CBC News"], ["https://globalnews.ca/toronto/feed/", "Global News"], ["https://toronto.citynews.ca/feed/", "CityNews"], [gnews("Toronto OR Ontario OR GTA"), "Google News"]],
};
const QUOTA = { ontario: 3, canada: 3, us: 3, world: 2 };
const TOTAL = 12;

const RX = {
  ontario: /\b(ontario|toronto|gta|york region|mississauga|brampton|markham|vaughan|richmond hill|hamilton|ottawa city|ttc|metrolinx|go transit|queen's park|doug ford|olivia chow|peel|durham|halton)\b/i,
  canada: /\b(canada|canadian|carney|poilievre|ottawa|parliament|bank of canada|macklem|statistics canada|statcan|rcmp|province|quebec|alberta|british columbia|manitoba|saskatchewan|nova scotia|new brunswick|loonie)\b/i,
  us: /\b(fed|wall street|trump|white house|congress|senate|house republicans|democrats|republicans|supreme court|u\.s\.|us |american|pentagon|federal reserve|midterm|governor|washington)\b/i,
};
const TOPICS = [
  [/election|vote|ballot|poll|campaign|midterm/i, "Elections"], [/tariff|trade|export|import|cusma|usmca/i, "Trade"],
  [/interest rate|bank of canada|federal reserve|inflation|economy|jobs|unemployment|gdp|recession/i, "Economy"],
  [/housing|rent|mortgage|home prices|condo/i, "Housing"], [/ttc|transit|subway|metrolinx|go train|highway|traffic|lrt/i, "Transit"],
  [/war|strike|missile|military|troops|ceasefire|attack|iran|israel|ukraine|russia|gaza/i, "Conflict"],
  [/oil|gas prices|energy|pipeline|hydro/i, "Energy"], [/court|judge|trial|lawsuit|ruling|charged|police|shooting|arrest/i, "Courts & crime"],
  [/hospital|health|doctor|virus|vaccine|measles/i, "Health"], [/school|teacher|university|college|student/i, "Education"],
  [/storm|snow|weather|flood|wildfire|heat/i, "Weather"], [/budget|deficit|tax|fiscal/i, "Budget"],
];
const HIGH = /\b(interest rate|rate hike|mortgage|tariff|inflation|gas prices|layoffs?|strike|war|ttc|transit|housing|tax|budget|deficit|election|recession|jobs)\b/i;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d) => { const [, m, dd] = d.split("-"); return `${MON[+m - 1]} ${+dd}`; };

const WORLDRX = /\b(iran|israel|ukraine|russia|china|gaza|lebanon|syria|europe|european|nato|united nations|india|pakistan|japan|korea|africa|mexico|brazil|britain|u\.k\.|france|germany)\b/i;
function regionOf(text, feedRegions) {
  if (RX.ontario.test(text)) return "ontario";
  if (RX.canada.test(text)) return "canada";
  if (WORLDRX.test(text)) return "world";
  if (RX.us.test(text)) return "us";
  const count = {}; for (const r of feedRegions) count[r] = (count[r] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
}

(async () => {
  const now = L.torontoParts();
  const nowMs = Date.now();
  const prev = L.readJSON("data/current.json", { stories: [] });

  // 1) Read all feeds
  const all = [];
  for (const [region, feeds] of Object.entries(FEEDS)) {
    const res = await Promise.all(feeds.map(([u, n]) => L.readFeed(u, n)));
    for (const it of res.flat()) if (!it.date || nowMs - it.date < 36 * 3600e3) all.push({ ...it, feedRegion: region });
  }
  if (all.length < 10) { console.error(`Only ${all.length} items from feeds; leaving the edition unchanged.`); process.exit(0); }

  // 2) Cluster the same story across outlets
  const clusters = [];
  for (const it of all.sort((a, b) => (b.date || 0) - (a.date || 0))) {
    if (/^(watch|listen|video|podcast|quiz|photos?)\b|live updates?:?$/i.test(it.title)) continue;
    const c = clusters.find((k) => L.similarity(k.items[0].title, it.title) > 0.5);
    if (c) { if (!c.items.some((x) => x.link === it.link)) c.items.push(it); } else clusters.push({ items: [it] });
  }
  for (const c of clusters) {
    const text = c.items.map((x) => x.title + " " + x.desc).join(" ");
    c.region = regionOf(c.items.map((x) => x.title).join(" ") + " " + (c.items[0].desc || ""), c.items.map((x) => x.feedRegion));
    c.outlets = [...new Set(c.items.map((x) => x.source))];
    c.latest = Math.max(...c.items.map((x) => x.date || nowMs - 12 * 3600e3));
    const ageH = (nowMs - c.latest) / 3600e3;
    c.high = HIGH.test(text);
    c.score = c.outlets.length * 3 + (ageH < 6 ? 2 : ageH < 12 ? 1 : 0) + (c.high ? 2 : 0);
    c.text = text;
  }
  clusters.sort((a, b) => b.score - a.score);

  // 3) Pick stories with regional quotas
  const chosen = [];
  for (const [r, n] of Object.entries(QUOTA)) clusters.filter((c) => c.region === r && !chosen.includes(c)).slice(0, n).forEach((c) => chosen.push(c));
  for (const c of clusters) { if (chosen.length >= TOTAL) break; if (!chosen.includes(c)) chosen.push(c); }
  chosen.sort((a, b) => b.score - a.score);

  // 4) Build stories, reusing ids (and backstory/timeline) from the previous edition when a story continues
  const days = fs.existsSync(path.join(L.ROOT, "data/days")) ? fs.readdirSync(path.join(L.ROOT, "data/days")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
  const usedIds = new Set();
  const stories = chosen.map((c, i) => {
    const lead = c.items.find((x) => x.desc && x.desc.length > 60) || c.items[0];
    const match = (prev.stories || []).find((s) => !usedIds.has(s.id) && L.similarity(s.headline, c.items[0].title) > 0.45);
    let id = match ? match.id : L.slug(c.items[0].title);
    while (usedIds.has(id)) id += "-2";
    usedIds.add(id);
    const changed = !match || c.latest > Date.parse(match.updatedAt || 0);
    const others = c.items.filter((x) => x !== lead && x.desc && x.desc.length > 40).slice(0, 2);
    const nowText = others.length ? others.map((x) => `${x.source}: ${L.excerpt(x.desc, 1, 220)}`).join(" ") : "";
    const topic = (TOPICS.find(([r]) => r.test(c.text)) || [null, { world: "World", us: "U.S.", canada: "Canada", ontario: "Ontario" }[c.region]])[1];
    // Timeline: earlier days this story id appeared in the daily archive
    const tl = [];
    for (const f of days.slice(-30)) {
      const d = L.readJSON(`data/days/${f}`, {});
      const s = (d.stories || []).find((x) => x.id === id);
      if (s && !tl.some((t) => t.event === s.headline)) tl.push({ date: md(f.slice(0, 10)), event: s.headline });
    }
    const story = {
      id, rank: i + 1, region: c.region, topic,
      status: !match ? "new" : changed ? "developing" : "ongoing",
      impactLevel: c.high ? "high" : c.outlets.length >= 3 ? "medium" : "low",
      updatedAt: changed ? L.isoToronto(c.latest) : match.updatedAt,
      headline: c.items[0].title,
      summary: L.excerpt(lead.desc, 2) || c.items[0].title,
      sources: c.items.slice(0, 4).map((x) => ({ title: `${x.source}: ${x.title.length > 80 ? x.title.slice(0, 77).replace(/\s+\S*$/, "") + "…" : x.title}`, url: x.link })),
    };
    if (nowText) story.now = nowText;
    if (match && match.backstory) story.backstory = match.backstory;
    if (tl.length >= 2) story.timeline = tl.slice(-6);
    return story;
  });

  // 5) Edition
  const t = new Date(nowMs), mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  const slot = 42 + 180 * Math.max(0, Math.ceil((mins - 41) / 180)); // runs at :42 every 3 hours (UTC)
  const next = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, slot));
  const np = L.torontoParts(next);
  const dates = [...L.readJSON("scripts/news-dates.json", []), ...(prev.keyDates || [])];
  const seen = new Set();
  const keyDates = dates.filter((k) => k.date >= now.date && !seen.has(k.date + k.label) && seen.add(k.date + k.label)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  const top = stories.slice(0, 3).map((s) => s.headline.replace(/[.\s]+$/, ""));
  const edition = {
    updatedAt: now.iso, nextRefresh: `around ${L.clock(np.hour, np.minute).replace(/:\d\d/, "")}`, generatedBy: "feeds (no AI)",
    headline: stories[0].headline,
    briefing: `Top stories right now: ${top.slice(0, -1).join("; ")}${top.length > 1 ? "; and " : ""}${top[top.length - 1]}.`,
    keyDates, stories,
  };
  L.writeJSON("data/current.json", edition);
  const { nextRefresh, ...dayEd } = edition;
  L.writeJSON(`data/days/${now.date}.json`, { ...dayEd, date: now.date });

  // 6) Archive index (prune >30 days)
  const cutoff = new Date(Date.parse(now.date + "T12:00:00Z") - 30 * 86400e3).toISOString().slice(0, 10);
  const files = fs.readdirSync(path.join(L.ROOT, "data/days")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files) if (f.slice(0, 10) < cutoff) fs.unlinkSync(path.join(L.ROOT, "data/days", f));
  const kept = files.filter((f) => f.slice(0, 10) >= cutoff).sort().reverse();
  L.writeJSON("data/index.json", { updatedAt: now.iso, days: kept.map((f) => ({ date: f.slice(0, 10), headline: (L.readJSON(`data/days/${f}`, {}).headline || "") })) });

  // 7) Week roundup: stories that showed up on the most days in the last 7
  const start = new Date(Date.parse(now.date + "T12:00:00Z") - 6 * 86400e3).toISOString().slice(0, 10);
  const agg = new Map();
  for (const f of kept.filter((f) => f.slice(0, 10) >= start).sort()) {
    const d = L.readJSON(`data/days/${f}`, {});
    for (const s of d.stories || []) {
      const a = agg.get(s.id) || { days: [], s };
      a.days.push(f.slice(0, 10)); a.s = s; agg.set(s.id, a);
    }
  }
  const lvl = { high: 3, medium: 2, low: 1 };
  const ranked = [...agg.values()].sort((a, b) => (b.days.length * 2 + lvl[b.s.impactLevel || "low"]) - (a.days.length * 2 + lvl[a.s.impactLevel || "low"])).slice(0, 8);
  const week = {
    updatedAt: now.iso, rangeStart: start, rangeEnd: now.date,
    headline: ranked[0] ? ranked[0].s.headline : stories[0].headline,
    summary: `The stories that stayed in the briefing most this week: ${ranked.slice(0, 3).map((a) => a.s.headline.replace(/[.\s]+$/, "")).join("; ")}.`,
    top: ranked.map((a, i) => ({
      rank: i + 1, id: a.s.id, region: a.s.region,
      when: a.days.length >= 6 ? "All week" : a.days.length === 1 ? md(a.days[0]) : (a.days[0].slice(5, 7) === a.days[a.days.length - 1].slice(5, 7) ? `${md(a.days[0])}–${+a.days[a.days.length - 1].slice(8)}` : `${md(a.days[0])}–${md(a.days[a.days.length - 1])}`),
      impactLevel: a.s.impactLevel || "low", latestDate: a.days[a.days.length - 1],
      headline: a.s.headline, what: a.s.summary || "", why: `In the briefing on ${a.days.length} of the last 7 days.`,
    })),
  };
  L.writeJSON("data/week.json", week);
  console.log(`edition: ${stories.length} stories (${Object.keys(QUOTA).map((r) => r + " " + stories.filter((s) => s.region === r).length).join(", ")}), ${keyDates.length} key dates, ${kept.length} archived days`);
})().catch((e) => { console.error(e); process.exit(1); });
