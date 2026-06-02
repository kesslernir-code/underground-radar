require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const places = [
  {
    name: 'המזקקה',
    city: 'Jerusalem',
    status: 'active',
    vibe_tags: ['live music', 'alternative', 'underground'],
    notes: 'הופעות חיות אלטרנטיביות',
    added_by: 'manual'
  },
  {
    name: 'רדיקל',
    city: 'Tel Aviv',
    status: 'active',
    vibe_tags: ['lectures', 'art', 'alternative', 'underground'],
    notes: 'הרצאות, הופעות, אומנות',
    added_by: 'manual'
  }
];

const sources = [
  {
    place_name: 'המזקקה',
    type: 'website',
    url_or_handle: 'https://mazkeka.com/'
  },
  {
    place_name: 'רדיקל',
    type: 'website',
    url_or_handle: 'https://radical.org.il/'
  }
];

async function addPlaces() {
  for (const place of places) {
    const { data, error } = await supabase
      .from('places')
      .insert([place])
      .select();

    if (error) {
      console.log(`❌ Error adding ${place.name}:`, error.message);
      continue;
    }

    console.log(`✅ Added place: ${place.name}`);

    const placeId = data[0].id;
    const source = sources.find(s => s.place_name === place.name);

    if (source) {
      const { error: srcError } = await supabase
        .from('sources')
        .insert([{
          place_id: placeId,
          type: source.type,
          url_or_handle: source.url_or_handle,
          active: true
        }]);

      if (srcError) {
        console.log(`❌ Error adding source for ${place.name}:`, srcError.message);
      } else {
        console.log(`   📡 Source added: ${source.url_or_handle}`);
      }
    }
  }

  console.log('\nDone! Check your Supabase table editor to see the results.');
}

addPlaces();