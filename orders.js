// netlify/functions/orders.js
// GET   /.netlify/functions/orders?action=list
// POST  /.netlify/functions/orders?action=create    body: { product_id, seller_id, amount, note }
// PATCH /.netlify/functions/orders?action=confirm   body: { order_id }
// POST  /.netlify/functions/orders?action=dispute   body: { order_id, reason, description }

const { getClient, preflight, res } = require('./_supabase');

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
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  try {
    const user = await requireAuth(event, SB);
    const uid  = user.id;

    // ════════════════════════════════
    // LIST ORDERS
    // GET /.netlify/functions/orders?action=list&limit=20
    // ════════════════════════════════
    if (action === 'list' && event.httpMethod === 'GET') {
      const limit = Math.min(Number(event.queryStringParameters?.limit) || 20, 50);
      const { data, error } = await SB.from('orders')
        .select('*, products(name, price, type), sellers(shop_name)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return res(200, { success: true, data: data || [] });
    }

    // ════════════════════════════════
    // CREATE ORDER (Escrow flow)
    //   1. Verify wallet balance ≥ amount
    //   2. Deduct wallet atomically via RPC
    //   3. Insert order record
    //   4. Log wallet transaction
    // ════════════════════════════════
    if (action === 'create' && event.httpMethod === 'POST') {
      const { product_id, seller_id, amount, note } = body;
      if (!product_id || !seller_id || !amount)
        return res(400, { success: false, message: 'product_id, seller_id, amount ຈຳເປັນ' });

      const price = Number(amount);

      // 1. Check wallet balance
      const { data: wal } = await SB.from('wallets')
        .select('balance').eq('user_id', uid).maybeSingle();
      const bal = wal?.balance ?? 0;
      if (bal < price)
        return res(400, {
          success: false,
          message: `ຍອດ Wallet ບໍ່ພໍ — ຕ້ອງການ ${price.toLocaleString()} ₭, ມີ ${Number(bal).toLocaleString()} ₭`,
          need_topup: true,
        });

      // 2. Deduct wallet via atomic RPC
      const { error: deductErr } = await SB.rpc('decrement_wallet_balance', {
        p_user_id: uid,
        p_amount:  price,
      });
      if (deductErr) return res(400, { success: false, message: 'ຫັກເງິນລົ້ມເຫຼວ: ' + deductErr.message });

      // 3. Insert order
      const commRate   = 0.05;  // 5% basic
      const commAmount = Math.round(price * commRate);
      const expires    = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const { data: order, error: orderErr } = await SB.from('orders').insert({
        user_id:              uid,
        product_id,
        seller_id,
        amount:               price,
        note:                 note || null,
        status:               'pending',
        guarantee_expires_at: expires,
        commission_rate:      commRate,
        commission_amount:    commAmount,
        id_confirmed:         false,
      }).select().single();
      if (orderErr) {
        // Rollback: restore wallet balance
        await SB.rpc('increment_wallet_balance', { p_user_id: uid, p_amount: price });
        throw orderErr;
      }

      // 4. Log wallet transaction
      await SB.from('wallet_transactions').insert({
        user_id: uid,
        type:    'purchase',
        amount:  price,
        note:    `ຊື້ສິນຄ້າ #${order.id.slice(0, 8).toUpperCase()}`,
      });

      return res(200, { success: true, data: order });
    }

    // ════════════════════════════════
    // CONFIRM RECEIPT
    //   Releases escrow → seller receives (amount - commission)
    // ════════════════════════════════
    if (action === 'confirm' && event.httpMethod === 'PATCH') {
      const { order_id } = body;
      if (!order_id) return res(400, { success: false, message: 'order_id ຈຳເປັນ' });

      // Load order — verify buyer owns it
      const { data: order, error: oe } = await SB.from('orders')
        .select('*').eq('id', order_id).eq('user_id', uid).maybeSingle();
      if (oe || !order) return res(404, { success: false, message: 'ບໍ່ພົບ Order' });
      if (order.id_confirmed) return res(400, { success: false, message: 'ຢືນຢັນໄປແລ້ວ' });

      const sellerAmt = order.amount - (order.commission_amount || 0);

      // Release escrow to seller
      const { error: we } = await SB.rpc('increment_wallet_balance', {
        p_user_id: order.seller_id,
        p_amount:  sellerAmt,
      });
      if (we) throw we;

      // Log seller transaction
      await SB.from('wallet_transactions').insert({
        user_id: order.seller_id,
        type:    'sale',
        amount:  sellerAmt,
        note:    `ຂາຍ Order #${order.id.slice(0, 8).toUpperCase()}`,
      });

      // Update order status
      const { data: updated, error: ue } = await SB.from('orders')
        .update({ status: 'completed', id_confirmed: true })
        .eq('id', order_id)
        .select().single();
      if (ue) throw ue;

      return res(200, { success: true, data: updated });
    }

    // ════════════════════════════════
    // SUBMIT DISPUTE
    // ════════════════════════════════
    if (action === 'dispute' && event.httpMethod === 'POST') {
      const { order_id, reason, description } = body;
      if (!order_id || !reason)
        return res(400, { success: false, message: 'order_id ແລະ reason ຈຳເປັນ' });

      const { data: updated, error } = await SB.from('orders')
        .update({ status: 'disputed', dispute_reason: reason, dispute_note: description || null })
        .eq('id', order_id).eq('user_id', uid)
        .select().single();
      if (error) throw error;

      return res(200, {
        success: true,
        data: updated,
        message: 'ສົ່ງລາຍງານ — ທີມຈະຕອບ 2-4 ຊ.ມ.',
      });
    }

    return res(400, { success: false, message: `Unknown action: ${action}` });

  } catch (e) {
    const status = e.status || 500;
    console.error('[orders]', e.message);
    return res(status, { success: false, message: e.message });
  }
};
