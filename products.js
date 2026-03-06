// netlify/functions/products.js
// GET /.netlify/functions/products?type=game_id&game=free_fire&limit=20&search=

const { getClient, preflight, res } = require('./_supabase');

exports.handler = async (event) => {
  const pre = preflight(event);
  if (pre) return pre;

  if (event.httpMethod !== 'GET')
    return res(405, { success: false, message: 'Method not allowed' });

  try {
    const SB = getClient();
    const { type, game, limit = '20', search } = event.queryStringParameters || {};

    let q = SB.from('products')
      .select('id, name, type, game, price, old_price, tags, game_rank, game_server, game_diamonds, game_skins_count, seller_id, sellers(shop_name)')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(limit) || 20, 50)); // cap at 50

    if (type)             q = q.eq('type', type);
    if (game && game !== 'all') q = q.eq('game', game);
    if (search)           q = q.ilike('name', `%${search}%`);

    const { data, error } = await q;
    if (error) throw error;

    return res(200, { success: true, data: data || [], count: data?.length || 0 });
  } catch (e) {
    console.error('[products]', e.message);
    return res(500, { success: false, message: e.message });
  }
};
