# Northline Briefing

A self-refreshing news briefing for world, U.S., Canada and Ontario news. Every story comes with what's happening now, how we got here, a timeline of the past year, why it matters, and what it means for someone living in Ontario.

## How it works

- `index.html` is the whole site. It has no build step and no dependencies.
- `data/` holds the news, as plain JSON:
  - `current.json` is the latest edition.
  - `days/YYYY-MM-DD.json` is the last edition of each day. The page uses these for **Yesterday** and older days.
  - `week.json` lists the biggest stories of the past seven days for **Past week**.
  - `index.json` lists which days are saved, with each day's headline.
- A Claude scheduled task researches the news about four times a day (around 6 AM, noon, 5 PM and 9 PM Toronto time), rewrites these files and pushes a commit. Vercel redeploys on every push, and open pages check for a new edition every 5 minutes.

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import `ishpreet-bal/northline`.
2. Leave **Framework Preset** on **Other**. No build command or output directory is needed.
3. Deploy.

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly from disk won't load the data, because browsers block `fetch` on `file://` pages.
