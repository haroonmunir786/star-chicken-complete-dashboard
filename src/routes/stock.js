const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/stock?location_id=xxx
router.get('/', async (req, res) => {
  let query = supabase
    .from('stock')
    .select(`
      id, qty, updated_at,
      product:products(id, name, unit, category, min_stock, selling_price, purchase_price),
      location:locations(id, name, type)
    `);
  if (req.query.location_id) query = query.eq('location_id', req.query.location_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/stock/adjust  { location_id, product_id, qty_delta }
// Used for "Add Stock" at the Slaughter House, or manual corrections.
router.post('/adjust', async (req, res) => {
  const { location_id, product_id, qty_delta, batch, expiry } = req.body;

  const { data: existing } = await supabase
    .from('stock')
    .select('*')
    .eq('location_id', location_id)
    .eq('product_id', product_id)
    .maybeSingle();

  let result, error;
  if (existing) {
    ({ data: result, error } = await supabase
      .from('stock')
      .update({ qty: existing.qty + qty_delta, updated_at: new Date() })
      .eq('id', existing.id)
      .select()
      .single());
  } else {
    ({ data: result, error } = await supabase
      .from('stock')
      .insert({ location_id, product_id, qty: qty_delta })
      .select()
      .single());
  }
  if (error) return res.status(400).json({ error: error.message });

  if (batch || expiry) {
    await supabase.from('products').update({ batch, expiry }).eq('id', product_id);
  }

  await supabase.from('activity_log').insert({
    user_id: req.user.id, action: 'adjust_stock', entity: 'stock', entity_id: result.id,
    details: { location_id, product_id, qty_delta }
  });

  res.json(result);
});

// POST /api/stock/physical-count
// { location_id, counted_by, counts: [{product_id, physical_qty}] }
router.post('/physical-count', async (req, res) => {
  const { location_id, counts } = req.body;
  const rows = [];

  for (const c of counts) {
    const { data: stockRow } = await supabase
      .from('stock')
      .select('qty')
      .eq('location_id', location_id)
      .eq('product_id', c.product_id)
      .maybeSingle();

    const systemQty = stockRow ? stockRow.qty : 0;
    rows.push({
      location_id,
      product_id: c.product_id,
      system_qty: systemQty,
      physical_qty: c.physical_qty,
      counted_by: req.user.id
    });

    await supabase.from('stock').upsert(
      { location_id, product_id: c.product_id, qty: c.physical_qty, updated_at: new Date() },
      { onConflict: 'location_id,product_id' }
    );
  }

  const { data, error } = await supabase.from('physical_counts').insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// GET /api/stock/difference?location_id=xxx  -> latest physical vs system count
router.get('/difference', async (req, res) => {
  let query = supabase
    .from('physical_counts')
    .select('*, product:products(name, unit), location:locations(name)')
    .order('counted_at', { ascending: false });
  if (req.query.location_id) query = query.eq('location_id', req.query.location_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
