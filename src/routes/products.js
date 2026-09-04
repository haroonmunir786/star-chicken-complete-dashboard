const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// GET /api/products
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/products  (system-wide add — Super Admin only)
router.post('/', requireRole('super_admin'), async (req, res) => {
  const { data, error } = await supabase.from('products').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // If an initial quantity was supplied, seed it into the Slaughter House
  if (req.body.initial_qty && req.body.warehouse_id) {
    await supabase.from('stock').insert({
      location_id: req.body.warehouse_id,
      product_id: data.id,
      qty: req.body.initial_qty
    });
  }

  await supabase.from('activity_log').insert({
    user_id: req.user.id, action: 'create_product', entity: 'products', entity_id: data.id
  });

  res.status(201).json(data);
});

// PUT /api/products/:id  (system-wide edit — Super Admin only)
router.put('/:id', requireRole('super_admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .update({ ...req.body, updated_at: new Date() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('activity_log').insert({
    user_id: req.user.id, action: 'update_product', entity: 'products', entity_id: data.id, details: req.body
  });

  res.json(data);
});

// DELETE /api/products/:id (soft delete)
router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  const { error } = await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
