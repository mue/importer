import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET);
console.log(await supabase.rpc('getRandomImage').single());
console.log(await supabase.rpc('getRandomQuote', { lang: 'English' }).single());