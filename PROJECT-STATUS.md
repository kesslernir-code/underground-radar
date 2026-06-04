# Underground Radar — Project Status

_Last updated: June 4, 2026_

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

## Product Vision

The app has two panels:

**LEFT — My Radar (active feed)**
- Shows all scraped events from venues you've added, sorted by date
- When a new venue is added, the system automatically:
  - Searches the web, Instagram, Facebook, and Telegram for that venue
  - Finds and fills in all event details (title, date, description, image, link)
  - Saves everything to the database
- Daily scraper keeps it fresh automatically every morning

**RIGHT — Discovery (the real magic)**
- An AI engine that continuously looks for new venues of the same underground/alternative flavor
- Builds a ranked list of suggested venues the system found on its own (from web, Instagram, Telegram)
- Each suggestion shows: venue name, location, why it was suggested, sample events
- You review the list — click "Add" next to any venue → it moves to the left panel and enters regular scraping

---

## Next Steps (Priority Order)

### Step 1 — Fix וומטמה scraping ✅ DONE
Updated scraper source URL to `https://matmon.space/מטמון-אירועים/`. All 12 events now scrape correctly via direct HTML parse.

### Step 2 — Deploy to Railway ✅ DONE
`server.js` live on Railway. Domain `radar.akibabus.com` configured. DNS records added in Wix. Waiting for TXT verification to complete → site goes live at `radar.akibabus.com/kessler-time`.

### Step 3 — Verify domain & test live site 🔄 IN PROGRESS
- Wait for `radar.akibabus.com` to verify in Railway (green checkmark)
- Test `radar.akibabus.com/kessler-time` — event feed should load
- Test "+ add place" form end-to-end (no longer needs local server.js)

### Step 4 — Improve the add-place flow
When a place is added, the system should:
- Search Instagram, Facebook, Telegram automatically for the venue
- Pull event images, descriptions, ticket links from all sources — not just the website
- Use Claude to normalize and deduplicate events found across multiple sources

### Step 5 — Build the RIGHT panel (Discovery engine)
New section in the UI next to the event feed. The system:
1. Looks at the existing venues in the DB and understands the "flavor" (underground, alternative, Tel Aviv/Jerusalem)
2. Runs a deep web + Instagram + Telegram search for similar venues not yet in the system
3. Returns a ranked list: venue name, location, vibe description, sample upcoming event
4. Shows each suggestion as a card with an **"Add"** button
5. Clicking "Add" → venue goes through the full add-place flow and appears in the left feed

This is the engine that grows the radar automatically without manual work.

### Step 6 — Telegram layer
- Write a Telegram channel scraper using the Telegram Bot API
- Activate the Telegram sources already saved in Supabase
- Pull events posted to Telegram channels (text + images)
- Include Telegram events in the left feed

### Step 7 — Add more venues
- Use the discovery panel (Step 5) to find and add venues
- Initial manual candidates: Barby, Levontin 7, The Zone, Alphabet, Port Said, Kabareet

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
