require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_KEY
});

async function fetchWebsite(url) {
  const response = await fetch(url);
  const html = await response.text();
  // Strip HTML tags to get plain text
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000);
}

async function extractEvents(text, placeName, sourceUrl) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an event extraction assistant. 
      
Extract all upcoming events from this webpage text from "${placeName}".
Return ONLY a JSON array, nothing else. No explanation, no markdown, just the raw JSON.

Each event should have:
- title (string)
- event_date (ISO date string, e.g. "2026-06-15T20:00:00" — if no time, use "T20:00:00")
- description (string, 1-2 sentences max)

If no events are found, return an empty array: []

Webpage text:
${text}`
    }]
  });

  try {
    return JSON.parse(message.content[0].text);
  } catch {
    console.log('   ⚠️ Could not parse AI response');
    return [];
  }
}

async function scrape() {
  console.log('🔍 Starting scraper...\n');

  const { data: sources, error } = await supabase
    .from('sources')
    .select('*, places(name)')
    .eq('active', true)
    .eq('type', 'website');

  if (error) {
    console.log('❌ Error fetching sources:', error.message);
    return;
  }

  console.log(`Found ${sources.length} sources to check\n`);

  for (const source of sources) {
    const placeName = source.places.name;
    console.log(`📡 Checking: ${placeName} — ${source.url_or_handle}`);

    try {
      const text = await fetchWebsite(source.url_or_handle);
      console.log(`   ✅ Page fetched (${text.length} chars)`);

      const events = await extractEvents(text, placeName, source.url_or_handle);
      console.log(`   🎯 Found ${events.length} events`);

      for (const event of events) {
        const { error: insertError } = await supabase
          .from('events')
          .insert([{
            place_id: source.place_id,
            title: event.title,
            event_date: event.event_date,
            description: event.description,
            source_url: source.url_or_handle,
            raw_text: text.slice(0, 500)
          }]);

        if (insertError) {
          console.log(`   ❌ Error saving event: ${insertError.message}`);
        } else {
          console.log(`   💾 Saved: ${event.title}`);
        }
      }
    } catch (err) {
      console.log(`   ❌ Failed: ${err.message}`);
    }

    console.log('');
  }

  console.log('✅ Scraper finished!');
}

scrape();