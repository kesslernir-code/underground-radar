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
const MAX_EVENTS = parseInt(process.argv[5] || '3'); // default: 3 for testing

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
    // Find all links matching event URL patterns
    var links = html.match(/https?:\/\/[^"'\s<>]*\/events?\/[^"'\s<>]{3,}/gi) || [];
    // Also find links with ?sd= timestamp (event calendar entries)
    var sdLinks = html.match(/https?:\/\/[^"'\s<>]*\?sd=\d+[^"'\s<>]*/gi) || [];
    var allLinks = links.concat(sdLinks);
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

// STEP 3: Visit individual event page and extract all data
async function scrapeEventPage(browser, eventUrl) {
  var page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');

  // Intercept image responses as they load (bypasses hotlink protection)
  var interceptedImages = {};
  page.on('response', async function(r) {
    try {
      var ct = r.headers()['content-type'] || '';
      if (ct.includes('image/') && r.status() === 200 && r.url().includes('/uploads/')) {
        var buf = await r.buffer();
        if (buf && buf.length > 3000) interceptedImages[r.url()] = buf;
      }
    } catch(e) {}
  });

  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch(e) {
    console.log('    (page load: ' + e.message.slice(0, 50) + ')');
  }

  // Extract all event data from the page
  var data = await page.evaluate(function() {
    // og: meta tags — most reliable source
    function getMeta(prop) {
      var el = document.querySelector('meta[property="' + prop + '"], meta[name="' + prop + '"]');
      return el ? (el.getAttribute('content') || el.getAttribute('value') || '').trim() : '';
    }
    var ogImage = getMeta('og:image');
    var ogTitle = getMeta('og:title');
    var ogDesc = getMeta('og:description');
    var pageTitle = document.title || '';
    var bodyText = document.body.innerText.slice(0, 3000);

    // Images from DOM (for fallback)
    var domImages = Array.from(document.querySelectorAll('img'))
      .filter(function(img) { return img.naturalWidth > 200 || img.width > 200; })
      .map(function(img) { return img.src; })
      .filter(function(s) { return s && s.startsWith('http'); });

    return { ogImage: ogImage, ogTitle: ogTitle, ogDesc: ogDesc, pageTitle: pageTitle, bodyText: bodyText, domImages: domImages };
  });

  await page.close();

  // Extract date from URL's sd= parameter (most reliable for venues using this pattern)
  var dateStr = null;
  var sdMatch = eventUrl.match(/[?&]sd=(\d+)/);
  if (sdMatch) {
    // sd= is in Israel local time stored as UTC-like number; subtract 2h to get real UTC
    var ts = parseInt(sdMatch[1]);
    dateStr = new Date((ts - 7200) * 1000).toISOString().slice(0, 19);
  }

  // Choose best image: prefer intercepted (no hotlink) > og:image > DOM
  var imageUrl = null;
  var interceptedUrls = Object.keys(interceptedImages);
  if (interceptedUrls.length > 0) {
    imageUrl = interceptedUrls[0]; // will upload buffer later
  } else if (data.ogImage) {
    imageUrl = data.ogImage;
  } else if (data.domImages.length > 0) {
    imageUrl = data.domImages[0];
  }

  return {
    title: data.ogTitle || data.pageTitle || '',
    description: data.ogDesc || '',
    event_date: dateStr,
    source_url: eventUrl,
    raw_image_url: imageUrl,
    intercepted_buf: imageUrl && interceptedImages[imageUrl] ? interceptedImages[imageUrl] : null,
    body_text: data.bodyText
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
