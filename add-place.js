require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const name = process.argv[2];
const inputUrl = process.argv[3];
const city = process.argv[4] || 'Tel Aviv';

if (!name || !inputUrl) {
  console.log('Usage: node add-place.js "Venue Name" "https://url" [city]');
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

// Fetch page HTML via Node.js (avoids headless browser detection by Cloudflare etc.)
function fetchHTML(pageUrl) {
  return new Promise(function(resolve) {
    try {
      var parsed = new URL(pageUrl);
      var lib = parsed.protocol === 'https:' ? https : http;
      var options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        }
      };
      var req = lib.get(options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchHTML(new URL(res.headers.location, pageUrl).href).then(resolve);
          return;
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

// Download image with NO Referer — simulates direct navigation, bypasses hotlink protection
function downloadImage(imageUrl) {
  return new Promise(function(resolve) {
    try {
      var parsed = new URL(imageUrl);
      var lib = parsed.protocol === 'https:' ? https : http;
      var options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
          // NO Referer = direct navigation = bypasses hotlink protection
        }
      };
      var req = lib.get(options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadImage(res.headers.location).then(resolve); return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          var buf = Buffer.concat(chunks);
          // Verify it's a real image by checking magic bytes
          var magic = buf.slice(0, 4).toString('hex');
          var isReal = magic.startsWith('ffd8') || magic.startsWith('8950') ||
                       magic.startsWith('4749') || magic.startsWith('5249') || magic.startsWith('424d');
          resolve(isReal && buf.length > 1000 ? buf : null);
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
    else console.log('  Upload error: ' + up.error.message + ' | file: ' + fileName);
  } catch(e) { console.log('  Upload exception: ' + e.message); }
  return null;
}

async function getAndStoreImage(imageUrl, placeId) {
  if (!imageUrl) return null;
  var buf = await downloadImage(imageUrl);
  if (!buf) return imageUrl; // last resort: keep original URL
  var ext = ((imageUrl.match(/\.(jpg|jpeg|png|webp|gif)/i) || [])[1] || 'jpg').toLowerCase();
  return await uploadImage(buf, placeId, ext) || imageUrl;
}

async function findAllProfiles(venueName, knownUrl, platform) {
  console.log('\nSearching profiles for: ' + venueName);
  var profiles = { website: null, instagram: null, facebook: null, telegram: null };
  profiles[platform] = knownUrl;
  try {
    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Find website, Instagram, Facebook, Telegram for Israeli venue "' + venueName + '"' +
        (platform !== 'website' ? ' (' + platform + ': ' + knownUrl + ')' : ' (website: ' + knownUrl + ')') +
        '. Return ONLY JSON: {"website":"url or null","instagram":"url or null","facebook":"url or null","telegram":"url or null"}' }]
    });
    var tb = msg.content.find(b => b.type === 'text');
    if (tb) {
      var found = extractJSON(tb.text);
      Object.keys(found).forEach(k => { if (found[k] && !profiles[k]) { profiles[k] = found[k]; console.log('  Found ' + k + ': ' + found[k]); } });
    }
  } catch(e) { console.log('  Profile search: ' + e.message.slice(0, 60)); }
  profiles[platform] = knownUrl;
  return profiles;
}

async function scrapeWebsite(url, venueName, placeId) {
  console.log('\nScraping: ' + url);

  // STRATEGY A: Node.js HTML fetch — avoids Cloudflare/bot detection
  // Works for: any server-rendered site, WordPress, static HTML
  try {
    console.log('  [A] Fetching HTML directly...');
    var html = await fetchHTML(url);
    if (html && html.length > 1000) {
      var text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 9000);
      var imgMatches = html.match(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif)[^"'\s<>]*/gi) || [];
      var imgUrls = imgMatches.filter(function(u, i, arr) { return arr.indexOf(u) === i && !u.includes('logo') && !u.includes('icon') && !u.includes('thumb'); }).slice(0, 30);
      var linkMatches = html.match(/https?:\/\/[^"'\s<>]*\/events\/[^"'\s<>]*/gi) || [];
      var eventLinks = linkMatches.filter(function(u, i, arr) { return arr.indexOf(u) === i; });
      console.log('  [A] HTML: ' + text.length + ' chars, ' + imgUrls.length + ' images, ' + eventLinks.length + ' event links');

      // Extract event-date pairs directly from URLs (sd= is exact Unix timestamp)
      var eventData = [];
      eventLinks.forEach(function(link) {
        var sdMatch = link.match(/[?&]sd=(\d+)/);
        if (sdMatch) {
          var ts = parseInt(sdMatch[1]) * 1000;
          var d = new Date(ts);
          // Add 3 hours for Israel timezone (UTC+3)
          d.setHours(d.getHours() + 3);
          var isoDate = d.toISOString().slice(0, 19);
          eventData.push({ url: link, date: isoDate });
        }
      });
      console.log('  [A] Extracted ' + eventData.length + ' events with exact timestamps from URLs');

      var msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8096,
        messages: [{ role: 'user', content: [{
          type: 'text',
          text: 'Extract ALL upcoming events from this venue page.\nVenue: ' + venueName + '\nURL: ' + url + '\n\n' +
            'Page text:\n' + text + '\n\n' +
            'Event URLs with EXACT dates (use these dates, do not guess from text):\n' + 
            eventData.slice(0, 30).map(function(e) { return e.date + ' → ' + e.url; }).join('\n') + '\n\n' +
            'Images found (by index):\n' + imgUrls.map((u, i) => i + ': ' + u).join('\n') + '\n\n' +
            'Return ONLY JSON array:\n' +
            '[{"title":"event title","event_date":"2026-06-15T21:00:00","description":"2-3 sentences","image_index":0,"source_url":"individual event URL"}]\n' +
            'IMPORTANT: Use the exact event_date from the URL list above, not dates from the page text.\n' +
            'image_index: pick the index of the event poster image (-1 if none).\n' +
            'If no events: []'
        }]}]
      });
      var events = extractJSON(msg.content[0].text);
      console.log('  [A] Claude found ' + events.length + ' events');

      if (events.length > 0) {
        for (var i = 0; i < events.length; i++) {
          var e = events[i];
          var imgUrl = e.image_index >= 0 && imgUrls[e.image_index] ? imgUrls[e.image_index] : null;
          e.image_url = await getAndStoreImage(imgUrl, placeId);
          process.stdout.write(e.image_url && !e.image_url.includes(new URL(url).hostname) ? '✓' : '·');
        }
        console.log('');
        var saved = await saveEvents(placeId, events, url);
        // Don't return — let Strategy B run to enrich images
      }
    }
  } catch(e) { console.log('  [A] Failed: ' + e.message.slice(0, 80)); }

  // STRATEGY B: Puppeteer with response interception
  // Runs ALWAYS to enrich images even if A saved events
  // Works for: heavily JS-rendered sites where Node.js fetch returns minimal content
  // Key: intercept images as Chrome loads them natively — no hotlink protection possible
  try {
    console.log('  [B] Puppeteer + image interception...');
    var browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'] });
    var page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120');

    // Intercept ALL image responses as Chrome downloads them naturally
    var intercepted = {};
    page.on('response', async function(r) {
      try {
        var ct = r.headers()['content-type'] || '';
        if (ct.includes('image/') && r.status() === 200) {
          var buf = await r.buffer();
          if (buf && buf.length > 2000) intercepted[r.url()] = buf;
        }
      } catch(e2) {}
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 6000));
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 3000));

    var pageText = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    await browser.close();

    // Use intercepted URLs as the image list — these are real downloaded images
    var pageImgs = Object.keys(intercepted).filter(function(u) {
      return u.match(/\/uploads\/.*\.(jpg|jpeg|png|webp|gif)/i);
    });
    var interceptedCount = pageImgs.length;
    console.log('  [B] Intercepted ' + interceptedCount + ' real images natively (first: ' + (pageImgs[0] || 'none') + ')');

    var msg2 = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{
        type: 'text',
        text: 'Extract ALL upcoming events.\nVenue: ' + venueName + '\nPage text:\n' + pageText + '\nImages:\n' + pageImgs.map((u,i) => i+': '+u).join('\n') +
          '\nReturn ONLY JSON:\n[{"title":"...","event_date":"2026-06-15T21:00:00","description":"...","image_index":0,"source_url":"event URL or venue URL"}]\nIf none: []'
      }]}]
    });
    var events2 = extractJSON(msg2.content[0].text);
    console.log('  [B] Claude found ' + events2.length + ' events');

    for (var j = 0; j < events2.length; j++) {
      var e2 = events2[j];
      var imgSrc = e2.image_index >= 0 ? pageImgs[e2.image_index] : null;
      var imgBuf2 = imgSrc ? intercepted[imgSrc] : null;
      if (imgBuf2) {
        // Use natively intercepted image — bypasses all hotlink protection
        var ext2 = ((imgSrc.match(/\.(jpg|jpeg|png|webp|gif)/i) || [])[1] || 'jpg').toLowerCase();
        e2.image_url = await uploadImage(imgBuf2, placeId, ext2);
        process.stdout.write(e2.image_url ? '✓' : '·');
      } else {
        e2.image_url = await getAndStoreImage(imgSrc, placeId);
        process.stdout.write(e2.image_url && e2.image_url !== imgSrc ? '✓' : '·');
      }
    }
    console.log('');
    // Enrich existing events that have no image
    var { data: existingNoImg } = await supabase.from('events').select('id,title').eq('place_id', placeId).is('image_url', null);
    if (existingNoImg && existingNoImg.length > 0) {
      console.log('  [B] Enriching ' + existingNoImg.length + ' events without images...');
      for (var k = 0; k < Math.min(existingNoImg.length, pageImgs.length); k++) {
        var ev = existingNoImg[k];
        // Find best matching image by index (each event gets one intercepted image)
        var imgKey = pageImgs[k % pageImgs.length];
        var buf3 = intercepted[imgKey];
        if (buf3) {
          var ext3 = ((imgKey.match(/\.(jpg|jpeg|png|webp|gif)/i) || [])[1] || 'jpg').toLowerCase();
          var uploadedUrl = await uploadImage(buf3, placeId, ext3);
          if (uploadedUrl) {
            await supabase.from('events').update({ image_url: uploadedUrl }).eq('id', ev.id);
            process.stdout.write('✓');
          } else process.stdout.write('·');
        }
        await new Promise(r => setTimeout(r, 100));
      }
      console.log('');
    }
    // Also save any NEW events found by B that A missed
    var bSaved = await saveEvents(placeId, events2, url);
    return bSaved;
  } catch(e) { console.log('  [B] Failed: ' + e.message.slice(0, 80)); }

  return 0;
}

async function searchForEvents(venueName) {
  console.log('\n  Web search for: ' + venueName);
  try {
    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Find upcoming events at "' + venueName + '" in Tel Aviv Israel in 2026. Return ONLY JSON:\n[{"title":"...","event_date":"2026-06-15T21:00:00","description":"...","source_url":"...","image_url":null}]\nIf none: []' }]
    });
    var tb = msg.content.find(b => b.type === 'text');
    return tb ? extractJSON(tb.text) : [];
  } catch(e) { return []; }
}

async function saveEvents(placeId, events, fallbackUrl) {
  var saved = 0;
  var now = new Date();
  var twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (!e || !e.title || e.title.length < 2) continue;
    if (e.event_date) {
      var d = new Date(e.event_date);
      if (d < now || d > twoWeeks) continue;
    }
    var check = await supabase.from('events').select('id').eq('place_id', placeId).eq('title', e.title).limit(1);
    if (check.data && check.data.length > 0) { console.log('  skip: ' + e.title); continue; }
    var ins = await supabase.from('events').insert([{
      place_id: placeId, title: e.title, event_date: e.event_date,
      description: e.description, source_url: e.source_url || fallbackUrl,
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
  var platform = detectPlatform(inputUrl);
  console.log('Platform: ' + platform);

  var existing = await supabase.from('places').select('id').eq('name', name).limit(1);
  var placeId;
  if (existing.data && existing.data.length > 0) {
    placeId = existing.data[0].id;
    console.log('Place exists (id: ' + placeId + ')');
  } else {
    var r = await supabase.from('places').insert([{ name, city, status: 'active', added_by: 'cli' }]).select();
    if (r.error) { console.log('Failed: ' + r.error.message); process.exit(1); }
    placeId = r.data[0].id;
    console.log('Place created (id: ' + placeId + ')');
  }

  await supabase.from('sources').insert([{ place_id: placeId, type: platform, url_or_handle: inputUrl, active: platform === 'website' }]);

  var profiles = await findAllProfiles(name, inputUrl, platform);
  for (var p of ['website', 'instagram', 'facebook', 'telegram']) {
    if (profiles[p] && profiles[p] !== inputUrl) {
      await supabase.from('sources').insert([{ place_id: placeId, type: p, url_or_handle: profiles[p], active: p === 'website' }]);
      console.log('  Saved ' + p + ': ' + profiles[p]);
    }
  }

  var totalSaved = 0;
  if (profiles.website) {
    totalSaved += await scrapeWebsite(profiles.website, name, placeId);
  }
  if (totalSaved === 0) {
    var events = await searchForEvents(name);
    if (events.length > 0) totalSaved += await saveEvents(placeId, events, inputUrl);
  }

  console.log('\nDone! Saved: ' + totalSaved + ' events');
  console.log('Live at: kesslernir-code.github.io/underground-radar');
}

main().catch(console.error);
