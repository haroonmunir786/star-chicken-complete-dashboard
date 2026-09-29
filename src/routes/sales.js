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

  // Link this sale to a real customer record, matched by phone number
  // (the reliable identifier) rather than the typed name. If no customer
  // with this phone exists yet, one is created automatically -- this is
  // what makes "times purchased" / "total spent" accurate per customer
  // instead of relying on exact name-text matches.
  let resolvedCustomerId = customer_id || null;
  if (!resolvedCustomerId && customer_phone) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', customer_phone)
      .maybeSingle();

    if (existing) {
      resolvedCustomerId = existing.id;
    } else {
      const { data: created, error: custErr } = await supabase
        .from('customers')
        .insert({ name: customer_name || 'Walk-in', phone: customer_phone })
        .select('id')
        .single();
      if (!custErr) resolvedCustomerId = created.id;
      // If customer creation fails for any reason, we still proceed with
      // the sale below -- customer_name/customer_phone are saved directly
      // on the sale either way, so nothing is lost.
    }
  }

  const { data: saleId, error } = await supabase.rpc('create_sale', {
    p_location_id: location_id,
    p_customer_id: resolvedCustomerId,
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
