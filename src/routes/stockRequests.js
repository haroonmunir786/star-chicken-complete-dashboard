const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/stock-requests?status=Pending&branch_id=xxx
router.get('/', async (req, res) => {
  let query = supabase
    .from('stock_requests')
    .select('*, items:stock_request_items(*, product:products(name, unit)), branch:locations(name)')
    .order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.branch_id) query = query.eq('branch_id', req.query.branch_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/stock-requests   { branch_id, items:[{product_id, qty_requested}] }
router.post('/', async (req, res) => {
  const { branch_id, items } = req.body;
  const { data: request, error } = await supabase
    .from('stock_requests')
    .insert({ branch_id, requested_by: req.user.id })
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

  res.status(201).json(request);
});

// POST /api/stock-requests/:id/approve
// { warehouse_id, items: [{product_id, qty_approved, unit}] }
router.post('/:id/approve', async (req, res) => {
  const { warehouse_id, items } = req.body;
  const { data, error } = await supabase.rpc('approve_stock_request', {
    p_request_id: req.params.id,
    p_reviewed_by: req.user.id,
    p_warehouse_id: warehouse_id,
    p_items: items
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ transfer_id: data });
});

// POST /api/stock-requests/:id/reject
router.post('/:id/reject', async (req, res) => {
  const { error } = await supabase
    .from('stock_requests')
    .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date() })
    .eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
