require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function test() {
  const { data, error } = await supabase
    .from('places')
    .insert([{
      name: 'The Breakfast Club',
      city: 'Tel Aviv',
      status: 'active',
      vibe_tags: ['underground', 'dark', 'alternative'],
      notes: 'Test place - delete later',
      added_by: 'manual'
    }])
    .select();

  if (error) {
    console.log('❌ Error:', error.message);
  } else {
    console.log('✅ Success! Place added:', data[0].name);
  }
}

test();