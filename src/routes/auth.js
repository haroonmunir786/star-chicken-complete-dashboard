const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabaseClient');

// GET /api/auth/roster
// Powers the "select account to unlock" screen — no PINs returned.
router.get('/roster', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, role, branch_id')
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/auth/login  { userId, pin }
router.post('/login', async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'userId and pin are required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .eq('active', true)
    .single();

  if (error || !user) return res.status(401).json({ error: 'Account not found' });

  const ok = await bcrypt.compare(String(pin), user.pin_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect PIN' });

  const payload = {
    id: user.id,
    name: user.name,
    role: user.role,
    branch_id: user.branch_id,
    permissions: user.permissions || []
  };

  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });

  await supabase.from('activity_log').insert({
    user_id: user.id,
    action: 'login',
    entity: 'users',
    entity_id: user.id
  });

  res.json({ token, user: payload });
});

module.exports = router;
