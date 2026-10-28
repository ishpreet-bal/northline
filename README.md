# Northline Briefing

A self-refreshing news briefing for world, U.S., Canada and Ontario news. Every story comes with what's happening now, how we got here, a timeline of the past year, why it matters, and what it means for someone living in Ontario.

## How it works

- `index.html` is the whole site. It has no build step and no dependencies.
- `data/` holds the news, as plain JSON:
  - `current.json` is the latest edition.
  - `days/YYYY-MM-DD.json` is the last edition of each day. The page uses these for **Yesterday** and older days.
  - `week.json` lists the biggest stories of the past seven days for **Past week**.
  - `index.json` lists which days are saved, with each day's headline.
- A GitHub Action (`.github/workflows/news-refresh.yml`) runs `scripts/news-refresh.js` every 3 hours. It reads public RSS feeds (CBC, Global News, CityNews, BBC, NPR, PBS, The Hill, The Guardian, Al Jazeera, Google News), groups the same story across outlets, and writes these files with headlines, short excerpts and links. No AI is involved, so it doesn't use any Claude usage. Vercel redeploys on every push, and open pages check for a new edition every 5 minutes.
- Upcoming key dates come from `scripts/news-dates.json`. Edit that file to add or change them.

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import `ishpreet-bal/northline`.
2. Leave **Framework Preset** on **Other**. No build command or output directory is needed.
3. Deploy.

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't load the data, because browsers block `fetch` on `file://` pages.

## Source files

- `src/northline-claude.html` is the news page as published in Claude (no `<html>`/`<head>` wrapper). Edit this one.
- `python3 src/build_index.py` rebuilds `index.html` from it for Vercel.
- `markets.html` is the Markets page. `api/crypto.js` and `api/stocks.js` are the live price functions it calls.
- `data/markets.json` is the hourly market brief. It is built by `scripts/markets-brief.js` (GitHub Action `.github/workflows/markets-brief.yml`, every hour at :22) from the live price functions plus headlines from CoinDesk, Cointelegraph, Decrypt, The Block, CNBC, MarketWatch, Yahoo Finance, CBC and the Globe and Mail. The text is put together from the numbers and the feeds, with no AI. The calendar comes from `scripts/market-calendar.json`, so edit that file to add events.
- Both Actions can be run by hand from the repo's **Actions** tab (**Run workflow**). If Vercel ever stops redeploying on these pushes, add a Vercel Deploy Hook URL as the repo secret `VERCEL_DEPLOY_HOOK_URL` and the Actions will call it after each push.
- `src/portfolio-claude.html` is the Portfolio page, published inside Claude (https://claude.ai/artifact/GPd3SVW5eRK61WKRoRcSwL) because reading screenshots uses Claude on your own account. It fetches live prices from this site's `/api` through the Vercel connector, and saves your confirmed numbers privately.
