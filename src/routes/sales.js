const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/sales?location_id=xxx&date=2026-09-04
router.get('/', async (req, res) => {
  let query = supabase
    .from('sales')
    .select(`
      *,
      items:sale_items(*, product:products(name, unit)),
      customer:customers(name, phone),
      location:locations(name)
    `)
    .order('created_at', { ascending: false });

  if (req.query.location_id) query = query.eq('location_id', req.query.location_id);
  if (req.query.date) {
    query = query
      .gte('created_at', `${req.query.date}T00:00:00`)
      .lte('created_at', `${req.query.date}T23:59:59`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/sales
// { location_id, customer_id, payment_method, items:[{product_id, qty, weight, unit_price}] }
router.post('/', async (req, res) => {
  const { location_id, customer_id, payment_method, items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

  const { data, error } = await supabase.rpc('create_sale', {
    p_location_id: location_id,
    p_customer_id: customer_id || null,
    p_payment_method: payment_method || 'Cash',
    p_created_by: req.user.id,
    p_items: items
  });

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ id: data });
});

module.exports = router;
