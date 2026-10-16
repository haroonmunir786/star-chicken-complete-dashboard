const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Supabase returns at most 1,000 rows per request. Stock is one row per
// product per location, so a full system (e.g. 150 products x 8 locations)
// can pass that limit -- and rows past the limit would silently vanish from
// the app. This helper keeps asking for the next page until it has them all.
async function fetchAllRows(buildQuery) {
  const pageSize = 1000;
  const all = [];
  for (let from = 0; from < 100000; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

// Who may SET a stock quantity directly (corrections / zeroing out).
// Mirrors the rules the screens already apply.
async function canSetStock(user, locationId) {
  const { data: loc } = await supabase
    .from('locations')
    .select('id, type')
    .eq('id', locationId)
    .maybeSingle();
  if (!loc) return { ok: false, status: 404, error: 'Location not found' };

  if (loc.type === 'warehouse') {
    if (['super_admin', 'main_store_manager'].includes(user.role)) return { ok: true };
    return { ok: false, status: 403, error: 'Only Super Admin or the Main Store Manager can change Slaughter House stock' };
  }

  if (['super_admin', 'main_store_manager', 'mini_store_manager', 'all_branches_manager'].includes(user.role)) {
    return { ok: true };
  }
  if (user.role === 'branch_manager' && user.branch_id && user.branch_id === locationId) {
    return { ok: true };
  }
  return { ok: false, status: 403, error: 'You do not have permission to change this branch\'s stock' };
}

// GET /api/stock?location_id=xxx
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllRows(() => {
      let query = supabase
        .from('stock')
        .select(`
          id, qty, updated_at,
          product:products(id, name, unit, category, min_stock, selling_price, purchase_price, batch, expiry),
          location:locations(id, name, type)
        `)
        .order('id');
      if (req.query.location_id) query = query.eq('location_id', req.query.location_id);
      return query;
    });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stock/adjust  { location_id, product_id, qty_delta, batch?, expiry? }
// ADDS (or subtracts) a quantity -- used for "Add Stock" at the Slaughter House.
router.post('/adjust', async (req, res) => {
  const { location_id, product_id, qty_delta, batch, expiry } = req.body;
  const delta = Number(qty_delta);
  if (!location_id || !product_id || !Number.isFinite(delta)) {
    return res.status(400).json({ error: 'location_id, product_id and a numeric qty_delta are required' });
  }

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
      .update({ qty: Number(existing.qty) + delta, updated_at: new Date() })
      .eq('id', existing.id)
      .select()
      .single());
  } else {
    ({ data: result, error } = await supabase
      .from('stock')
      .insert({ location_id, product_id, qty: delta })
      .select()
      .single());
  }
  if (error) return res.status(400).json({ error: error.message });

  const productUpdates = {};
  if (batch) productUpdates.batch = batch;
  if (expiry) productUpdates.expiry = expiry;
  if (Object.keys(productUpdates).length) {
    await supabase.from('products').update(productUpdates).eq('id', product_id);
  }

  await supabase.from('activity_log').insert({
    user_id: req.user.id, action: 'adjust_stock', entity: 'stock', entity_id: result.id,
    details: { location_id, product_id, qty_delta: delta }
  });

  res.json(result);
});

// POST /api/stock/set   { location_id, items: [{product_id, qty}], note? }
// Sets the EXACT quantity (not +/-). Used to correct a wrong number or to
// clear stock. Every change is written to the activity log with old -> new.
router.post('/set', async (req, res) => {
  const { location_id, items, note } = req.body;
  if (!location_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'location_id and at least one item are required' });
  }

  // De-duplicate by product (last value wins) and validate
  const wanted = new Map();
  for (const it of items) {
    const q = Number(it.qty);
    if (!it.product_id || !Number.isFinite(q) || q < 0) {
      return res.status(400).json({ error: 'Each item needs a product_id and a quantity of 0 or more' });
    }
    wanted.set(it.product_id, q);
  }

  const perm = await canSetStock(req.user, location_id);
  if (!perm.ok) return res.status(perm.status).json({ error: perm.error });

  try {
    // One read of this location's stock, then one bulk write
    const existingRows = await fetchAllRows(() =>
      supabase.from('stock').select('product_id, qty').eq('location_id', location_id).order('id')
    );
    const oldQty = {};
    existingRows.forEach(r => { oldQty[r.product_id] = Number(r.qty); });

    const now = new Date();
    const upserts = [];
    const changes = [];
    for (const [product_id, qty] of wanted) {
      upserts.push({ location_id, product_id, qty, updated_at: now });
      changes.push({ product_id, old_qty: oldQty[product_id] ?? 0, new_qty: qty });
    }

    const { error } = await supabase
      .from('stock')
      .upsert(upserts, { onConflict: 'location_id,product_id' });
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('activity_log').insert({
      user_id: req.user.id, action: 'set_stock', entity: 'stock', entity_id: null,
      details: { location_id, note: note || null, changes }
    });

    res.json({ ok: true, changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stock/physical-count
// { location_id, counts: [{product_id, physical_qty}] }
// Records what was physically counted next to what the system says, so the
// difference can be reviewed. It deliberately does NOT change system stock --
// the whole point of a physical count is to expose the difference.
router.post('/physical-count', async (req, res) => {
  const { location_id, counts } = req.body;
  if (req.user.role === 'sales_staff') {
    return res.status(403).json({ error: 'Physical count is not available for Sales Staff' });
  }
  if (!location_id || !Array.isArray(counts) || !counts.length) {
    return res.status(400).json({ error: 'location_id and at least one count are required' });
  }

  try {
    const stockRows = await fetchAllRows(() =>
      supabase.from('stock').select('product_id, qty').eq('location_id', location_id).order('id')
    );
    const systemQty = {};
    stockRows.forEach(r => { systemQty[r.product_id] = Number(r.qty); });

    const rows = [];
    for (const c of counts) {
      const physical = Number(c.physical_qty);
      if (!c.product_id || !Number.isFinite(physical) || physical < 0) continue;
      rows.push({
        location_id,
        product_id: c.product_id,
        system_qty: systemQty[c.product_id] ?? 0,
        physical_qty: physical,
        counted_by: req.user.id
      });
    }
    if (!rows.length) return res.status(400).json({ error: 'No valid counts to save' });

    const { data, error } = await supabase.from('physical_counts').insert(rows).select('id');
    if (error) return res.status(400).json({ error: error.message });

    await supabase.from('activity_log').insert({
      user_id: req.user.id, action: 'physical_count', entity: 'physical_counts', entity_id: null,
      details: { location_id, products_counted: rows.length }
    });

    res.status(201).json({ saved: data.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stock/physical-count/latest[?location_id=xxx]
// The most recent count for each product at each location.
router.get('/physical-count/latest', async (req, res) => {
  try {
    const rows = await fetchAllRows(() => {
      let q = supabase
        .from('physical_counts')
        .select('location_id, product_id, system_qty, physical_qty, difference, counted_by, counted_at')
        .order('counted_at', { ascending: false })
        .order('id');
      if (req.query.location_id) q = q.eq('location_id', req.query.location_id);
      return q;
    });
    const seen = new Set();
    const latest = [];
    for (const r of rows) {
      const key = r.location_id + ':' + r.product_id;
      if (!seen.has(key)) { seen.add(key); latest.push(r); }
    }
    res.json(latest);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stock/difference?location_id=xxx  -> full history of counts
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
