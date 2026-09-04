const router = require('express').Router();
const bcrypt = require('bcryptjs');
const supabase = require('../supabaseClient');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('super_admin'));

// GET /api/employees  (PINs never returned)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, role, branch_id, permissions, active, created_at, branch:locations(name)')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/employees  { name, role, pin, branch_id, permissions }
router.post('/', async (req, res) => {
  const { name, role, pin, branch_id, permissions } = req.body;
  if (!pin || pin.length !== 4) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const pin_hash = await bcrypt.hash(String(pin), 10);
  const { data, error } = await supabase
    .from('users')
    .insert({ name, role, pin_hash, branch_id: branch_id || null, permissions: permissions || [] })
    .select('id, name, role, branch_id, permissions, active')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/employees/:id  (any field, pin optional — only re-hash if provided)
router.put('/:id', async (req, res) => {
  const updates = { ...req.body };
  if (updates.pin) {
    updates.pin_hash = await bcrypt.hash(String(updates.pin), 10);
    delete updates.pin;
  }

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.params.id)
    .select('id, name, role, branch_id, permissions, active')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/employees/:id  (soft delete / deactivate)
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('users').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
