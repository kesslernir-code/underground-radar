require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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
    console.log('  (page load warning: ' + e.message.slice(0, 60) + ')');
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollBy(0, 1000));
  await new Promise(r => setTimeout(r, 1500));
  return page;
}

// Step 1: Use Claude web_search to find all profiles for this venue
async function findAllProfiles(venueName, knownUrl, knownPlatform) {
  console.log('\nSearching for all profiles of: ' + venueName);
  const profiles = { website: null, instagram: null, facebook: null, telegram: null };
  profiles[knownPlatform] = knownUrl;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Find the website, Instagram, Facebook, and Telegram for the Israeli venue "' + venueName + '"' +
          (knownPlatform !== 'website' ? ' (known ' + knownPlatform + ': ' + knownUrl + ')' : ' (website: ' + knownUrl + ')') +
          '.\nReturn ONLY a JSON object with what you find:\n' +
          '{"website":"url or null","instagram":"url or null","facebook":"url or null","telegram":"url or null"}\n' +
          'Only include URLs you are confident about. Use null for ones you cannot find.'
      }]
    });
    const tb = msg.content.find(b => b.type === 'text');
    if (tb) {
      const found = extractJSON(tb.text);
      if (found.website && !profiles.website) { profiles.website = found.website; console.log('  Found website: ' + found.website); }
      if (found.instagram && !profiles.instagram) { profiles.instagram = found.instagram; console.log('  Found Instagram: ' + found.instagram); }
      if (found.facebook && !profiles.facebook) { profiles.facebook = found.facebook; console.log('  Found Facebook: ' + found.facebook); }
      if (found.telegram && !profiles.telegram) { profiles.telegram = found.telegram; console.log('  Found Telegram: ' + found.telegram); }
    }
  } catch (e) {
    console.log('  Profile search failed: ' + e.message);
  }

  // Always set the known one
  profiles[knownPlatform] = knownUrl;
  return profiles;
}

// Download image from venue site (bypassing hotlink protection) and upload to Supabase Storage
async function downloadAndUploadImage(page, imageUrl, placeId) {
  try {
    var base64 = await page.evaluate(async function(src) {
      try {
        var resp = await fetch(src);
        if (!resp.ok) return null;
        var blob = await resp.blob();
        return await new Promise(function(resolve) {
          var reader = new FileReader();
          reader.onloadend = function() { resolve(reader.result.split(',')[1]); };
          reader.readAsDataURL(blob);
        });
      } catch(e) { return null; }
    }, imageUrl);
    if (!base64) return null;
    var buf = Buffer.from(base64, 'base64');
    var ext = imageUrl.split('.').pop().split('?')[0] || 'jpg';
    var fileName = 'events/' + placeId + '_' + Date.now() + '.' + ext;
    var upResult = await supabase.storage.from('event-images').upload(fileName, buf, { contentType: 'image/' + ext, upsert: true });
    if (upResult.error) return null;
    return supabase.storage.from('event-images').getPublicUrl(fileName).data.publicUrl;
  } catch(e) { return null; }
}

// Step 2: Scrape events from website - Try individual pages first for better data
async function scrapeWebsite(browser, url, venueName, placeId) {
  console.log('\nScraping website: ' + url);
  var saved = 0;

  // Try 1 FIRST: Find individual event page URLs (these have images + correct URLs)
  try {
    console.log('  [Try 1] Finding individual event pages...');
    const page = await openPage(browser, url);
    const links = await page.evaluate(function(base) {
      var domain = new URL(base).origin;
      return Array.from(document.querySelectorAll('a[href]'))
        .map(function(a) {
          var href = a.href;
          if (!href) return null;
          if (href.startsWith('http')) return href;
          if (href.startsWith('/')) return domain + href;
          return null;
        }).filter(Boolean);
    }, url);
    await page.close();

    if (links.length > 0) {
      // First try: filter links that look like individual event pages directly (no Claude needed)
      var domain = new URL(url).origin;
      var directEventLinks = links.filter(function(l) {
        return l.includes('/events/') || l.includes('/event/') || l.includes('/show/') || l.includes('/happenings/');
      }).filter(function(l, i, arr) { return arr.indexOf(l) === i; }); // dedupe

      var eventLinks = directEventLinks;

      // If direct filter found nothing, ask Claude to identify them
      if (eventLinks.length === 0) {
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 1024,
          messages: [{ role: 'user', content: [{
            type: 'text',
            text: 'From these URLs from ' + url + ', find individual event pages (may have /events/, /show/, or Hebrew-encoded paths %d7%).\nURLs:\n' + links.slice(0, 100).join('\n') + '\nReturn ONLY JSON array: ["url1"]\nIf none: []'
          }]}]
        });
        try { eventLinks = extractJSON(msg.content[0].text); } catch(e) { eventLinks = []; }
      }
      console.log('  [Try 1] Found ' + eventLinks.length + ' individual event pages');

      if (eventLinks.length > 0) {
        for (var i = 0; i < eventLinks.length; i++) {
          try {
            var pg = await openPage(browser, eventLinks[i]);
            var pd = await pg.evaluate(function() {
              // Check og:image first — designed for external use, never hotlink-blocked
              var ogImg = document.querySelector('meta[property="og:image"]');
              var ogImgUrl = ogImg ? ogImg.getAttribute('content') : null;
              var text = document.body.innerText.slice(0, 3000);
              var imgs = Array.from(document.querySelectorAll('img'))
                .filter(function(img) { return img.naturalWidth > 200 && img.naturalHeight > 100; })
                .map(function(img) { return img.src; })
                .filter(function(s) { return s && s.startsWith('http'); });
              return { text: text, images: ogImgUrl ? [ogImgUrl].concat(imgs) : imgs };
            });
            // If still no image, take a screenshot of the page
            var screenshotBase64 = null;
            if (pd.images.length === 0) {
              try {
                var shot = await pg.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 800, height: 500 } });
                screenshotBase64 = shot;
              } catch(se) {}
            }
            await pg.close();

            var m2 = await anthropic.messages.create({
              model: 'claude-sonnet-4-5', max_tokens: 512,
              messages: [{ role: 'user', content: [{
                type: 'text',
                text: 'Extract event details.\nURL: ' + eventLinks[i] + '\nText: ' + pd.text.slice(0, 1500) +
                  '\nReturn ONLY JSON: {"title":"...","event_date":"2026-06-15T21:00:00","description":"..."}\n' +
                  'For event_date: extract from URL timestamps if present (sd= is Unix start time), or from text.'
              }]}]
            });
            var data = extractJSON(m2.content[0].text);
            // Extract time from URL if available (sd= parameter is Unix timestamp)
            var sdMatch = eventLinks[i].match(/[?&]sd=(\d+)/);
            if (sdMatch) {
              var ts = parseInt(sdMatch[1]) * 1000;
              data.event_date = new Date(ts).toISOString().replace('Z', '').slice(0, 19);
            }
            var imageUrl = pd.images.length > 0 ? pd.images[0] : null;
            // Upload screenshot to Supabase Storage if no image found
            if (!imageUrl && screenshotBase64) {
              try {
                var buf = Buffer.from(screenshotBase64, 'base64');
                var fileName = 'events/' + placeId + '_' + Date.now() + '.png';
                var upResult = await supabase.storage.from('event-images').upload(fileName, buf, { contentType: 'image/png', upsert: true });
                if (!upResult.error) {
                  var pubUrl = supabase.storage.from('event-images').getPublicUrl(fileName);
                  imageUrl = pubUrl.data.publicUrl;
                  console.log('  Screenshot uploaded: ' + imageUrl.slice(0, 60));
                }
              } catch(se) { console.log('  Screenshot upload failed: ' + se.message); }
            }
            var event = {
              title: data.title, event_date: data.event_date, description: data.description,
              image_url: imageUrl,
              source_url: eventLinks[i]
            };
            saved += await saveEvents(placeId, [event], url);
          } catch(e2) { console.log('  Failed page: ' + eventLinks[i].slice(0, 60)); }
          await new Promise(r => setTimeout(r, 800));
        }
        if (saved > 0) return saved;
      }
    }
  } catch (e) { console.log('  [Try 1] Failed: ' + e.message); }

  // Try 0: Parse listing page AND download images to Supabase Storage
  try {
    console.log('  [Try 0] Direct HTML parse + image download...');
    const page = await openPage(browser, url);

    // Extract events directly from rendered DOM (links + images + dates)
    var domEvents = await page.evaluate(function() {
      var results = [];
      var links = Array.from(document.querySelectorAll('a[href]'));
      links.forEach(function(a) {
        var href = a.href;
        if (!href || !href.includes('/events/')) return;
        // Get nearby image
        var img = a.querySelector('img') || (a.parentElement && a.parentElement.querySelector('img'));
        var imgSrc = img ? img.src : null;
        // Get nearby text
        var text = a.innerText.trim();
        // Extract time from URL (sd= is Unix timestamp in seconds)
        var sdMatch = href.match(/[?&]sd=(\d+)/);
        var eventDate = sdMatch ? new Date(parseInt(sdMatch[1]) * 1000).toISOString().slice(0, 19) : null;
        if (href && text) {
          results.push({ source_url: href, title: text, event_date: eventDate, raw_image: imgSrc });
        }
      });
      return results;
    });

    // Dedupe by source_url
    var seen = {};
    domEvents = domEvents.filter(function(e) {
      if (seen[e.source_url]) return false;
      seen[e.source_url] = true;
      return true;
    });

    console.log('  [Try 0] Found ' + domEvents.length + ' events in DOM');

    // Download and upload images while still on the page (bypasses hotlink protection)
    for (var i = 0; i < domEvents.length; i++) {
      var e = domEvents[i];
      if (e.raw_image) {
        var hosted = await downloadAndUploadImage(page, e.raw_image, placeId);
        if (hosted) {
          e.image_url = hosted;
          process.stdout.write('.');
        }
      }
    }
    console.log('');

    await page.close();

    if (domEvents.length > 0) {
      // Use Claude to clean up titles (DOM text may be truncated)
      try {
        var cleanMsg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2048,
          messages: [{ role: 'user', content: [{
            type: 'text',
            text: 'Clean up these event titles (remove trailing "..." and "\\..." artifacts) and add short descriptions if possible based on the URL/title.\n' +
              'Input: ' + JSON.stringify(domEvents.map(function(e) { return { title: e.title, url: e.source_url }; })) + '\n' +
              'Return ONLY JSON array: [{"index":0,"title":"cleaned title","description":"short description or null"}]'
          }]}]
        });
        var cleaned = extractJSON(cleanMsg.content[0].text);
        cleaned.forEach(function(c) { if (domEvents[c.index]) { domEvents[c.index].title = c.title; domEvents[c.index].description = c.description; }});
      } catch(e2) {}

      saved = await saveEvents(placeId, domEvents, url);
    }
  } catch (e) { console.log('  [Try 0] Failed: ' + e.message); }

  // Try 1: DOM link extraction
  try {
    console.log('  [Try 1] DOM link extraction...');
    const page = await openPage(browser, url);
    const links = await page.evaluate(function(base) {
      var domain = new URL(base).origin;
      return Array.from(document.querySelectorAll('a[href]'))
        .map(function(a) {
          var href = a.href;
          if (!href) return null;
          if (href.startsWith('http')) return href;
          if (href.startsWith('/')) return domain + href;
          return null;
        }).filter(Boolean);
    }, url);
    await page.close();

    if (links.length > 0) {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 1024,
        messages: [{ role: 'user', content: [{
          type: 'text',
          text: 'From URLs on ' + url + ', find individual event pages (may include Hebrew/encoded paths like %d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d).\nURLs:\n' + links.slice(0, 150).join('\n') + '\nReturn ONLY JSON array: ["url1","url2"]\nIf none: []'
        }]}]
      });
      const eventLinks = extractJSON(msg.content[0].text);
      console.log('  [Try 1] Found ' + eventLinks.length + ' event links');
      const events = [];
      for (var i = 0; i < eventLinks.length; i++) {
        try {
          const pg = await openPage(browser, eventLinks[i]);
          const pd = await pg.evaluate(function() {
            return {
              text: document.body.innerText.slice(0, 3000),
              images: Array.from(document.querySelectorAll('img')).filter(img => img.naturalWidth > 200 && img.naturalHeight > 200).map(img => img.src).filter(src => src && src.startsWith('http'))
            };
          });
          await pg.close();
          const m2 = await anthropic.messages.create({
            model: 'claude-sonnet-4-5', max_tokens: 1024,
            messages: [{ role: 'user', content: [{
              type: 'text',
              text: 'Extract event from: ' + eventLinks[i] + '\nText: ' + pd.text + '\nImages: ' + (pd.images.map((u,i)=>i+': '+u).join('\n')||'none') +
                '\nReturn ONLY JSON: {"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_index":0}\nUse -1 for image_index if none.'
            }]}]
          });
          const data = extractJSON(m2.content[0].text);
          events.push({ ...data, image_url: data.image_index >= 0 ? (pd.images[data.image_index] || null) : null, source_url: eventLinks[i] });
          await new Promise(r => setTimeout(r, 1000));
        } catch(e) {}
      }
      saved = await saveEvents(placeId, events, url);
      if (saved > 0) return saved;
    }
  } catch (e) { console.log('  [Try 1] Failed: ' + e.message); }

  // Try 2: Screenshot + Vision
  try {
    console.log('  [Try 2] Screenshot + Vision...');
    const page = await openPage(browser, url);
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    const imageUrls = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('img')).filter(img => img.naturalWidth > 150).map(img => img.src).filter(src => src && src.startsWith('http'));
    });
    await page.close();
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2048,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
        { type: 'text', text: 'Events page for "' + venueName + '". Images:\n' + (imageUrls.slice(0,30).map((u,i)=>i+': '+u).join('\n')||'none') +
          '\nExtract ALL events. Return ONLY JSON array:\n[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","event_url":"url or null","image_index":0}]\nIf none: []' }
      ]}]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [Try 2] Found ' + events.length + ' events');
    saved = await saveEvents(placeId, events.map(e => ({ ...e, image_url: e.image_index >= 0 ? (imageUrls[e.image_index]||null) : null, source_url: e.event_url || url })), url);
    if (saved > 0) return saved;
  } catch (e) { console.log('  [Try 2] Failed: ' + e.message); }

  return saved;
}

// Step 3: Search for events via web search (catches social media events too)
async function searchForEvents(venueName, profiles) {
  console.log('\nSearching web for events at: ' + venueName);
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content:
        'Search for ALL upcoming events at the Israeli venue "' + venueName + '" in 2026. ' +
        'Check their website' + (profiles.instagram ? ', Instagram (' + profiles.instagram + ')' : '') + (profiles.facebook ? ', Facebook (' + profiles.facebook + ')' : '') + '.\n' +
        'Find event names, dates, times, descriptions, and images.\n' +
        'Return ONLY a JSON array:\n' +
        '[{"title":"...","event_date":"2026-06-15T21:00:00","description":"...","source_url":"where you found it","image_url":null}]\n' +
        'If no events found return: []'
      }]
    });
    const tb = msg.content.find(b => b.type === 'text');
    if (!tb) return [];
    const events = extractJSON(tb.text);
    console.log('  Found ' + events.length + ' events via web search');
    return events;
  } catch (e) {
    console.log('  Web search failed: ' + e.message);
    return [];
  }
}

async function saveEvents(placeId, events, fallbackUrl) {
  var saved = 0;
  var now = new Date();
  var twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (!e || !e.title) continue;

    // Skip events more than 2 weeks away
    if (e.event_date) {
      var eventDate = new Date(e.event_date);
      if (eventDate > twoWeeksFromNow) {
        console.log('  skip (too far ahead): ' + e.title + ' (' + e.event_date.slice(0, 10) + ')');
        continue;
      }
      if (eventDate < now) {
        console.log('  skip (past): ' + e.title);
        continue;
      }
    }

    var sourceUrl = e.source_url || fallbackUrl;
    // Check by title to avoid false duplicates when multiple events share a listing page URL
    var check = await supabase.from('events').select('id').eq('place_id', placeId).eq('title', e.title).limit(1);
    if (check.data && check.data.length > 0) { console.log('  skip (exists): ' + e.title); continue; }
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
  console.log('\nAdding venue: ' + name);
  console.log('URL: ' + inputUrl);
  console.log('City: ' + city);

  const platform = detectPlatform(inputUrl);
  console.log('Platform detected: ' + platform);

  // Save place to DB
  var existing = await supabase.from('places').select('id').eq('name', name).limit(1);
  var placeId;
  if (existing.data && existing.data.length > 0) {
    placeId = existing.data[0].id;
    console.log('\nPlace already exists in DB (id: ' + placeId + ')');
  } else {
    var result = await supabase.from('places').insert([{ name, city, status: 'active', added_by: 'cli' }]).select();
    if (result.error) { console.log('Failed to save place: ' + result.error.message); process.exit(1); }
    placeId = result.data[0].id;
    console.log('\nPlace saved to DB (id: ' + placeId + ')');
  }

  // Save source
  await supabase.from('sources').insert([{ place_id: placeId, type: platform, url_or_handle: inputUrl, active: platform === 'website' }]);

  // Find all profiles
  const profiles = await findAllProfiles(name, inputUrl, platform);

  // Save found social profiles
  for (var p of ['website', 'instagram', 'facebook', 'telegram']) {
    if (profiles[p] && profiles[p] !== inputUrl) {
      await supabase.from('sources').insert([{ place_id: placeId, type: p, url_or_handle: profiles[p], active: p === 'website' }]);
      console.log('  Saved ' + p + ': ' + profiles[p]);
    }
  }

  var totalSaved = 0;

  // Scrape website if available
  if (profiles.website) {
    const browser = await puppeteer.launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });
    totalSaved += await scrapeWebsite(browser, profiles.website, name, placeId);
    await browser.close();
  }

  // Web search for additional events (catches Instagram/Facebook events)
  if (totalSaved === 0 || profiles.instagram || profiles.facebook) {
    const searchEvents = await searchForEvents(name, profiles);
    if (searchEvents.length > 0) {
      const additional = await saveEvents(placeId, searchEvents, inputUrl);
      totalSaved += additional;
    }
  }

  // Quality check: enrich events missing image or individual event URL
  await enrichEvents(placeId, name, profiles);

  console.log('\nDone! Total events saved: ' + totalSaved);
  console.log('Venue now live at: kesslernir-code.github.io/underground-radar');
}

// Enrich incomplete events: find individual event pages and update image + URL
async function enrichEvents(placeId, venueName, profiles) {
  var { data: events } = await supabase.from('events').select('*').eq('place_id', placeId);
  if (!events || events.length === 0) return;

  // Also treat hotlink-blocked domains as missing images
  var blockedDomains = ['levontin7.com', 'radical.org.il'];
  var incomplete = events.filter(function(e) {
    if (!e.image_url) return true;
    return blockedDomains.some(function(d) { return e.image_url.includes(d); });
  });
  if (incomplete.length === 0) { console.log('\nAll events have images — no enrichment needed.'); return; }

  console.log('\nEnriching ' + incomplete.length + ' events missing images...');

  var browser = await require('puppeteer').launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });

  // Strategy A: Extract all event links from the venue website and match to saved events
  if (profiles.website) {
    try {
      console.log('  [A] Finding individual event pages on website...');
      var pg = await openPage(browser, profiles.website);
      var allLinks = await pg.evaluate(function(base) {
        var domain = new URL(base).origin;
        return Array.from(document.querySelectorAll('a[href]')).map(function(a) {
          return { href: a.href.startsWith('http') ? a.href : (a.href.startsWith('/') ? domain + a.href : null), text: (a.innerText || '').trim() };
        }).filter(function(l) { return l.href && l.href !== base; });
      }, profiles.website);
      await pg.close();

      // Ask Claude to match links to event titles
      var eventTitles = incomplete.map(function(e) { return e.title; });
      var msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 2048,
        messages: [{ role: 'user', content: [{
          type: 'text',
          text: 'Match these event titles to their individual page URLs from this list of links.\n\n' +
            'Event titles to find:\n' + eventTitles.map(function(t, i) { return i + ': ' + t; }).join('\n') + '\n\n' +
            'Available links (text → URL):\n' + allLinks.slice(0, 200).map(function(l) { return '"' + l.text + '" → ' + l.href; }).join('\n') + '\n\n' +
            'Return ONLY a JSON array matching index to URL:\n' +
            '[{"index":0,"url":"matched event page URL or null"}]\n' +
            'Only include entries where you found a clear match.'
        }]}]
      });
      var matches = extractJSON(msg.content[0].text);
      console.log('  [A] Found ' + matches.length + ' matches on website');

      // Visit each matched page to get image
      for (var m = 0; m < matches.length; m++) {
        var match = matches[m];
        if (!match.url || match.index === undefined) continue;
        var ev = incomplete[match.index];
        if (!ev) continue;
        try {
          var ePg = await openPage(browser, match.url);
          var imgs = await ePg.evaluate(function() {
            return Array.from(document.querySelectorAll('img'))
              .filter(function(img) { return img.naturalWidth > 200 && img.naturalHeight > 100; })
              .map(function(img) { return img.src; })
              .filter(function(s) { return s && s.startsWith('http'); });
          });
          await ePg.close();
          var updates = { source_url: match.url };
          if (imgs.length > 0) updates.image_url = imgs[0];
          await supabase.from('events').update(updates).eq('id', ev.id);
          console.log('  Updated "' + ev.title + '": url + ' + (updates.image_url ? 'image' : 'no image'));
          // Mark as enriched
          ev.image_url = updates.image_url || ev.image_url;
          ev.source_url = match.url;
        } catch(e) { console.log('  Failed to visit ' + match.url); }
        await new Promise(r => setTimeout(r, 800));
      }
    } catch(e) { console.log('  [A] Failed: ' + e.message.slice(0, 80)); }
  }

  // Strategy B: Search Facebook Events for each missing event (public images, individual URLs)
  var stillMissing = incomplete.filter(function(e) { return !e.image_url; });
  if (stillMissing.length > 0) {
    console.log('  [B] Searching Facebook Events for ' + stillMissing.length + ' events...');
    for (var j = 0; j < stillMissing.length; j++) {
      var ev = stillMissing[j];
      try {
        var msg2 = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 1000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content:
            'Search for the Facebook Events page for: "' + ev.title + '" at ' + venueName + ' in Tel Aviv, Israel in 2026.\n' +
            'Also check if there is a dedicated event page on the venue website or any ticketing site (Eventbrite, Bandsintown, etc.).\n' +
            'I need:\n' +
            '1. A direct link to the specific event page (Facebook event, venue page, or ticketing page)\n' +
            '2. A direct URL to the event poster/image (not hosted on levontin7.com which blocks hotlinking)\n\n' +
            'Return ONLY this JSON: {"event_url":"direct event page URL or null","image_url":"direct image URL (not from levontin7.com) or null"}'
          }]
        });
        var tb = msg2.content.find(function(b) { return b.type === 'text'; });
        if (tb) {
          var upd = {};
          // Try JSON first
          try {
            var found = extractJSON(tb.text);
            if (found.event_url && !blockedDomains.some(function(d){return found.event_url.includes(d);})) upd.source_url = found.event_url;
            if (found.image_url && !blockedDomains.some(function(d){return found.image_url.includes(d);})) upd.image_url = found.image_url;
          } catch(e2) {}
          // Fallback: extract any image URL from text using regex
          if (!upd.image_url) {
            var imgMatches = tb.text.match(/https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|gif)[^\s"']*/gi);
            if (imgMatches) {
              var goodImg = imgMatches.find(function(u) { return !blockedDomains.some(function(d){return u.includes(d);}); });
              if (goodImg) upd.image_url = goodImg;
            }
          }
          // Fallback: extract any event URL from text
          if (!upd.source_url) {
            var urlMatches = tb.text.match(/https?:\/\/(?:www\.facebook\.com\/events\/\d+|[^\s"']+levontin[^\s"']*\/events\/[^\s"']+)/gi);
            if (urlMatches && urlMatches[0]) upd.source_url = urlMatches[0];
          }
          if (Object.keys(upd).length > 0) {
            await supabase.from('events').update(upd).eq('id', ev.id);
            console.log('  [B] Updated "' + ev.title + '": ' + JSON.stringify(upd).slice(0, 100));
          } else {
            console.log('  [B] No external data for: ' + ev.title);
          }
        }
      } catch(e) { console.log('  [B] Search failed: ' + e.message.slice(0, 50)); }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await browser.close();
  console.log('\nEnrichment complete.');
}

main().catch(console.error);
