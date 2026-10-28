// Shared helpers for the no-AI refresh scripts (run by GitHub Actions, not Claude).
// No dependencies: Node 20+ has fetch built in.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const UA = "Mozilla/5.0 (compatible; NorthlineBriefing/1.0; +https://github.com/ishpreet-bal/northline)";

async function fetchText(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml,application/xml,text/xml,*/*" }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
function decode(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] ?? m));
}
function clean(s) {
  let x = String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  x = decode(x); // entity-encoded HTML becomes real tags, then strip them
  x = x.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return decode(x).replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// Parse RSS 2.0 or Atom into [{title, link, desc, date, source}]
function parseFeed(xml, sourceName) {
  const out = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const it of items) {
    let title = clean(tag(it, "title"));
    let link = clean(tag(it, "link"));
    if (!link) { const m = it.match(/<link[^>]*href="([^"]+)"/i); if (m) link = decode(m[1]); }
    const desc = clean(tag(it, "description") || tag(it, "summary") || tag(it, "content"));
    const ds = clean(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated") || tag(it, "dc:date"));
    const date = ds ? Date.parse(ds) : NaN;
    let source = sourceName;
    const src = clean(tag(it, "source"));
    if (src) source = src;
    // Google News titles end with " - Outlet"
    if (/news\.google\./.test(link) && / - [^-]+$/.test(title)) { const i = title.lastIndexOf(" - "); source = title.slice(i + 3); title = title.slice(0, i); }
    // Google News descriptions only repeat the headline, so drop them
    const d = /news\.google\./.test(link) ? "" : desc;
    if (title && link) out.push({ title, link, desc: d, date: isNaN(date) ? null : date, source });
  }
  return out;
}

async function readFeed(url, sourceName) {
  try { return parseFeed(await fetchText(url), sourceName); }
  catch (e) { console.warn(`feed failed: ${sourceName} ${url} (${e.message})`); return []; }
}

// First n sentences, capped in length, so we show a short excerpt rather than copying articles.
function excerpt(s, n = 2, max = 320) {
  const t = String(s || "").replace(/\s*(Continue reading|Read more|The post .* appeared first on .*)[\s\S]*$/i, "").trim();
  // Split on sentence ends, but not after initials or common abbreviations (U.S., Mr., Oct.) or inside numbers (2.5%).
  const parts = t.split(/(?<!\b(?:[A-Z]|U\.S|U\.K|Mr|Mrs|Ms|Dr|St|Jr|Inc|Ltd|Co|Corp|vs|No|Gov|Sen|Rep|Gen|Lt|Col|Jan|Feb|Mar|Apr|Aug|Sept?|Oct|Nov|Dec))([.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/);
  const sentences = [];
  for (let i = 0; i < parts.length; i += 2) sentences.push(parts[i] + (parts[i + 1] || ""));
  let x = sentences.slice(0, n).join(" ").trim();
  if (x.length > max) x = x.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return x;
}

const STOP = new Set("a an the and or of to in on for at by with from as is are was were be been it its this that after over into amid says said say new will could would can may up down about than more most out off but not no how why what who when where his her their they he she we you your our has have had do does did just".split(" "));
function words(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9$%. ]+/g, " ").split(/\s+/).map(w => w.replace(/\.$/, "")).filter(w => w.length > 2 && !STOP.has(w)); }
function similarity(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
function shared(a, b) { const A = new Set(words(a)); return [...new Set(words(b))].filter((w) => A.has(w)).length; }
function slug(s, n = 6) { return words(s).slice(0, n).join("-").replace(/[^a-z0-9-]/g, "").slice(0, 60) || "story"; }

// Toronto time helpers
const TZ = "America/Toronto";
function torontoParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "longOffset" });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const off = (p.timeZoneName || "GMT-05:00").replace("GMT", "") || "+00:00";
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, iso: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${off}`, hour: +hour, minute: +p.minute };
}
function isoToronto(ms) { return torontoParts(new Date(ms)).iso; }
function clock(h, m) { const ap = h >= 12 ? "PM" : "AM"; const hh = h % 12 || 12; return `${hh}:${String(m).padStart(2, "0")} ${ap}`; }

function readJSON(rel, fallback = null) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch { return fallback; } }
function writeJSON(rel, obj) { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }

module.exports = { ROOT, fetchText, readFeed, parseFeed, clean, excerpt, words, similarity, shared, slug, torontoParts, isoToronto, clock, readJSON, writeJSON };
