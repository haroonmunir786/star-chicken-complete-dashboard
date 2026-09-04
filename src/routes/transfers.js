const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/transfers?status=Pending&location_id=xxx
router.get('/', async (req, res) => {
  let query = supabase
    .from('transfers')
    .select(`
      *,
      items:transfer_items(*, product:products(name, unit)),
      from_location:locations!transfers_from_location_id_fkey(name),
      to_location:locations!transfers_to_location_id_fkey(name)
    `)
    .order('created_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.location_id) {
    query = query.or(
      `from_location_id.eq.${req.query.location_id},to_location_id.eq.${req.query.location_id}`
    );
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/transfers
// { type: 'sh_to_branch'|'b2b', from_location_id, to_location_id, remarks, items:[{product_id, qty, unit}] }
router.post('/', async (req, res) => {
  const { type, from_location_id, to_location_id, remarks, items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

  const { data, error } = await supabase.rpc('create_transfer', {
    p_type: type,
    p_from: from_location_id,
    p_to: to_location_id,
    p_remarks: remarks || null,
    p_created_by: req.user.id,
    p_items: items
  });

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ id: data });
});

// POST /api/transfers/:id/receive
// { receiver_remarks, items: [{transfer_item_id, qty_received}] }
router.post('/:id/receive', async (req, res) => {
  const { receiver_remarks, items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items are required' });

  const { error } = await supabase.rpc('confirm_receive', {
    p_transfer_id: req.params.id,
    p_received_by: req.user.id,
    p_receiver_remarks: receiver_remarks || null,
    p_items: items
  });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/transfers/:id/reject   { remarks }
router.post('/:id/reject', async (req, res) => {
  const { error } = await supabase.rpc('reject_transfer', {
    p_transfer_id: req.params.id,
    p_user_id: req.user.id,
    p_remarks: req.body.remarks || null
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
