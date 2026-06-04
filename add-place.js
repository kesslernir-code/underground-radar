require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const https = require('https');
const http = require('http');

// Usage: node add-place.js "Venue Name" "https://any-url.com" [city]
const name = process.argv[2];
const inputUrl = process.argv[3];
const city = process.argv[4] || 'Tel Aviv';

if (!name || !inputUrl) {
  console.log('Usage: node add-place.js "Venue Name" "https://url-or-instagram-or-facebook" [city]');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

function detectPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com') || url.includes('fb.com')) return 'facebook';
  if (url.includes('t.me') || url.includes('telegram')) return 'telegram';
  return 'website';
}

function extractJSON(text) {
  const cleaned = text.trim().replace(/```json|```/g, '').trim();
  const arrStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON found');
  const start = (arrStart === -1) ? objStart : (objStart === -1) ? arrStart : Math.min(arrStart, objStart);
  const isArr = cleaned[start] === '[';
  const end = isArr ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45000);
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log('  (page load: ' + e.message.slice(0, 50) + ')');
  }
  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => window.scrollBy(0, 800));
  await new Promise(r => setTimeout(r, 1500));
  return page;
}

// Download image with Referer spoofing to bypass hotlink protection
function downloadImageBuffer(imageUrl, referer) {
  return new Promise(function(resolve) {
    var parsed = new URL(imageUrl);
    var lib = parsed.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'Referer': referer || parsed.origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*'
      }
    };
    var req = lib.get(options, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        downloadImageBuffer(res.headers.location, referer).then(resolve);
        return;
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var buf = Buffer.concat(chunks);
        resolve(buf.length > 500 ? buf : null);
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
  });
}

// UNIVERSAL image handler: download with Referer spoofing, upload to Supabase Storage
// Falls back to Puppeteer screenshot if download fails
async function getAndStoreImage(page, imageUrl, placeId, pageUrl) {
  // Try to download with Referer set to the venue's own domain
  if (imageUrl) {
    try {
      var referer = pageUrl || (imageUrl ? new URL(imageUrl).origin : 'https://levontin7.com');
      var buf = await downloadImageBuffer(imageUrl, referer);
      if (buf) {
        var ext = ((imageUrl.match(/\.(jpg|jpeg|png|webp|gif)/i) || [])[1] || 'jpg').toLowerCase();
        var fileName = 'events/' + placeId + '_' + Date.now() + '.' + ext;
        var up = await supabase.storage.from('event-images').upload(fileName, buf, { contentType: 'image/' + ext, upsert: true });
        if (!up.error) return supabase.storage.from('event-images').getPublicUrl(fileName).data.publicUrl;
      }
    } catch(e) {}
  }

  // Fallback: screenshot of the current page
  if (page) {
    try {
      var shot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 1280, height: 600 } });
      var fileName2 = 'events/' + placeId + '_screenshot_' + Date.now() + '.png';
      var up2 = await supabase.storage.from('event-images').upload(fileName2, Buffer.from(shot, 'base64'), { contentType: 'image/png', upsert: true });
      if (!up2.error) return supabase.storage.from('event-images').getPublicUrl(fileName2).data.publicUrl;
    } catch(e) {}
  }

  return imageUrl || null;
}

// Find all social profiles for a venue
async function findAllProfiles(venueName, knownUrl, knownPlatform) {
  console.log('\nSearching for all profiles of: ' + venueName);
  const profiles = { website: null, instagram: null, facebook: null, telegram: null };
  profiles[knownPlatform] = knownUrl;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content:
        'Find the website, Instagram, Facebook, and Telegram for the Israeli venue "' + venueName + '"' +
        (knownPlatform !== 'website' ? ' (known ' + knownPlatform + ': ' + knownUrl + ')' : ' (website: ' + knownUrl + ')') +
        '. Return ONLY JSON: {"website":"url or null","instagram":"url or null","facebook":"url or null","telegram":"url or null"}'
      }]
    });
    const tb = msg.content.find(b => b.type === 'text');
    if (tb) {
      const found = extractJSON(tb.text);
      Object.keys(found).forEach(function(k) {
        if (found[k] && !profiles[k]) { profiles[k] = found[k]; console.log('  Found ' + k + ': ' + found[k]); }
      });
    }
  } catch (e) { console.log('  Profile search: ' + e.message.slice(0, 60)); }

  profiles[knownPlatform] = knownUrl;
  return profiles;
}

// Universal 4-strategy scraper — works for any website
async function scrapeWebsite(browser, url, venueName, placeId) {
  console.log('\nScraping: ' + url);
  var saved = 0;

  // STRATEGY 0: Extract events directly from rendered DOM
  // Works for: JS-rendered timetables, WordPress events, any site that shows events as links
  try {
    console.log('  [S0] DOM extraction...');
    const page = await openPage(browser, url);

    var domEvents = await page.evaluate(function() {
      var results = [];
      var seen = {};
      // Find all links that look like event pages
      Array.from(document.querySelectorAll('a[href]')).forEach(function(a) {
        var href = a.href;
        if (!href || seen[href] || href === window.location.href) return;
        // Look for event-like URL patterns
        var isEventUrl = href.includes('/event') || href.includes('/show') || href.includes('/happenings') ||
          href.match(/\/[a-zA-Z0-9%\-_]{5,}\/$/) || href.includes('?sd=');
        if (!isEventUrl) return;
        seen[href] = true;
        // Find image near this link
        var container = a.closest('li, article, div[class*="event"], div[class*="item"]') || a.parentElement;
        var img = container ? container.querySelector('img') : null;
        if (!img) img = a.querySelector('img');
        var imgSrc = img ? img.src : null;
        // Extract timestamp from URL if available
        var sdMatch = href.match(/[?&]sd=(\d+)/);
        var eventDate = sdMatch ? new Date(parseInt(sdMatch[1]) * 1000).toISOString().slice(0, 19) : null;
        var title = a.innerText.trim() || a.title || '';
        if (title.length > 1) results.push({ source_url: href, title: title, event_date: eventDate, raw_image: imgSrc });
      });
      return results;
    });

    console.log('  [S0] Found ' + domEvents.length + ' event links in DOM');

    if (domEvents.length > 0) {
      // Download all images while still on the page (no hotlink restriction)
      for (var i = 0; i < domEvents.length; i++) {
        var e = domEvents[i];
        e.image_url = await getAndStoreImage(page, e.raw_image, placeId, url);
        process.stdout.write(e.image_url ? '✓' : '·');
      }
      console.log('');
      await page.close();
      // Clean up titles with Claude
      try {
        var cleanMsg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2048,
          messages: [{ role: 'user', content: [{
            type: 'text',
            text: 'Clean these event entries. Fix truncated titles, add description from URL context.\n' +
              'Input: ' + JSON.stringify(domEvents.slice(0, 30).map(function(e, i) { return { i: i, title: e.title, url: e.source_url }; })) + '\n' +
              'Return ONLY JSON: [{"i":0,"title":"clean title","description":"1-2 sentence description or null"}]'
          }]}]
        });
        var cleaned = extractJSON(cleanMsg.content[0].text);
        cleaned.forEach(function(c) { if (domEvents[c.i]) { domEvents[c.i].title = c.title || domEvents[c.i].title; domEvents[c.i].description = c.description; }});
      } catch(e2) {}
      saved = await saveEvents(placeId, domEvents, url);
      if (saved > 0) return saved;
    } else {
      await page.close();
    }
  } catch (e) { console.log('  [S0] Failed: ' + e.message.slice(0, 80)); }

  // STRATEGY 1: Parse listing page text with Claude
  // Works for: sites without /events/ URLs, listing-only sites
  try {
    console.log('  [S1] Text parse...');
    const page = await openPage(browser, url);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    const imgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 100)
        .map(img => ({ src: img.src, alt: img.alt }))
        .filter(i => i.src && i.src.startsWith('http'))
    );
    const imgList = imgs.slice(0, 40).map((img, i) => i + ': ' + img.src).join('\n') || 'none';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{
        type: 'text',
        text: 'Events page for "' + venueName + '".\nURL: ' + url + '\nText:\n' + text + '\nImages:\n' + imgList +
          '\n\nExtract ALL upcoming events. Return ONLY JSON array:\n' +
          '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_index":-1,"source_url":"individual event URL or this page URL"}]\n' +
          'For image_index: use the index from the images list that matches this event, or -1 if none.\nIf no events: []'
      }]}]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [S1] Found ' + events.length + ' events');

    if (events.length > 0) {
      // Map image indices and download
      for (var j = 0; j < events.length; j++) {
        var ev = events[j];
        var imgSrc = ev.image_index >= 0 && imgs[ev.image_index] ? imgs[ev.image_index].src : null;
        ev.image_url = await getAndStoreImage(page, imgSrc, placeId, url);
        process.stdout.write(ev.image_url ? '✓' : '·');
      }
      console.log('');
      await page.close();
      saved = await saveEvents(placeId, events, url);
      if (saved > 0) return saved;
    } else {
      await page.close();
    }
  } catch (e) { console.log('  [S1] Failed: ' + e.message.slice(0, 80)); }

  // STRATEGY 2: Screenshot + Vision AI
  // Works for: any site including JavaScript-heavy ones
  try {
    console.log('  [S2] Screenshot + Vision...');
    const page = await openPage(browser, url);
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    const imageUrls = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 150)
        .map(img => img.src)
        .filter(src => src && src.startsWith('http'));
    });

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2048,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
        { type: 'text', text: 'Events page for "' + venueName + '". Images on page:\n' + imageUrls.slice(0, 30).map((u,i) => i+': '+u).join('\n') +
          '\n\nExtract ALL upcoming events visible. Return ONLY JSON array:\n' +
          '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_index":0,"event_url":"url or null"}]\nIf none: []' }
      ]}]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [S2] Found ' + events.length + ' events');

    for (var k = 0; k < events.length; k++) {
      var ev2 = events[k];
      var imgSrc2 = ev2.image_index >= 0 ? imageUrls[ev2.image_index] : null;
      ev2.image_url = await getAndStoreImage(page, imgSrc2, placeId, url);
      ev2.source_url = ev2.event_url || url;
      process.stdout.write(ev2.image_url ? '✓' : '·');
    }
    console.log('');
    await page.close();
    saved = await saveEvents(placeId, events, url);
  } catch (e) { console.log('  [S2] Failed: ' + e.message.slice(0, 80)); }

  return saved;
}

// Web search fallback for events
async function searchForEvents(venueName, profiles) {
  console.log('\nWeb search for events at: ' + venueName);
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content:
        'Search for ALL upcoming events at "' + venueName + '" in Tel Aviv, Israel in 2026. ' +
        'Find event names, dates, descriptions. Return ONLY JSON array:\n' +
        '[{"title":"...","event_date":"2026-06-15T21:00:00","description":"...","source_url":"where found","image_url":null}]\n' +
        'If no events: []'
      }]
    });
    const tb = msg.content.find(b => b.type === 'text');
    if (!tb) return [];
    return extractJSON(tb.text);
  } catch (e) { console.log('  Web search failed: ' + e.message.slice(0, 60)); return []; }
}

async function saveEvents(placeId, events, fallbackUrl) {
  var saved = 0;
  var now = new Date();
  var twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (!e || !e.title || e.title.length < 2) continue;

    if (e.event_date) {
      var d = new Date(e.event_date);
      if (d < now || d > twoWeeksFromNow) { continue; }
    }

    var sourceUrl = e.source_url || fallbackUrl;
    var check = await supabase.from('events').select('id').eq('place_id', placeId).eq('title', e.title).limit(1);
    if (check.data && check.data.length > 0) { console.log('  skip: ' + e.title); continue; }

    var ins = await supabase.from('events').insert([{
      place_id: placeId, title: e.title, event_date: e.event_date,
      description: e.description, source_url: sourceUrl,
      image_url: e.image_url || null, raw_text: 'add-place-cli'
    }]);
    if (!ins.error) { console.log('  saved: ' + e.title); saved++; }
    else console.log('  error: ' + ins.error.message);
    await new Promise(r => setTimeout(r, 300));
  }
  return saved;
}

async function main() {
  console.log('\nAdding: ' + name + ' | ' + inputUrl + ' | ' + city);

  const platform = detectPlatform(inputUrl);
  console.log('Platform: ' + platform);

  // Save place
  var existing = await supabase.from('places').select('id').eq('name', name).limit(1);
  var placeId;
  if (existing.data && existing.data.length > 0) {
    placeId = existing.data[0].id;
    console.log('Place exists (id: ' + placeId + ')');
  } else {
    var result = await supabase.from('places').insert([{ name, city, status: 'active', added_by: 'cli' }]).select();
    if (result.error) { console.log('Failed: ' + result.error.message); process.exit(1); }
    placeId = result.data[0].id;
    console.log('Place created (id: ' + placeId + ')');
  }

  await supabase.from('sources').insert([{ place_id: placeId, type: platform, url_or_handle: inputUrl, active: platform === 'website' }]);

  // Find profiles
  const profiles = await findAllProfiles(name, inputUrl, platform);
  for (var p of ['website', 'instagram', 'facebook', 'telegram']) {
    if (profiles[p] && profiles[p] !== inputUrl) {
      await supabase.from('sources').insert([{ place_id: placeId, type: p, url_or_handle: profiles[p], active: p === 'website' }]);
      console.log('  Saved ' + p + ': ' + profiles[p]);
    }
  }

  var totalSaved = 0;

  // Scrape website
  if (profiles.website) {
    const browser = await puppeteer.launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });
    totalSaved += await scrapeWebsite(browser, profiles.website, name, placeId);
    await browser.close();
  }

  // Web search fallback
  if (totalSaved === 0) {
    const searchEvents = await searchForEvents(name, profiles);
    if (searchEvents.length > 0) totalSaved += await saveEvents(placeId, searchEvents, inputUrl);
  }

  console.log('\nDone! Saved: ' + totalSaved + ' events');
  console.log('Live at: kesslernir-code.github.io/underground-radar');
}

main().catch(console.error);
