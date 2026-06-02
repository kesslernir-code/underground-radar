require('dotenv').config();
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    realtime: {
      enabled: false
    },
    global: {
      headers: {}
    }
  }
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY
});

async function getEventLinks(browser, baseUrl) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollBy(0, 1000));
  await new Promise(r => setTimeout(r, 2000));

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
  }, baseUrl);

  await page.close();

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `From this list of URLs from the page ${baseUrl}, identify which ones are individual event pages (not the main listing page, not nav links, not external links).

URLs:
${links.slice(0, 100).join('\n')}

Return ONLY a JSON array of event page URLs, nothing else:
["url1", "url2"]

If none are event pages return: []`
      }]
    }]
  });

  try {
    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function scrapeEventPage(browser, url) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setViewport({ width: 1280, height: 900 });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  await new Promise(r => setTimeout(r, 2000));

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
        text: `Extract event details from this event page text.

Page URL: ${url}

Page text:
${pageData.text}

Available images:
${pageData.images.map((u, i) => `${i}: ${u}`).join('\n') || 'none'}

Return ONLY a JSON object, nothing else:
{
  "title": "event title",
  "event_date": "2026-06-15T20:00:00",
  "description": "actual description from the venue, 2-3 sentences",
  "image_index": 0
}

Use -1 for image_index if no suitable image found.`
      }]
    }]
  });

  try {
    const text = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const data = JSON.parse(text);
    return {
      ...data,
      image_url: data.image_index >= 0 && pageData.images[data.image_index]
        ? pageData.images[data.image_index]
        : null
    };
  } catch {
    return null;
  }
}

async function scrapeWithVision() {
  console.log('👁️  Starting deep scraper...\n');

  const { data: sources, error } = await supabase
    .from('sources')
    .select('*, places(name)')
    .eq('active', true)
    .eq('type', 'website');

  if (error) {
    console.log('❌ Could not load sources:', error.message);
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox']
  });

  for (const source of sources) {
    const placeName = source.places.name;
    console.log(`\n📡 ${placeName} — ${source.url_or_handle}`);

    let links = [];
    try {
      console.log(`   🔍 Finding event links...`);
      links = await getEventLinks(browser, source.url_or_handle);
      console.log(`   📋 Found ${links.length} event links`);
    } catch (err) {
      console.log(`   ❌ Failed to get links: ${err.message}`);
      continue;
    }

    for (const link of links) {
      console.log(`   📄 ${link}`);
      try {
        // Skip if already in database
        const { data: existing } = await supabase
          .from('events')
          .select('id')
          .eq('place_id', source.place_id)
          .eq('source_url', link)
          .limit(1);

        if (existing && existing.length > 0) {
          console.log(`   ⏭️  Already exists — skipping`);
          continue;
        }

        const event = await scrapeEventPage(browser, link);

        if (!event || !event.title) {
          console.log(`   ⚠️  No data extracted`);
          continue;
        }

        const { error: insertError } = await supabase
          .from('events')
          .insert([{
            place_id: source.place_id,
            title: event.title,
            event_date: event.event_date,
            description: event.description,
            source_url: link,
            image_url: event.image_url || null,
            raw_text: 'deep-vision'
          }]);

        if (!insertError) {
          console.log(`   💾 ${event.title}`);
        } else {
          console.log(`   ❌ Save error: ${insertError.message}`);
        }

      } catch (err) {
        console.log(`   ❌ Failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await browser.close();
  console.log('\n✅ Done!');
}

scrapeWithVision();