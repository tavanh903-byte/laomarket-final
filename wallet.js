// netlify/functions/wallet.js
// GET  /.netlify/functions/wallet?action=balance
// GET  /.netlify/functions/wallet?action=transactions&limit=20
// POST /.netlify/functions/wallet?action=topup   body: { amount, method }

const { getClient, preflight, res } = require('./_supabase');

// Verify Bearer JWT and return user_id
async function requireAuth(event, SB) {
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { data: { user }, error } = await SB.auth.getUser(token);
  if (error || !user) throw Object.assign(new Error('Token invalid'), { status: 401 });
  return user;
}

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const SB     = getClient();
  const action = event.queryStringParameters?.action;

  try {
    const user = await requireAuth(event, SB);
    const uid  = user.id;

    // ── GET balance ──
    if (action === 'balance' && event.httpMethod === 'GET') {
      const { data, error } = await SB.from('wallets')
        .select('balance, updated_at').eq('user_id', uid).maybeSingle();
      if (error) throw error;
      return res(200, { success: true, data: { balance: data?.balance ?? 0, user_id: uid } });
    }

    // ── GET transactions ──
    if (action === 'transactions' && event.httpMethod === 'GET') {
      const limit = Math.min(Number(event.queryStringParameters?.limit) || 20, 50);
      const { data, error } = await SB.from('wallet_transactions')
        .select('*').eq('user_id', uid)
        .order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return res(200, { success: true, data: data || [] });
    }

    // ── POST topup request ──
    if (action === 'topup' && event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch {}
      const { amount, method = 'qr_bcel' } = body;

      if (!amount || Number(amount) < 10000)
        return res(400, { success: false, message: 'ຈຳນວນຂັ້ນຕ່ຳ 10,000 ₭' });

      // Insert topup request — Admin approves via Supabase Dashboard
      const { data, error } = await SB.from('topup_requests').insert({
        user_id: uid,
        amount:  Number(amount),
        method,
        status:  'pending',
      }).select().single();
      if (error) throw error;

      // Log transaction as pending
      await SB.from('wallet_transactions').insert({
        user_id: uid,
        type:    'topup_request',
        amount:  Number(amount),
        note:    `ຄຳຂໍເຕີມ (${method}) — ລໍ Admin ອະນຸມັດ`,
      });

      return res(200, {
        success: true,
        data,
        message: 'ຄຳຂໍເຕີມເງິນສົ່ງແລ້ວ — Admin ຈະດຳເນີນ 15-30 ນາທີ',
      });
    }

    return res(400, { success: false, message: `Unknown action: ${action}` });

  } catch (e) {
    const status = e.status || 500;
    console.error('[wallet]', e.message);
    return res(status, { success: false, message: e.message });
  }
};
