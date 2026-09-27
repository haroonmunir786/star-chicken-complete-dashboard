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
      location:locations(name),
      creator:users!sales_created_by_fkey(name)
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
// { location_id, customer_id, customer_name, customer_phone, payment_method,
//   discount, amount_paid, items:[{product_id, qty, weight, unit_price}] }
router.post('/', async (req, res) => {
  const {
    location_id, customer_id, customer_name, customer_phone,
    payment_method, discount, amount_paid, items
  } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'At least one item is required' });

  const { data: saleId, error } = await supabase.rpc('create_sale', {
    p_location_id: location_id,
    p_customer_id: customer_id || null,
    p_customer_name: customer_name || null,
    p_customer_phone: customer_phone || null,
    p_payment_method: payment_method || 'Cash',
    p_discount: discount || 0,
    p_amount_paid: amount_paid || 0,
    p_created_by: req.user.id,
    p_items: items
  });

  if (error) return res.status(400).json({ error: error.message });

  const { data: sale } = await supabase
    .from('sales')
    .select('id, invoice_no, grand_total')
    .eq('id', saleId)
    .single();

  res.status(201).json(sale || { id: saleId });
});

module.exports = router;
