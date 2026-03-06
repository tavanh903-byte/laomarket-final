// netlify/functions/sellers.js
// POST /.netlify/functions/sellers?action=register
// GET  /.netlify/functions/sellers?action=list

const { getClient, preflight, res } = require('./_supabase');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  const SB     = getClient();
  const action = event.queryStringParameters?.action;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  try {
    // ── Register seller application ──
    if (action === 'register' && event.httpMethod === 'POST') {
      const required = ['full_name', 'shop_name', 'phone', 'city', 'province', 'category', 'bank_name', 'bank_account'];
      const missing  = required.filter(k => !body[k]);
      if (missing.length)
        return res(400, { success: false, message: `ຂາດຂໍ້ມູນ: ${missing.join(', ')}` });

      const { data, error } = await SB.from('seller_applications').insert({
        full_name:    body.full_name,
        shop_name:    body.shop_name,
        phone:        body.phone,
        email:        body.email || null,
        house:        body.house || null,
        village:      body.village || null,
        city:         body.city,
        province:     body.province,
        category:     body.category,
        bank_name:    body.bank_name,
        bank_account: body.bank_account,
        bio:          body.bio || null,
        status:       'pending',
      }).select().single();
      if (error) throw error;

      return res(200, {
        success: true,
        data,
        message: 'ສົ່ງໃບສະໝັກສຳເລັດ — ທີມຈະຕອບ 24 ຊ.ມ.',
      });
    }

    // ── Public list of active sellers ──
    if (action === 'list' && event.httpMethod === 'GET') {
      const { data, error } = await SB.from('sellers')
        .select('id, shop_name, commission_rate').eq('is_active', true).limit(50);
      if (error) throw error;
      return res(200, { success: true, data: data || [] });
    }

    return res(400, { success: false, message: `Unknown action: ${action}` });

  } catch (e) {
    console.error('[sellers]', e.message);
    return res(500, { success: false, message: e.message });
  }
};
