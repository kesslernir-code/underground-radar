require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// Usage: node add-place.js "Venue Name" "https://url" [city] [maxEvents]
const name = process.argv[2];
const inputUrl = process.argv[3];
const city = process.argv[4] || 'Tel Aviv';
const MAX_EVENTS = parseInt(process.argv[5] || '1'); // default: 1 for testing

if (!name || !inputUrl) {
  console.log('Usage: node add-place.js "Venue Name" "https://url" [city] [maxEvents]');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

function detectPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com')) return 'facebook';
  if (url.includes('t.me') || url.includes('telegram')) return 'telegram';
  return 'website';
}

function extractJSON(text) {
  const cleaned = text.trim().replace(/```json|```/g, '').trim();
  const arrStart = cleaned.indexOf('['), objStart = cleaned.indexOf('{');
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON');
  const start = (arrStart === -1) ? objStart : (objStart === -1) ? arrStart : Math.min(arrStart, objStart);
  const end = cleaned[start] === '[' ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Fetch HTML via Node.js (no headless browser detection)
function fetchHTML(pageUrl) {
  return new Promise(function(resolve) {
    try {
      var parsed = new URL(pageUrl);
      var lib = parsed.protocol === 'https:' ? https : http;
      var req = lib.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      }, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchHTML(new URL(res.headers.location, pageUrl).href).then(resolve); return;
        }
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          var buf = Buffer.concat(chunks);
          var enc = res.headers['content-encoding'];
          try {
            if (enc === 'gzip') { zlib.gunzip(buf, function(e, r) { resolve(e ? buf.toString() : r.toString()); }); }
            else if (enc === 'br') { zlib.brotliDecompress(buf, function(e, r) { resolve(e ? buf.toString() : r.toString()); }); }
            else resolve(buf.toString());
          } catch(e) { resolve(buf.toString()); }
        });
      });
      req.on('error', function() { resolve(null); });
      req.setTimeout(15000, function() { req.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}

// Download image with no Referer (bypasses hotlink protection)
function downloadImage(imageUrl) {
  return new Promise(function(resolve) {
    try {
      var parsed = new URL(imageUrl);
      var lib = parsed.protocol === 'https:' ? https : http;
      var req = lib.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
      }, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadImage(res.headers.location).then(resolve); return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          var buf = Buffer.concat(chunks);
          var magic = buf.slice(0, 4).toString('hex');
          var isReal = magic.startsWith('ffd8') || magic.startsWith('8950') || magic.startsWith('4749') || magic.startsWith('5249');
          resolve(isReal && buf.length > 2000 ? buf : null);
        });
      });
      req.on('error', function() { resolve(null); });
      req.setTimeout(12000, function() { req.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}

async function uploadImage(buf, placeId, ext) {
  try {
    var fileName = 'events/' + placeId + '_' + Date.now() + '.' + (ext || 'jpg');
    var up = await supabase.storage.from('event-images').upload(fileName, buf, { contentType: 'image/' + (ext || 'jpeg'), upsert: true });
    if (!up.error) return supabase.storage.from('event-images').getPublicUrl(fileName).data.publicUrl;
  } catch(e) {}
  return null;
}

// STEP 1: Find all social profiles for a venue
async function findProfiles(venueName, knownUrl, platform) {
  console.log('\nFinding profiles for: ' + venueName);
  var profiles = { website: null, instagram: null, facebook: null, telegram: null };
  profiles[platform] = knownUrl;
  try {
    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 512,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Find website, Instagram, Facebook, Telegram for Israeli venue "' + venueName + '". Return ONLY JSON: {"website":"url or null","instagram":"url or null","facebook":"url or null","telegram":"url or null"}' }]
    });
    var tb = msg.content.find(b => b.type === 'text');
    if (tb) {
      var found = extractJSON(tb.text);
      Object.keys(found).forEach(function(k) { if (found[k] && !profiles[k]) { profiles[k] = found[k]; console.log('  ' + k + ': ' + found[k]); } });
    }
  } catch(e) { console.log('  Profile search failed'); }
  profiles[platform] = knownUrl;
  return profiles;
}

// STEP 2: Discover individual event page URLs from the venue's listing page
async function discoverEventUrls(websiteUrl) {
  console.log('\nDiscovering event URLs from: ' + websiteUrl);
  try {
    var html = await fetchHTML(websiteUrl);
    if (!html) return [];
    // Find all links matching event URL patterns (English and Hebrew)
    var links = html.match(/https?:\/\/[^"'\s<>]*\/events?\/[^"'\s<>]{3,}/gi) || [];
    // Hebrew "אירועים" encoded as %d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d
    var hebrewLinks = html.match(/https?:\/\/[^"'\s<>]*\/%d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d\/[^"'\s<>]{3,}/gi) || [];
    // Also find links with ?sd= timestamp (event calendar entries)
    var sdLinks = html.match(/https?:\/\/[^"'\s<>]*\?sd=\d+[^"'\s<>]*/gi) || [];
    var allLinks = links.concat(hebrewLinks).concat(sdLinks);
    // Deduplicate and filter out listing pages
    var seen = {};
    var eventLinks = allLinks.filter(function(url) {
      var clean = url.split('?')[0];
      if (seen[clean]) return false;
      seen[clean] = true;
      // Must be a specific event page (not just /events/ or /events listing)
      return url.includes('?sd=') || clean.match(/\/events?\/[a-z0-9%\-_]{3,}\/?$/i);
    });
    console.log('  Found ' + eventLinks.length + ' individual event URLs');
    return eventLinks;
  } catch(e) {
    console.log('  Discovery failed: ' + e.message);
    return [];
  }
}

// STEP 3: Screenshot event page → Claude Vision extracts everything
// Universal: works for any website regardless of structure
async function scrapeEventPage(browser, eventUrl) {
  var page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');

  // Intercept uploaded images as Chrome loads them (no hotlink protection)
  var interceptedImages = {};
  page.on('response', async function(r) {
    try {
      var ct = r.headers()['content-type'] || '';
      if (ct.includes('image/') && r.status() === 200 && r.url().match(/\/uploads\//i)) {
        var buf = await r.buffer();
        if (buf && buf.length > 3000) interceptedImages[r.url()] = buf;
      }
    } catch(e) {}
  });

  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 4000));
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 1000));
  } catch(e) {
    console.log('    (page load: ' + e.message.slice(0, 50) + ')');
  }

  // Take screenshot — Claude will read this like a human
  var screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

  // Also grab og:image (event poster, publicly accessible)
  var ogImage = await page.evaluate(function() {
    var og = document.querySelector('meta[property="og:image"]');
    return og ? og.getAttribute('content') : null;
  });

  await page.close();

  // Extract date from URL sd= if available (precise for calendar-based venues)
  var dateFromUrl = null;
  var sdMatch = eventUrl.match(/[?&]sd=(\d+)/);
  if (sdMatch) {
    var ts = parseInt(sdMatch[1]);
    // sd= stores Israel time (IDT = UTC+3); subtract 3h to get real UTC
    dateFromUrl = new Date((ts - 10800) * 1000).toISOString().slice(0, 19);
  }

  // Send screenshot to Claude Vision — extracts everything a human can see
  var extracted = {};
  try {
    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text:
            'This is an event page for a venue in Israel. Extract the event information visible on screen.\n' +
            'Return ONLY JSON (no explanation):\n' +
            '{\n' +
            '  "title": "event name only (not the venue name)",\n' +
            '  "event_date": "2026-06-05T20:00:00 — use exact date and time shown on page in Israel local time",\n' +
            '  "description": "2-3 sentences about this specific event from the page"\n' +
            '}\n' +
            'If no date/time is visible, use null for event_date.'
          }
        ]
      }]
    });
    extracted = extractJSON(msg.content[0].text);
    if (extracted.event_date === 'null') extracted.event_date = null;
  } catch(e) {
    console.log('    Vision extraction failed: ' + e.message.slice(0, 60));
  }

  // Image priority: intercepted bytes > og:image > screenshot as last resort
  var interceptedUrls = Object.keys(interceptedImages);
  var rawImageUrl = interceptedUrls.length > 0 ? interceptedUrls[0] : (ogImage || null);
  var interceptedBuf = rawImageUrl && interceptedImages[rawImageUrl] ? interceptedImages[rawImageUrl] : null;

  return {
    title: extracted.title || '',
    // URL date is more precise (exact timestamp); Vision date used for venues without sd=
    event_date: dateFromUrl || extracted.event_date || null,
    description: extracted.description || '',
    source_url: eventUrl,
    raw_image_url: rawImageUrl,
    intercepted_buf: interceptedBuf,
    screenshot_base64: !rawImageUrl ? screenshot : null
  };
}

// STEP 4: Enrich event — use Claude to clean title/description and find missing data
async function enrichEvent(eventData, venueName) {
  // Use Claude to clean up title + description from page text
  try {
    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 512,
      messages: [{ role: 'user', content: [{
        type: 'text',
        text: 'This is an event page for "' + venueName + '".\n' +
          'Current title: "' + eventData.title + '"\n' +
          'Page text:\n' + eventData.body_text.slice(0, 2000) + '\n\n' +
          'Return ONLY JSON:\n' +
          '{"title":"clean event title (Hebrew or English, without venue name)","description":"2-3 sentence description of the event"}'
      }]}]
    });
    var result = extractJSON(msg.content[0].text);
    if (result.title) eventData.title = result.title;
    if (result.description) eventData.description = result.description;
  } catch(e) {}

  // If date still missing, ask Claude to extract it from page text
  if (!eventData.event_date && eventData.body_text) {
    try {
      var dateMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 200,
        messages: [{ role: 'user', content: 'Extract the event date and time from this text. Return ONLY JSON: {"event_date":"2026-06-15T20:00:00 or null"}\n\n' + eventData.body_text.slice(0, 1500) }]
      });
      var dr = extractJSON(dateMsg.content[0].text);
      if (dr.event_date && dr.event_date !== 'null') eventData.event_date = dr.event_date;
    } catch(e) {}
  }

  // If image still missing, search for it
  if (!eventData.raw_image_url) {
    console.log('    Searching for image...');
    try {
      var searchMsg = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 512,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: 'Find an image/poster for the event "' + eventData.title + '" at ' + venueName + '. Return ONLY JSON: {"image_url":"direct image URL or null"}' }]
      });
      var tb = searchMsg.content.find(b => b.type === 'text');
      if (tb) {
        var found = extractJSON(tb.text);
        if (found.image_url) eventData.raw_image_url = found.image_url;
      }
    } catch(e) {}
  }

  return eventData;
}

// STEP 5: Upload image and save event
async function saveEvent(placeId, eventData) {
  if (!eventData.title || eventData.title.length < 2) return false;

  // Upload image to Supabase Storage
  var imageUrl = null;
  if (eventData.intercepted_buf) {
    var ext = ((eventData.raw_image_url || '').match(/\.(jpg|jpeg|png|webp|gif)/i) || ['jpg'])[1] || 'jpg';
    imageUrl = await uploadImage(eventData.intercepted_buf, placeId, ext.toLowerCase());
  }
  if (!imageUrl && eventData.raw_image_url) {
    var buf = await downloadImage(eventData.raw_image_url);
    if (buf) {
      var ext2 = ((eventData.raw_image_url.match(/\.(jpg|jpeg|png|webp|gif)/i) || ['jpg'])[1] || 'jpg').toLowerCase();
      imageUrl = await uploadImage(buf, placeId, ext2);
    }
    if (!imageUrl) imageUrl = eventData.raw_image_url; // last resort: keep original
  }
  // Final fallback: upload the page screenshot itself
  if (!imageUrl && eventData.screenshot_base64) {
    imageUrl = await uploadImage(Buffer.from(eventData.screenshot_base64, 'base64'), placeId, 'png');
  }

  var ins = await supabase.from('events').insert([{
    place_id: placeId,
    title: eventData.title,
    event_date: eventData.event_date || null,
    description: eventData.description || null,
    source_url: eventData.source_url,
    image_url: imageUrl || null,
    raw_text: 'add-place-v2'
  }]);

  if (!ins.error) {
    console.log('  ✓ Saved: ' + eventData.title + (imageUrl ? ' [with image]' : ' [no image]') + (eventData.event_date ? ' [' + eventData.event_date.slice(0, 10) + ']' : ' [no date]'));
    return true;
  } else {
    console.log('  ✗ Error: ' + ins.error.message);
    return false;
  }
}

// MAIN
async function main() {
  console.log('\n═══════════════════════════════════');
  console.log('Adding: ' + name);
  console.log('URL: ' + inputUrl);
  console.log('Max events: ' + MAX_EVENTS);
  console.log('═══════════════════════════════════');

  var platform = detectPlatform(inputUrl);

  // Save place
  var r = await supabase.from('places').insert([{ name, city, status: 'active', added_by: 'cli' }]).select();
  if (r.error) { console.log('Failed to save place: ' + r.error.message); process.exit(1); }
  var placeId = r.data[0].id;
  console.log('Place created: ' + placeId);

  await supabase.from('sources').insert([{ place_id: placeId, type: platform, url_or_handle: inputUrl, active: platform === 'website' }]);

  // Find profiles
  var profiles = await findProfiles(name, inputUrl, platform);
  for (var p of ['website', 'instagram', 'facebook', 'telegram']) {
    if (profiles[p] && profiles[p] !== inputUrl) {
      await supabase.from('sources').insert([{ place_id: placeId, type: p, url_or_handle: profiles[p], active: p === 'website' }]);
    }
  }

  var websiteUrl = profiles.website || (platform === 'website' ? inputUrl : null);
  if (!websiteUrl) {
    console.log('\nNo website found — cannot discover events without a website URL.');
    return;
  }

  // Discover event URLs
  var eventUrls = await discoverEventUrls(websiteUrl);
  if (eventUrls.length === 0) {
    console.log('No individual event pages found. Try a different starting URL.');
    return;
  }

  // Process events one by one
  var browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  var saved = 0;
  var processed = 0;

  console.log('\nProcessing up to ' + MAX_EVENTS + ' events...\n');

  for (var i = 0; i < eventUrls.length && saved < MAX_EVENTS; i++) {
    var eventUrl = eventUrls[i];
    processed++;
    console.log('[' + processed + '] ' + eventUrl.slice(0, 80));

    try {
      // Step 3: Scrape the individual event page
      var eventData = await scrapeEventPage(browser, eventUrl);

      // Skip if no useful title extracted
      if (!eventData.title || eventData.title.length < 3) {
        console.log('    Skipping — no title found');
        continue;
      }

      // Step 4: Enrich with Claude (clean title/description, find missing image)
      eventData = await enrichEvent(eventData, name);

      // Step 5: Save
      var didSave = await saveEvent(placeId, eventData);
      if (didSave) saved++;

      await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      console.log('    Error: ' + e.message.slice(0, 80));
    }
  }

  await browser.close();

  console.log('\n═══════════════════════════════════');
  console.log('Done! Saved ' + saved + ' events for ' + name);
  console.log('Live at: kesslernir-code.github.io/underground-radar');
  console.log('═══════════════════════════════════\n');
}

main().catch(console.error);
