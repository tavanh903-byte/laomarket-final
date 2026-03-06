// netlify/functions/_supabase.js
// ── Shared Supabase admin client for all Netlify Functions ──
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY; // service_role — never expose to frontend
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  _client = createClient(url, key, {
    auth: { persistSession: false }
  });
  return _client;
}

// Standard CORS headers for every response
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
};

// Preflight OPTIONS handler — call at top of every function
function preflight(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  return null;
}

// Wrap a response with CORS headers
function res(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

module.exports = { getClient, preflight, res };
