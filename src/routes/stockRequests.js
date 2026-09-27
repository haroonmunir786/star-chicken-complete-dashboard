const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/stock-requests?status=pending&branch_id=xxx
router.get('/', async (req, res) => {
  let query = supabase
    .from('stock_requests')
    .select(`
      *,
      items:stock_request_items(*, product:products(name, unit)),
      branch:locations(name),
      requester:users!stock_requests_requested_by_fkey(name),
      reviewer:users!stock_requests_reviewed_by_fkey(name)
    `)
    .order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.branch_id) query = query.eq('branch_id', req.query.branch_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/stock-requests
// { branch_id, remarks, items:[{product_id, qty_requested}] }
router.post('/', async (req, res) => {
  const { branch_id, remarks, items } = req.body;
  if (!items || !items.length) {
    return res.status(400).json({ error: 'At least one item is required' });
  }

  const { data: request, error } = await supabase
    .from('stock_requests')
    .insert({ branch_id, remarks: remarks || null, requested_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const rows = items.map(i => ({
    request_id: request.id,
    product_id: i.product_id,
    qty_requested: i.qty_requested
  }));
  const { error: itemErr } = await supabase.from('stock_request_items').insert(rows);
  if (itemErr) return res.status(400).json({ error: itemErr.message });

  await supabase.from('activity_log').insert({
    user_id: req.user.id,
    action: 'create_stock_request',
    entity: 'stock_requests',
    entity_id: request.id,
    details: { branch_id, items }
  });

  res.status(201).json(request);
});

// PUT /api/stock-requests/:id  -- edit a still-pending request
// { remarks, items:[{product_id, qty_requested}] }
router.put('/:id', async (req, res) => {
  const { remarks, items } = req.body;

  const { data: existing } = await supabase
    .from('stock_requests')
    .select('status')
    .eq('id', req.params.id)
    .single();

  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (existing.status !== 'pending') {
    return res.status(400).json({ error: 'Only pending requests can be edited' });
  }

  const { error: updErr } = await supabase
    .from('stock_requests')
    .update({ remarks: remarks || null })
    .eq('id', req.params.id);
  if (updErr) return res.status(400).json({ error: updErr.message });

  // Replace the line items wholesale -- simplest correct behaviour for an edit
  await supabase.from('stock_request_items').delete().eq('request_id', req.params.id);
  const rows = (items || []).map(i => ({
    request_id: req.params.id,
    product_id: i.product_id,
    qty_requested: i.qty_requested
  }));
  if (rows.length) {
    const { error: itemErr } = await supabase.from('stock_request_items').insert(rows);
    if (itemErr) return res.status(400).json({ error: itemErr.message });
  }

  res.json({ ok: true });
});

// DELETE /api/stock-requests/:id -- only while still pending
router.delete('/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('stock_requests')
    .select('status')
    .eq('id', req.params.id)
    .single();

  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (existing.status !== 'pending') {
    return res.status(400).json({ error: 'Only pending requests can be deleted' });
  }

  const { error } = await supabase.from('stock_requests').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

// POST /api/stock-requests/:id/approve
// { warehouse_id, admin_notes, items: [{product_id, qty_approved, qty, unit}] }
router.post('/:id/approve', async (req, res) => {
  const { warehouse_id, admin_notes, items } = req.body;
  if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id is required' });
  if (!items || !items.length) {
    return res.status(400).json({ error: 'At least one approved item is required' });
  }

  const { data, error } = await supabase.rpc('approve_stock_request', {
    p_request_id: req.params.id,
    p_reviewed_by: req.user.id,
    p_warehouse_id: warehouse_id,
    p_admin_notes: admin_notes || null,
    p_items: items
  });
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('activity_log').insert({
    user_id: req.user.id,
    action: 'approve_stock_request',
    entity: 'stock_requests',
    entity_id: req.params.id,
    details: { transfer_id: data, items }
  });

  res.json({ transfer_id: data });
});

// POST /api/stock-requests/:id/reject   { admin_notes }
router.post('/:id/reject', async (req, res) => {
  const { error } = await supabase
    .from('stock_requests')
    .update({
      status: 'rejected',
      reviewed_by: req.user.id,
      reviewed_at: new Date(),
      admin_notes: req.body.admin_notes || null
    })
    .eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('activity_log').insert({
    user_id: req.user.id,
    action: 'reject_stock_request',
    entity: 'stock_requests',
    entity_id: req.params.id,
    details: { admin_notes: req.body.admin_notes || null }
  });

  res.json({ ok: true });
});

module.exports = router;
