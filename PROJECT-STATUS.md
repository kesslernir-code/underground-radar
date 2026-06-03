# Underground Radar — Project Status

_Last updated: June 3, 2026_

---

## Architecture & Tools

```
┌─────────────────────────────────────────────────────────────────────┐
│                         YOU (the user)                              │
└────────────────────────┬────────────────────────────────────────────┘
                         │ opens browser
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  FRONTEND  (index.html)                             │
│                  GitHub Pages — free, public URL                    │
│                                                                     │
│  • Shows event feed (date filter / all upcoming)                    │
│  • "+ add place" form                                               │
│  • Reads events directly from Supabase (REST API)                   │
│  • Sends new-place requests to the Backend                          │
│                                                                     │
│  Tools: HTML · CSS · vanilla JavaScript                             │
└────────┬───────────────────────────────────────┬────────────────────┘
         │ reads events                           │ POST /add-place
         ▼                                        ▼
┌────────────────────────┐           ┌────────────────────────────────┐
│   SUPABASE (database)  │           │   BACKEND  (server.js)         │
│   supabase.co — cloud  │           │   Railway — always online      │
│                        │           │                                │
│  Tables:               │◄──saves───│  1. Saves new place to DB      │
│  • places              │           │  2. Finds social accounts      │
│  • sources             │           │     (Claude AI)                │
│  • events              │           │  3. Runs 3-layer scraper:      │
│                        │           │     [Try 1] Extract DOM links  │
│  Tool: Supabase        │           │     [Try 2] Screenshot+Vision  │
│  (Postgres + REST API) │           │     [Try 3] Google Search      │
└────────────────────────┘           │                                │
         ▲                           │  Tools: Node.js · Puppeteer    │
         │                           │         Anthropic API          │
         │ saves events              └────────────────────────────────┘
         │
┌────────┴───────────────────────────────────────────────────────────┐
│                  DAILY SCRAPER  (scraper-vision.js)                 │
│                  GitHub Actions — runs every day 08:00 Israel time  │
│                                                                     │
│  1. Reads all active sources from Supabase                          │
│  2. Visits each venue website with Puppeteer                        │
│  3. Extracts event links → visits each → Claude parses details      │
│  4. Saves new events back to Supabase                               │
│                                                                     │
│  Tools: Node.js · Puppeteer (headless Chrome) · Anthropic API      │
│         GitHub Actions (free CI/CD scheduler)                       │
└────────────────────────────────────────────────────────────────────┘

         ┌──────────────────────────────────────────┐
         │              GIT / GITHUB                │
         │                                          │
         │  • Source of truth for all code          │
         │  • Push to main → Railway auto-redeploys │
         │  • Push to main → GitHub Pages updates   │
         │  • GitHub Actions runs the daily scraper │
         │                                          │
         │  Tool: Git (terminal) · GitHub           │
         └──────────────────────────────────────────┘
```

### Tools at a Glance

| Tool | What it does in this project |
|---|---|
| **Node.js** | Runs server.js and the scrapers |
| **Puppeteer** | Headless Chrome — visits venue websites, takes screenshots, extracts links |
| **Anthropic API (Claude)** | Reads page content/screenshots and extracts event data as structured JSON |
| **Supabase** | Cloud Postgres database + REST API — stores places, sources, events |
| **GitHub** | Hosts all code, triggers daily scraper via Actions |
| **GitHub Actions** | Runs `scraper-vision.js` every day at 08:00 Israel time automatically |
| **GitHub Pages** | Hosts `index.html` as a public website (free, auto-updates on push) |
| **Railway** | Hosts `server.js` as a live server so anyone can add places |
| **Git (terminal)** | How you push code changes from your computer to GitHub |

---

## What This Is

A scraper + frontend that aggregates underground events (concerts, parties, art shows) from Tel Aviv / Jerusalem venues into one feed. Stack: Node.js · Supabase · Puppeteer · Anthropic API · plain HTML frontend.

**Repo:** https://github.com/kesslernir-code/underground-radar  
**Local folder:** `C:\Users\kessl\Documents\underground-radar`

---

## File Structure

```
underground-radar/
├── index.html          — Frontend UI (runs locally, connects directly to Supabase)
├── Index2.html         — Draft / alternate version (unused)
├── server.js           — Local server on port 3001: handles "add place" requests + triggers scraping
├── scraper-vision.js   — Daily scraper (runs on GitHub Actions): pulls active sources from Supabase → scrapes events
├── scraper.js          — Old scraper (likely replaced by scraper-vision.js)
├── add-places.js       — Standalone script for adding places (likely superseded by server.js)
├── test.js             — Test file
├── run-scraper.bat     — Windows batch file to run the scraper locally
├── .env                — Local secrets (SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY)
├── .gitignore
├── package.json
└── .github/
    └── workflows/
        └── daily-scraper.yml  — GitHub Actions: runs scraper-vision.js daily at 08:00 Israel time (05:00 UTC)
```

**Supabase tables:**
- `places` — venues (name, city, status, added_by)
- `sources` — per-place scrape targets (type: website/instagram/facebook/telegram, url_or_handle, active)
- `events` — scraped events (title, event_date, description, image_url, source_url, place_id)

---

## What's Working

- **Frontend** (`index.html`) — dark-themed event feed, filter by date or "all upcoming", event cards with image/title/description/time/link
- **Add-place flow** — "+ add place" button in UI → POST to `server.js` on port 3001 → inserts into Supabase → triggers scraping automatically
- **3-layer scraper** (`server.js`) — when a new place is added, it tries three strategies in order:
  1. Extract event links from DOM → visit each and parse with Claude
  2. Screenshot + Claude Vision to extract events from the page visually
  3. Google Search fallback via Claude's web_search tool
- **Daily scraper** (`scraper-vision.js`) — runs on GitHub Actions every day at 08:00 Israel time, re-scrapes all active `sources` in Supabase
- **Social source discovery** — when adding a place, Claude auto-finds Instagram/Facebook/Telegram handles and saves them to `sources` (inactive for now)
- **3 places currently in Supabase:** המזקקה, רדיקל, וומטמה

---

## What Needs Fixing

### 1. וומטמה (Womatma) — events not scraping with images
- Their events page is `https://matmon.space/`
- The scraper isn't finding individual event URLs from this page
- Root cause: the site is likely client-rendered (JavaScript-heavy), so Puppeteer's DOM link extraction returns no event-specific links, and the Vision fallback may not be picking up images correctly
- **Fix needed:** Manually inspect `https://matmon.space/` to find the URL pattern for individual events, then either hardcode the events sub-path in `sources.url_or_handle` or adjust the link-extraction prompt to recognize their URL structure

### 2. Supabase anon key is exposed in `index.html`
- The frontend hits Supabase directly with the anon key hardcoded in the HTML (line 333)
- This is okay for read-only data with proper RLS rules, but RLS should be confirmed: anonymous users should only be able to `SELECT` from `events` and `places`, not insert/update/delete
- **Fix needed:** Verify Supabase RLS policies are locked down

### 3. `server.js` must be running locally to add places
- The "add place" form hits `http://localhost:3001` — if `server.js` isn't running, adding places silently fails with "is server.js running?"
- This is fine for now but means only you can add places
- **Future:** deploy `server.js` to a hosted service (Railway, Render, etc.) so the form works for anyone

### 4. Two scrapers exist (`scraper.js` and `scraper-vision.js`)
- `scraper.js` appears to be the old version. It's not clear which is canonical
- GitHub Actions runs `scraper-vision.js` — `scraper.js` can likely be deleted or archived

### 5. `Index2.html` is unused
- Should be deleted or merged if it has anything useful

---

## Next Steps (Priority Order)

### Step 1 — Fix וומטמה scraping
1. Open `https://matmon.space/` and find the URL pattern for individual event pages
2. Update the source record in Supabase to point to the correct events sub-page (e.g. `/events`)
3. Optionally: test the scraper locally with `node scraper-vision.js` against that source

### Step 2 — Add more places
- Use the "+ add place" UI (with `server.js` running) to add new venues
- Good candidates: Barby, Levontin 7, The Zone, Alphabet, Port Said, Kabareet
- Each addition auto-triggers the 3-layer scraper

### Step 3 — Deploy `server.js` to the cloud
- So the add-place form works without running anything locally
- Easiest options: Railway or Render (free tier, deploy from GitHub)
- Update the `fetch` URL in `index.html` from `localhost:3001` to the deployed URL

### Step 4 — Host the frontend
- `index.html` is currently just a local file
- Easiest: push to GitHub Pages or Vercel — it's a single static HTML file, no build needed

### Step 5 — Telegram layer
- `sources` table already has `type: 'telegram'` support
- Next: write a scraper for Telegram channels (requires Telegram Bot API or `telegram` npm package)
- Start by activating the Telegram sources already saved in Supabase for existing places

### Step 6 — Clean up
- Delete `scraper.js` (old version)
- Delete or merge `Index2.html`
- Add a README.md with setup instructions

---

## How to Run Locally

```bash
# Install dependencies
npm install

# Start the add-place server (keep this running)
node server.js

# Open index.html in a browser (just open the file directly)

# Run the scraper manually
node scraper-vision.js
```

**Required `.env` file:**
```
SUPABASE_URL=...
SUPABASE_KEY=...
ANTHROPIC_KEY=...
```
