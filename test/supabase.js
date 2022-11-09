import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET);
console.log(await supabase.rpc('get_image_categories'));
console.log(await supabase.rpc('get_image_photographers'));
console.log(await supabase.rpc('get_quote_languages'));

console.log(await supabase.rpc('get_random_image').single());
console.log(await supabase.rpc('get_random_image', { _category: 'plants' }).single());
console.log(await supabase.rpc('get_random_quote').single());