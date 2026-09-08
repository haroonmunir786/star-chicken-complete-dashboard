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

router.put('/:id', requireRole('super_admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('locations')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Branches can only be deleted if they have no stock, transfers, or sales
// tied to them — this protects your historical records from disappearing.
router.delete('/:id', requireRole('super_admin'), async (req, res) => {
  const id = req.params.id;
  const [{ count: stockCount }, { count: transferCount }, { count: salesCount }] = await Promise.all([
    supabase.from('stock').select('id', { count: 'exact', head: true }).eq('location_id', id).gt('qty', 0),
    supabase.from('transfers').select('id', { count: 'exact', head: true }).or(`from_location_id.eq.${id},to_location_id.eq.${id}`),
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('location_id', id)
  ]);

  if (stockCount || transferCount || salesCount) {
    return res.status(400).json({
      error: 'Cannot delete a branch that has stock, transfers, or sales history. Contact support if this branch is permanently closing.'
    });
  }

  const { error } = await supabase.from('locations').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
