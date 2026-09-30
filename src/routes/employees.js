const router = require('express').Router();
const bcrypt = require('bcryptjs');
const supabase = require('../supabaseClient');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('super_admin'));

// PINs are hashed and cannot be reversed or compared as plain text — the
// only way to check "is this PIN already used by someone else" is to test
// it against every existing hash with bcrypt.compare. Fine at this scale
// (a handful to a few dozen staff).
async function findPinOwner(pin, excludeUserId) {
  let query = supabase.from('users').select('id, name, pin_hash').eq('active', true);
  if (excludeUserId) query = query.neq('id', excludeUserId);
  const { data: users } = await query;
  for (const u of users || []) {
    if (await bcrypt.compare(String(pin), u.pin_hash)) return u;
  }
  return null;
}

// GET /api/employees  (PINs never returned)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, role, branch_id, permissions, active, created_at, branch:locations(name)')
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/employees  { name, role, pin, branch_id, permissions }
router.post('/', async (req, res) => {
  const { name, role, pin, branch_id, permissions } = req.body;
  if (!pin || pin.length !== 4) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

  const owner = await findPinOwner(pin);
  if (owner) return res.status(400).json({ error: `This PIN is already used by ${owner.name}. Choose another.` });

  const pin_hash = await bcrypt.hash(String(pin), 10);
  const { data, error } = await supabase
    .from('users')
    .insert({ name, role, pin_hash, branch_id: branch_id || null, permissions: permissions || [] })
    .select('id, name, role, branch_id, permissions, active')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/employees/:id  (any field, pin optional — leave blank to keep current PIN)
router.put('/:id', async (req, res) => {
  const updates = { ...req.body };
  if (updates.pin) {
    if (String(updates.pin).length !== 4) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    const owner = await findPinOwner(updates.pin, req.params.id);
    if (owner) return res.status(400).json({ error: `This PIN is already used by ${owner.name}. Choose another.` });
    updates.pin_hash = await bcrypt.hash(String(updates.pin), 10);
  }
  delete updates.pin;

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
