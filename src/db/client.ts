import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from '../config/env';

/** The exact constructor type supabase-js wants, pulled from its own signature. */
type RealtimeTransport = NonNullable<
  NonNullable<Parameters<typeof createClient>[2]>['realtime']
>['transport'];

/**
 * Service-role client. Bypasses RLS, so it must never be constructed in, or
 * its key forwarded to, anything the browser can reach.
 *
 * `realtime.transport` is required even though this backend never opens a
 * realtime channel. supabase-js builds a RealtimeClient inside its own
 * constructor, and that resolves a WebSocket implementation eagerly — on
 * Node < 22 there is no global WebSocket, so createClient() throws
 * "Node.js detected but native WebSocket not found" at import time and the
 * process dies before it ever serves a request. Handing it `ws` satisfies
 * the lookup; the socket is never actually connected.
 *
 * The alternative is Node 22+, where the global exists and this line becomes
 * unnecessary — see the engines field in package.json.
 *
 * The cast is a .d.ts disagreement only: @types/ws types onopen/onmessage
 * with its own event classes while supabase expects the DOM ones. At runtime
 * `ws` provides everything WebSocketLike requires — the CONNECTING/OPEN/
 * CLOSING/CLOSED constants, send, close, and addEventListener.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: WebSocket as unknown as RealtimeTransport,
  },
  global: {
    headers: { 'X-Client-Info': 'selene-backend' },
  },
});
