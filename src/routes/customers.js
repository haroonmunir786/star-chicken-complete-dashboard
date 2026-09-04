const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/customers  -> includes purchase summary (times bought, total spent)
router.get('/', async (req, res) => {
  const { data: customers, error } = await supabase.from('customers').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });

  const { data: sales } = await supabase
    .from('sales')
    .select('customer_id, grand_total, created_at');

  const summary = customers.map(c => {
    const theirSales = (sales || []).filter(s => s.customer_id === c.id);
    return {
      ...c,
      times_purchased: theirSales.length,
      total_spent: theirSales.reduce((sum, s) => sum + Number(s.grand_total || 0), 0),
      last_purchase: theirSales.length
        ? theirSales.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at
        : null
    };
  });

  res.json(summary);
});

router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('customers').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
