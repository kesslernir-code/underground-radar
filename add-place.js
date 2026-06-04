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

// Step 2: Scrape events from website using 4-strategy approach
async function scrapeWebsite(browser, url, venueName, placeId) {
  console.log('\nScraping website: ' + url);
  var saved = 0;

  // Try 0: Direct HTML parse
  try {
    console.log('  [Try 0] Direct HTML parse...');
    const page = await openPage(browser, url);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    const images = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 100)
        .map(img => ({ src: img.src, alt: img.alt }))
        .filter(i => i.src && i.src.startsWith('http'))
    );
    await page.close();

    const imageList = images.slice(0, 40).map((img, i) => i + ': [alt="' + img.alt + '"] ' + img.src).join('\n') || 'none';
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{
        type: 'text',
        text: 'Events listing page for "' + venueName + '".\nURL: ' + url + '\nText:\n' + text + '\nImages:\n' + imageList +
          '\n\nExtract ALL upcoming events. Return ONLY JSON array:\n' +
          '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_url":"...or null","source_url":"event URL or listing URL"}]\n' +
          'If no events: []'
      }]}]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [Try 0] Found ' + events.length + ' events');
    if (events.length > 0) {
      saved = await saveEvents(placeId, events, url);
      if (saved > 0 || events.length > 0) return saved;
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
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (!e || !e.title) continue;
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

// Enrich incomplete events: find missing images and individual event page URLs
async function enrichEvents(placeId, venueName, profiles) {
  var { data: events } = await supabase.from('events').select('*').eq('place_id', placeId);
  if (!events || events.length === 0) return;

  var listingDomains = ['levontin7.com', 'mazkeka.com', 'radical.org.il', 'matmon.space'];
  var incomplete = events.filter(function(e) {
    var missingImage = !e.image_url;
    var badUrl = !e.source_url || listingDomains.some(function(d) { return e.source_url && e.source_url.includes(d) && !e.source_url.match(/\/[a-z0-9-]{5,}\/[a-z0-9-]{3,}/i); });
    return missingImage || badUrl;
  });

  if (incomplete.length === 0) { console.log('\nAll events complete — no enrichment needed.'); return; }

  console.log('\nEnriching ' + incomplete.length + ' incomplete events...');

  var browser = await require('puppeteer').launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });

  for (var i = 0; i < incomplete.length; i++) {
    var ev = incomplete[i];
    console.log('\n  Enriching: ' + ev.title);
    var foundImage = ev.image_url || null;
    var foundUrl = ev.source_url || null;

    // Strategy A: search venue website for this specific event
    if (profiles.website && (!foundImage || !foundUrl || foundUrl === profiles.website)) {
      try {
        var pg = await openPage(browser, profiles.website);
        var links = await pg.evaluate(function() {
          return Array.from(document.querySelectorAll('a[href]')).map(function(a) { return { href: a.href, text: a.innerText }; });
        });
        await pg.close();
        // Find link whose text matches the event title
        var match = links.find(function(l) { return l.text && l.href && l.text.includes(ev.title.slice(0, 15)); });
        if (match && match.href !== profiles.website) {
          console.log('    [A] Found event page on website: ' + match.href);
          var ePg = await openPage(browser, match.href);
          var eData = await ePg.evaluate(function() {
            return {
              images: Array.from(document.querySelectorAll('img')).filter(function(img) { return img.naturalWidth > 200; }).map(function(img) { return img.src; }).filter(function(s) { return s && s.startsWith('http'); })
            };
          });
          await ePg.close();
          if (!foundUrl || foundUrl === profiles.website) foundUrl = match.href;
          if (!foundImage && eData.images.length > 0) foundImage = eData.images[0];
        }
      } catch(e) { console.log('    [A] Failed: ' + e.message.slice(0, 50)); }
    }

    // Strategy B: Google search for this specific event
    if (!foundImage || !foundUrl) {
      try {
        var msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 1000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content:
            'Search for the specific event "' + ev.title + '" at "' + venueName + '" in Israel 2026.\n' +
            'Find:\n1. The direct event page URL (on venue site or Facebook Events)\n2. An image/poster for this event\n\n' +
            'Return ONLY JSON:\n{"event_url":"direct URL to this specific event or null","image_url":"direct image URL or null"}'
          }]
        });
        var tb = msg.content.find(function(b) { return b.type === 'text'; });
        if (tb) {
          var found = extractJSON(tb.text);
          if (found.event_url && (!foundUrl || foundUrl === profiles.website)) { foundUrl = found.event_url; console.log('    [B] Found event URL: ' + foundUrl); }
          if (found.image_url && !foundImage) { foundImage = found.image_url; console.log('    [B] Found image: ' + foundImage); }
        }
      } catch(e) { console.log('    [B] Failed: ' + e.message.slice(0, 50)); }
    }

    // Strategy C: Facebook Events search
    if (profiles.facebook && !foundImage) {
      try {
        var msg2 = await anthropic.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 800,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content:
            'Search Facebook Events for "' + ev.title + '" at ' + profiles.facebook + '.\n' +
            'Return ONLY JSON: {"event_url":"facebook event URL or null","image_url":"event image URL or null"}'
          }]
        });
        var tb2 = msg2.content.find(function(b) { return b.type === 'text'; });
        if (tb2) {
          var found2 = extractJSON(tb2.text);
          if (found2.event_url && !foundUrl) { foundUrl = found2.event_url; console.log('    [C] Found FB event: ' + foundUrl); }
          if (found2.image_url && !foundImage) { foundImage = found2.image_url; console.log('    [C] Found FB image: ' + foundImage); }
        }
      } catch(e) { console.log('    [C] Failed: ' + e.message.slice(0, 50)); }
    }

    // Update DB if we found anything new
    var updates = {};
    if (foundImage && foundImage !== ev.image_url) updates.image_url = foundImage;
    if (foundUrl && foundUrl !== ev.source_url) updates.source_url = foundUrl;
    if (Object.keys(updates).length > 0) {
      await supabase.from('events').update(updates).eq('id', ev.id);
      console.log('    Updated: ' + JSON.stringify(updates).slice(0, 80));
    } else {
      console.log('    No new data found for this event');
    }
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();
  console.log('\nEnrichment complete.');
}

main().catch(console.error);
