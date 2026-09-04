// Run once after applying sql/schema.sql:
//   npm run seed:admin
// Creates the Slaughter House location and the first Super Admin
// (name/PIN taken from SEED_ADMIN_NAME / SEED_ADMIN_PIN in .env)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const supabase = require('../src/supabaseClient');

async function main() {
  const name = process.env.SEED_ADMIN_NAME || 'Admin';
  const pin = process.env.SEED_ADMIN_PIN || '1234';

  console.log('Creating Slaughter House location...');
  const { data: warehouse, error: whErr } = await supabase
    .from('locations')
    .insert({ name: 'Slaughter House', type: 'warehouse' })
    .select()
    .single();
  if (whErr) throw whErr;
  console.log('  -> id:', warehouse.id);

  console.log('Creating Super Admin user...');
  const pin_hash = await bcrypt.hash(String(pin), 10);
  const { data: admin, error: userErr } = await supabase
    .from('users')
    .insert({
      name,
      role: 'super_admin',
      pin_hash,
      permissions: ['*']
    })
    .select()
    .single();
  if (userErr) throw userErr;

  console.log('\nDone!');
  console.log(`  Super Admin: ${admin.name}  (id: ${admin.id})`);
  console.log(`  Login PIN: ${pin}`);
  console.log(`  Slaughter House id: ${warehouse.id}`);
  console.log('\nSave the Slaughter House id somewhere — you will use it as the');
  console.log('warehouse_id when creating products / approving stock requests.');
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
