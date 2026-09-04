const router = require('express').Router();
const supabase = require('../supabaseClient');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// GET /api/branches           -> everything (warehouse + branches)
// GET /api/branches?type=branch
router.get('/', async (req, res) => {
  let query = supabase.from('locations').select('*').order('name');
  if (req.query.type) query = query.eq('type', req.query.type);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('locations').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

router.post('/', requireRole('super_admin'), async (req, res) => {
  const { data, error } = await supabase.from('locations').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
