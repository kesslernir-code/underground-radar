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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

// Extract JSON array or object from a Claude response that may include extra text
function extractJSON(text) {
  const cleaned = text.trim().replace(/```json|```/g, '').trim();
  // Find the first [ or { and the matching closing bracket
  const arrStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON found');
  const start = (arrStart === -1) ? objStart : (objStart === -1) ? arrStart : Math.min(arrStart, objStart);
  const isArr = cleaned[start] === '[';
  const end = isArr ? cleaned.lastIndexOf(']') : cleaned.lastIndexOf('}');
  if (end === -1) throw new Error('No closing bracket found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45000);
  await page.setViewport({ width: 1280, height: 900 });
  try {
    // Use domcontentloaded + short wait instead of networkidle2 (avoids hanging on slow sites)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    // If even that fails, just continue with whatever loaded
    console.log('    (page load warning: ' + e.message.slice(0, 60) + ')');
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollBy(0, 1000));
  await new Promise(r => setTimeout(r, 1500));
  return page;
}

// STRATEGY 0: Parse listing page directly
// Returns { events, foundAny } — foundAny=true means the page had events (even if all were duplicates)
async function tryDirectParse(browser, url, placeName) {
  console.log('  [Try 0] Direct HTML parse...');
  try {
    const page = await openPage(browser, url);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 8000));
    const images = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img'))
        .filter(img => img.naturalWidth > 100)
        .map(img => ({ src: img.src, alt: img.alt }))
        .filter(i => i.src && i.src.startsWith('http'))
    );
    await page.close();

    const imageList = images.slice(0, 40)
      .map((img, i) => i + ': [alt="' + img.alt + '"] ' + img.src)
      .join('\n') || 'none';

    const prompt =
      'You are scraping the events listing page for the venue "' + placeName + '".\n' +
      'Page URL: ' + url + '\n\n' +
      'Page text:\n' + text + '\n\n' +
      'Available images:\n' + imageList + '\n\n' +
      'Extract ALL upcoming events. Return ONLY a JSON array:\n' +
      '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_url":"...or null","source_url":"event page URL or listing URL"}]\n' +
      'If no events found return: []';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [Try 0] Found ' + events.length + ' events');
    return events;
  } catch (err) {
    console.log('  [Try 0] Failed: ' + err.message);
    return [];
  }
}

// STRATEGY 1: Extract individual event links, then visit each
async function tryLinkExtract(browser, url, place_id) {
  console.log('  [Try 1] DOM link extraction...');
  try {
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
    if (!links.length) return [];

    const prompt =
      'From this list of URLs from ' + url + ', identify individual event pages.\n' +
      'Note: URLs may contain percent-encoded Hebrew (e.g. %d7%90%d7%99%d7%a8%d7%95%d7%a2%d7%99%d7%9d = events in Hebrew).\n' +
      'Look for /events/, /show/, encoded Hebrew event paths.\n' +
      'Exclude: homepage, nav (about/contact/shop), external domains, anchor links.\n' +
      'URLs:\n' + links.slice(0, 150).join('\n') + '\n\n' +
      'Return ONLY a JSON array: ["url1","url2"]\nIf none: []';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });
    const eventLinks = extractJSON(msg.content[0].text);

    const newLinks = [];
    for (var i = 0; i < eventLinks.length; i++) {
      var r = await supabase.from('events').select('id').eq('place_id', place_id).eq('source_url', eventLinks[i]).limit(1);
      if (!r.data || r.data.length === 0) newLinks.push(eventLinks[i]);
    }
    console.log('  [Try 1] Found ' + eventLinks.length + ' links, ' + newLinks.length + ' new');
    return newLinks;
  } catch (err) {
    console.log('  [Try 1] Failed: ' + err.message);
    return [];
  }
}

async function scrapeEventPage(browser, url) {
  try {
    const page = await openPage(browser, url);
    const pd = await page.evaluate(function() {
      return {
        text: document.body.innerText.slice(0, 3000),
        images: Array.from(document.querySelectorAll('img'))
          .filter(function(img) { return img.naturalWidth > 200 && img.naturalHeight > 200; })
          .map(function(img) { return img.src; })
          .filter(function(src) { return src && src.startsWith('http'); })
      };
    });
    await page.close();

    const prompt =
      'Extract event details from this page.\nURL: ' + url + '\n' +
      'Text: ' + pd.text + '\n' +
      'Images: ' + (pd.images.map(function(u, i) { return i + ': ' + u; }).join('\n') || 'none') + '\n\n' +
      'Return ONLY JSON: {"title":"...","event_date":"2026-06-15T20:00:00","description":"...","image_index":0}\n' +
      'Use -1 for image_index if none suitable.';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    });
    const data = extractJSON(msg.content[0].text);
    return {
      title: data.title, event_date: data.event_date, description: data.description,
      image_url: data.image_index >= 0 ? (pd.images[data.image_index] || null) : null,
      source_url: url
    };
  } catch (e) { return null; }
}

// STRATEGY 2: Screenshot + Vision AI
async function tryScreenshotVision(browser, url, placeName) {
  console.log('  [Try 2] Screenshot + Vision...');
  try {
    const page = await openPage(browser, url);
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    const imageUrls = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('img'))
        .filter(function(img) { return img.naturalWidth > 150; })
        .map(function(img) { return img.src; })
        .filter(function(src) { return src && src.startsWith('http'); });
    });
    await page.close();

    const prompt =
      'Events page for "' + placeName + '". Available images:\n' +
      (imageUrls.slice(0, 30).map(function(u, i) { return i + ': ' + u; }).join('\n') || 'none') + '\n\n' +
      'Extract ALL upcoming events visible in the screenshot.\n' +
      'Return ONLY a JSON array, no explanation before or after:\n' +
      '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","event_url":"url or null","image_index":0}]\n' +
      'If no events: []';

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 2048,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
        { type: 'text', text: prompt }
      ]}]
    });
    const events = extractJSON(msg.content[0].text);
    console.log('  [Try 2] Found ' + events.length + ' events');
    return events.map(function(e) {
      return {
        title: e.title, event_date: e.event_date, description: e.description,
        image_url: e.image_index >= 0 ? (imageUrls[e.image_index] || null) : null,
        source_url: e.event_url || url
      };
    });
  } catch (err) {
    console.log('  [Try 2] Failed: ' + err.message);
    return [];
  }
}

// STRATEGY 3: Web search fallback
async function tryWebSearch(placeName) {
  console.log('  [Try 3] Web search fallback...');
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content:
        'Search for upcoming events at the Israeli venue "' + placeName + '" in 2026.\n' +
        'Return ONLY a JSON array, no explanation:\n' +
        '[{"title":"...","event_date":"2026-06-15T20:00:00","description":"...","source_url":"...","image_url":null}]\n' +
        'If no events: []'
      }]
    });
    const tb = msg.content.find(function(b) { return b.type === 'text'; });
    if (!tb) return [];
    const events = extractJSON(tb.text);
    console.log('  [Try 3] Found ' + events.length + ' events');
    return events;
  } catch (err) {
    console.log('  [Try 3] Failed: ' + err.message);
    return [];
  }
}

async function saveEvents(placeId, events, fallbackUrl) {
  var saved = 0;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (!e || !e.title) continue;
    var sourceUrl = e.source_url || fallbackUrl;
    var check = await supabase.from('events').select('id').eq('place_id', placeId).eq('title', e.title).limit(1);
    if (check.data && check.data.length > 0) { console.log('  skip: ' + e.title); continue; }
    var ins = await supabase.from('events').insert([{
      place_id: placeId, title: e.title, event_date: e.event_date,
      description: e.description, source_url: sourceUrl,
      image_url: e.image_url || null, raw_text: 'deep-vision'
    }]);
    if (!ins.error) { console.log('  saved: ' + e.title); saved++; }
    else console.log('  error: ' + ins.error.message);
    await new Promise(r => setTimeout(r, 500));
  }
  return saved;
}

async function scrapeWithVision() {
  console.log('Starting scraper...\n');
  var res = await supabase.from('sources').select('*, places(name)').eq('active', true).eq('type', 'website');
  if (res.error) { console.log('Could not load sources:', res.error.message); return; }

  var browser = await puppeteer.launch({ headless: true, args: ['--ignore-certificate-errors', '--no-sandbox'] });

  for (var i = 0; i < res.data.length; i++) {
    var source = res.data[i];
    var placeName = source.places.name;
    var url = source.url_or_handle;
    console.log('\n' + placeName + ' - ' + url);
    var totalSaved = 0;

    // Try 0: Direct parse
    // If it returns events (even all duplicates), the site is working — skip further tries
    var directEvents = await tryDirectParse(browser, url, placeName);
    if (directEvents.length > 0) {
      totalSaved = await saveEvents(source.place_id, directEvents, url);
      // Site responded with events — don't run further strategies even if all were duplicates
      console.log('  total saved: ' + totalSaved);
      continue;
    }

    // Try 1: Link extraction → individual pages
    var links = await tryLinkExtract(browser, url, source.place_id);
    if (links.length > 0) {
      var evts = [];
      for (var j = 0; j < links.length; j++) {
        var evt = await scrapeEventPage(browser, links[j]);
        if (evt) evts.push(evt);
        await new Promise(r => setTimeout(r, 1000));
      }
      totalSaved = await saveEvents(source.place_id, evts, url);
      if (totalSaved > 0 || links.length > 0) {
        console.log('  total saved: ' + totalSaved);
        continue;
      }
    }

    // Try 2: Screenshot + Vision
    var vEvents = await tryScreenshotVision(browser, url, placeName);
    if (vEvents.length > 0) {
      totalSaved = await saveEvents(source.place_id, vEvents, url);
      console.log('  total saved: ' + totalSaved);
      continue;
    }

    // Try 3: Web search (last resort)
    var sEvents = await tryWebSearch(placeName);
    totalSaved = await saveEvents(source.place_id, sEvents, url);
    console.log('  total saved: ' + totalSaved);
  }

  await browser.close();
  console.log('\nDone!');
}

scrapeWithVision();
