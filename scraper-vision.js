require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { realtime: { transport: ws } }
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY
});

// Open a page with fallback loading strategy
async function openPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollBy(0, 1000));
  await new Promise(r => setTimeout(r, 2000));
  return page;
}

// STRATEGY 0: Parse the listing page HTML directly.
// Best for sites (like WordPress/Elementor) that show full event info on the listing page.
async function tryDirectParse(browser, url, placeName) {
  console.log('  [Try 0] Direct HTML parse...');
  try {
    const page = await openPage(browser, url);
    const html = await page.evaluate(() => document.body.innerHTML);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    // Also grab all image srcs with their alt text for matching
    const images = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 100)
        .map(img => ({ src: img.src, alt: img.alt }))
        .filter(i => i.src && i.src.startsWith('http'))
    );
    await page.close();

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `You are scraping the events listing page for the venue "${placeName}".
Page URL: ${url}

Page text (innerText):
${text}

Available images on the page:
${images.slice(0, 40).map((img, i) => `${i}: [alt="${img.alt}"] ${img.src}`).join('\n') || 'none'}

Extract ALL upcoming events from this page. Each event may have:
- A title (Hebrew or English)
- A date and time (may be in DD/MM/YYYY HH:MM format)
- A short description
- An image
- A link to its own event page

Return ONLY a JSON array, no explanation:
[{
  "title": "event title",
  "event_date": "2026-06-15T20:00:00",
  "description": "2-3 sentence description from the page",
  "image_url": "full image URL or null",
  "source_url": "individual event page URL or the listing page URL if no individual page"
}]

If the page contains no events, return: []`
        }]
      }]
    });

    const raw = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const events = JSON.parse(raw);
    console.log(`  [Try 0] Found ${events.length} events`);
    return events;
  } catch (err) {
    console.log(`  [Try 0] Failed: ${err.message}`);
    return [];
  }
}

// STRATEGY 1: Extract individual event links from DOM, then visit each.
// Works for sites where events live on separate pages (e.g. /events/my-show).
async function tryLinkExtract(browser, url, place_id) {
  console.log('  [Try 1] DOM link extraction...');
  try {
    const page = await openPage(browser, url);
    const links = await page.evaluate((base) => {
      const domain = new URL(base).origin;
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => {
          const href = a.href;
          if (!href) return null;
          if (href.startsWith('http')) return href;
          if (href.startsWith('/')) return domain + href;
          return null;
        })
        .filter(Boolean);
    }, url);
    await page.close();

    if (!links.length) return [];

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `From this list of URLs from ${url}, identify individual event pages.
Note: URLs may contain Hebrew characters or percent-encoded Hebrew (e.g. %d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d means "events" in Hebrew).
Look for URLs containing path segments like /events/, /show/, /אירועים/, or similar event-related patterns.
Exclude: homepage, nav links (about, contact, shop), external domains, anchor links.

URLs:
${links.slice(0, 150).join('\n')}

Return ONLY a JSON array: ["url1", "url2"]
If none found return: []`
        }]
      }]
    });

    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const eventLinks = JSON.parse(text);

    // Filter to only new events (not already in DB)
    const newLinks = [];
    for (const link of eventLinks) {
      const { data: existing } = await supabase
        .from('events')
        .select('id')
        .eq('place_id', place_id)
        .eq('source_url', link)
        .limit(1);
      if (!existing || existing.length === 0) newLinks.push(link);
    }

    console.log(`  [Try 1] Found ${eventLinks.length} links, ${newLinks.length} new`);
    return newLinks;
  } catch (err) {
    console.log(`  [Try 1] Failed: ${err.message}`);
    return [];
  }
}

// Visit a single event page and extract details
async function scrapeEventPage(browser, url) {
  try {
    const page = await openPage(browser, url);
    const pageData = await page.evaluate(() => {
      const text = document.body.innerText.slice(0, 3000);
      const images = Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 200 && img.naturalHeight > 200)
        .map(img => img.src)
        .filter(src => src && src.startsWith('http'));
      return { text, images };
    });
    await page.close();

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `Extract event details from this page.
URL: ${url}
Text: ${pag