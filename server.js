require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getAnthropic() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox']
  });
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1280, height: 900 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollBy(0, 800));
  await new Promise(r => setTimeout(r, 1500));
  return page;
}

async function findSources(placeId, placeName, knownUrl) {
  const anthropic = await getAnthropic();
  console.log('\n🔍 Finding sources for: ' + placeName);

  const sources = [];

  if (knownUrl) {
    sources.push({ type: 'website', url: knownUrl });
    console.log('   📡 website (user-provided): ' + knownUrl);
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: 'Find the Instagram, Facebook, and Telegram for the Israeli venue "' + placeName + '" (website: ' + (knownUrl || 'unknown') + ').\nReturn ONLY a JSON array of social sources you are confident about:\n[\n  { "type": "instagram", "url": "https://instagram.com/..." },\n  { "type": "facebook", "url": "https://facebook.com/..." },\n  { "type": "telegram", "url": "https://t.me/..." }\n]\nIf unsure about one, omit it. If none found return: []'
    }]
  });

  try {
    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const social = JSON.parse(text);
    sources.push.apply(sources, social);
  } catch (e) {
    console.log('   ⚠️  Could not find social sources');
  }

  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    await supabase.from('sources').insert([{
      place_id: placeId,
      type: source.type,
      url_or_handle: source.url,
      active: source.type === 'website'
    }]);
    if (source.type !== 'website') {
      console.log('   📡 ' + source.type + ': ' + source.url);
    }
  }

  return sources.filter(function(s) { return s.type === 'website'; }).map(function(s) { return s.url; });
}

async function tryExtractLinks(browser, websiteUrl) {
  console.log('   [Try 1] Extracting links from DOM...');
  try {
    const page = await openPage(browser, websiteUrl);

    const links = await page.evaluate(function(base) {
      var domain = new URL(base).origin;
      return Array.from(document.querySelectorAll('a[href]'))
        .map(function(a) {
          var href = a.href;
          if (!href) return null;
          if (href.startsWith('http')) return href;
          if (href.startsWith('/')) return domain + href;
          return null;
        })
        .filter(Boolean);
    }, websiteUrl);

    await page.close();
    if (!links.length) return [];

    const anthropic = await getAnthropic();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: 'From this list of URLs from ' + websiteUrl + ', identify ONLY individual event pages.\nNot the homepage, not nav links — only specific event/show pages.\n\nURLs:\n' + links.slice(0, 120).join('\n') + '\n\nReturn ONLY a JSON array: ["url1", "url2"]\nIf none are event pages return: []'
      }]
    });

    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const eventLinks = JSON.parse(text);
    console.log('   [Try 1] Found ' + eventLinks.length + ' event links');
    return eventLinks;
  } catch (err) {
    console.log('   [Try 1] Failed: ' + err.message);
    return [];
  }
}

async function tryScreenshotVision(browser, websiteUrl, placeName) {
  console.log('   [Try 2] Screenshot + Vision AI...');
  try {
    const page = await openPage(browser, websiteUrl);
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    const imageUrls = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('img'))
        .filter(function(img) { return img.naturalWidth > 150; })
        .map(function(img) { return img.src; })
        .filter(function(src) { return src && src.startsWith('http'); });
    });

    await page.close();

    const anthropic = await getAnthropic();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot }
          },
          {
            type: 'text',
            text: 'This is the events page for "' + placeName + '".\nAvailable images on page:\n' + (imageUrls.map(function(u, i) { return i + ': ' + u; }).join('\n') || 'none') + '\n\nExtract ALL upcoming events visible in the screenshot.\nReturn ONLY a JSON array, nothing else:\n[{\n  "title": "event title",\n  "event_date": "2026-06-15T20:00:00",\n  "description": "actual description from the venue, 2-3 sentences",\n  "event_url": "specific event page URL if visible, or null",\n  "image_index": 0\n}]\nIf no events found return: []'
          }
        ]
      }]
    });

    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const events = JSON.parse(text);
    console.log('   [Try 2] Found ' + events.length + ' events via vision');
    return events.map(function(e) {
      return Object.assign({}, e, {
        image_url: e.image_index >= 0 ? (imageUrls[e.image_index] || null) : null,
        source_url: e.event_url || websiteUrl
      });
    });
  } catch (err) {
    console.log('   [Try 2] Failed: ' + err.message);
    return [];
  }
}

async function tryGoogleSearch(placeName) {
  console.log('   [Try 3] Google search fallback...');
  try {
    const anthropic = await getAnthropic();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Search for upcoming events at "' + placeName + '" in Israel in 2026. Find event names, dates, and descriptions.\nReturn ONLY a JSON array:\n[{\n  "title": "event title",\n  "event_date": "2026-06-15T20:00:00",\n  "description": "2-3 sentence description",\n  "source_url": "url where you found this"\n}]\nIf no events found return: []'
      }]
    });

    const textBlock = message.content.find(function(b) { return b.type === 'text'; });
    if (!textBlock) return [];
    const text = textBlock.text.trim().replace(/```json|```/g, '').trim();
    const events = JSON.parse(text);
    console.log('   [Try 3] Found ' + events.length + ' events via search');
    return events.map(function(e) { return Object.assign({ image_url: null }, e); });
  } catch (err) {
    console.log('   [Try 3] Failed: ' + err.message);
    return [];
  }
}

async function scrapeEventPage(browser, url) {
  try {
    const page = await openPage(browser, url);

    const pageData = await page.evaluate(function() {
      var text = document.body.innerText.slice(0, 3000);
      var images = Array.from(document.querySelectorAll('img'))
        .filter(function(img) { return img.naturalWidth > 200 && img.naturalHeight > 200; })
        .map(function(img) { return img.src; })
        .filter(function(src) { return src && src.startsWith('http'); });
      return { text: text, images: images };
    });

    await page.close();

    const anthropic = await getAnthropic();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: 'Extract event details from this page.\nURL: ' + url + '\nText: ' + pageData.text + '\nImages: ' + (pageData.images.map(function(u, i) { return i + ': ' + u; }).join('\n') || 'none') + '\n\nReturn ONLY JSON:\n{\n  "title": "event title",\n  "event_date": "2026-06-15T20:00:00",\n  "description": "actual venue description, 2-3 sentences",\n  "image_index": 0\n}\nUse -1 for image_index if none fit.'
      }]
    });

    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const data = JSON.parse(text);
    return Object.assign({}, data, {
      image_url: data.image_index >= 0 ? (pageData.images[data.image_index] || null) : null,
      source_url: url
    });
  } catch (e) {
    return null;
  }
}

async function saveEvents(placeId, events, websiteUrl) {
  var saved = 0;
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (!event || !event.title) continue;
    var result = await supabase.from('events').insert([{
      place_id: placeId,
      title: event.title,
      event_date: event.event_date,
      description: event.description,
      source_url: event.source_url || websiteUrl,
      image_url: event.image_url || null,
      raw_text: 'auto-scrape'
    }]);
    if (!result.error) {
      console.log('   💾 ' + event.title);
      saved++;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return saved;
}

async function scrapePlace(placeId, placeName, knownUrl) {
  console.log('\n🚀 Scraping: ' + placeName);

  const websiteUrls = await findSources(placeId, placeName, knownUrl);

  if (!websiteUrls.length) {
    console.log('   ⚠️  No website found — trying Google search directly');
    const events = await tryGoogleSearch(placeName);
    if (events.length) await saveEvents(placeId, events, '');
    await supabase.from('places').update({ status: 'active' }).eq('id', placeId);
    return;
  }

  const browser = await launchBrowser();

  for (var i = 0; i < websiteUrls.length; i++) {
    var websiteUrl = websiteUrls[i];
    console.log('\n   🌐 ' + websiteUrl);
    var totalSaved = 0;

    var eventLinks = await tryExtractLinks(browser, websiteUrl);

    if (eventLinks.length > 0) {
      var events = [];
      for (var j = 0; j < eventLinks.length; j++) {
        console.log('   📄 ' + eventLinks[j]);
        var event = await scrapeEventPage(browser, eventLinks[j]);
        if (event) events.push(event);
        await new Promise(r => setTimeout(r, 1000));
      }
      totalSaved = await saveEvents(placeId, events, websiteUrl);
    }

    if (totalSaved === 0) {
      var visionEvents = await tryScreenshotVision(browser, websiteUrl, placeName);
      totalSaved = await saveEvents(placeId, visionEvents, websiteUrl);
    }

    if (totalSaved === 0) {
      var searchEvents = await tryGoogleSearch(placeName);
      totalSaved = await saveEvents(placeId, searchEvents, websiteUrl);
    }

    console.log('   ✅ Total saved: ' + totalSaved + ' events');
  }

  await browser.close();
  await supabase.from('places').update({ status: 'active' }).eq('id', placeId);
  console.log('\n✅ Done: ' + placeName);
}

const server = http.createServer(async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve the frontend at /kessler-time
  if (req.method === 'GET' && (req.url === '/kessler-time' || req.url === '/kessler-time/')) {
    var indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, function(err, data) {
      if (err) { res.writeHead(500); res.end('Error loading page'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Redirect root to /kessler-time
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(302, { 'Location': '/kessler-time' });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/add-place') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        var parsed = JSON.parse(body);
        var name = parsed.name;
        var url = parsed.url;
        var city = parsed.city;

        var result = await supabase
          .from('places')
          .insert([{
            name: name,
            city: city || 'Tel Aviv',
            status: 'pending',
            added_by: 'manual'
          }])
          .select();

        if (result.error) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: result.error.message }));
          return;
        }

        var placeId = result.data[0].id;
        console.log('\nPlace saved: ' + name);

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: '"' + name + '" added — scraping started'
        }));

        scrapePlace(placeId, name, url).catch(function(err) {
          console.log('Scraper error: ' + err.message);
        });

      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

var PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
