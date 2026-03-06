// netlify/functions/auth.js
// Handles: POST /auth?action=register | login | profile
// ─────────────────────────────────────────────────────

const { getClient, preflight, res } = require('./_supabase');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const SB     = getClient();
  const action = event.queryStringParameters?.action;

  // ── Helper: parse body safely ──
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  // ════════════════════════════════
  // REGISTER
  // POST /.netlify/functions/auth?action=register
  // body: { email, password, full_name, phone }
  // ════════════════════════════════
  if (action === 'register') {
    const { email, password, full_name, phone } = body;
    if (!email || !password || !full_name)
      return res(400, { success: false, message: 'email, password, full_name ຈຳເປັນ' });

    // 1. Create auth user via Supabase Admin
    const { data: authData, error: authErr } = await SB.auth.admin.createUser({
      email,
      password,
      email_confirm: false,          // set true to require email verify
      user_metadata: { full_name, phone: phone || null },
    });
    if (authErr) return res(400, { success: false, message: authErr.message });

    const uid = authData.user.id;

    // 2. Insert profile row
    const { error: profErr } = await SB.from('profiles').upsert({
      id: uid,
      email,
      full_name,
      phone: phone || null,
    }, { onConflict: 'id' });
    if (profErr) console.warn('[auth/register] profile upsert:', profErr.message);

    // 3. Create wallet row (balance = 0)
    const { error: walErr } = await SB.from('wallets').upsert({
      user_id: uid,
      balance: 0,
    }, { onConflict: 'user_id' });
    if (walErr) console.warn('[auth/register] wallet upsert:', walErr.message);

    return res(200, {
      success: true,
      message: 'ສ້າງບັນຊີສຳເລັດ — ກວດ Email ຢືນຢັນ 📧',
      user_id: uid,
    });
  }

  // ════════════════════════════════
  // LOGIN  (sign-in via admin to get session)
  // POST /.netlify/functions/auth?action=login
  // body: { email, password }
  // ════════════════════════════════
  if (action === 'login') {
    const { email, password } = body;
    if (!email || !password)
      return res(400, { success: false, message: 'email ແລະ password ຈຳເປັນ' });

    // Use Supabase Auth REST directly (admin SDK doesn't have signInWithPassword)
    const sbUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;

    const loginRes = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
      },
      body: JSON.stringify({ email, password }),
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok)
      return res(401, { success: false, message: loginData.error_description || 'ເຂົ້າລະບົບລົ້ມເຫຼວ' });

    // Load profile
    const { data: profile } = await SB.from('profiles')
      .select('*').eq('id', loginData.user.id).maybeSingle();

    // Load wallet balance
    const { data: wallet } = await SB.from('wallets')
      .select('balance').eq('user_id', loginData.user.id).maybeSingle();

    return res(200, {
      success:      true,
      access_token: loginData.access_token,
      refresh_token: loginData.refresh_token,
      user:         loginData.user,
      profile:      profile || null,
      balance:      wallet?.balance ?? 0,
    });
  }

  // ════════════════════════════════
  // GET PROFILE
  // GET /.netlify/functions/auth?action=profile
  // Header: Authorization: Bearer <jwt>
  // ════════════════════════════════
  if (action === 'profile' && event.httpMethod === 'GET') {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res(401, { success: false, message: 'Unauthorized' });

    const { data: { user }, error } = await SB.auth.getUser(token);
    if (error || !user) return res(401, { success: false, message: 'Token invalid' });

    const { data: profile } = await SB.from('profiles')
      .select('*').eq('id', user.id).maybeSingle();
    const { data: wallet } = await SB.from('wallets')
      .select('balance').eq('user_id', user.id).maybeSingle();

    return res(200, {
      success: true,
      user,
      profile: profile || null,
      balance: wallet?.balance ?? 0,
    });
  }

  return res(400, { success: false, message: `Unknown action: ${action}` });
};
