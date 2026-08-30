import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

/**
 * Service-role client. Bypasses RLS, so it must never be constructed in, or
 * its key forwarded to, anything the browser can reach.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  global: {
    headers: { 'X-Client-Info': 'selene-backend' },
  },
});
