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

  await pag