-- =========================================================
-- Star Chicken — Supabase / Postgres schema
-- Run this once in Supabase SQL Editor (Project > SQL Editor > New query)
-- =========================================================

create extension if not exists pgcrypto;

-- ========= ENUM TYPES =========
create type location_type as enum ('warehouse', 'branch');
create type transfer_type as enum ('sh_to_branch', 'b2b');
create type transfer_status as enum ('pending', 'completed', 'cancelled', 'rejected');
create type request_status as enum ('pending', 'approved', 'rejected', 'completed');
create type user_role as enum (
  'super_admin',
  'all_branches_manager',
  'branch_manager',
  'sales_staff',
  'main_store_manager',
  'mini_store_manager'
);

-- ========= LOCATIONS (Slaughter House + Branches) =========
create table locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type location_type not null,
  address text,
  created_at timestamptz default now()
);

-- ========= USERS (PIN login, module access) =========
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role user_role not null,
  pin_hash text not null,
  branch_id uuid references locations(id),
  permissions jsonb default '[]'::jsonb,   -- e.g. ["dashboard","transfers","reports"]
  active boolean default true,
  created_at timestamptz default now()
);

-- ========= PRODUCTS =========
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text,
  barcode text,
  category text,
  unit text default 'KG',
  purchase_price numeric(12,2) default 0,
  selling_price numeric(12,2) default 0,
  min_stock numeric(12,2) default 20,
  batch text,
  expiry date,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ========= STOCK (one row per product per location) =========
create table stock (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  product_id uuid not null references products(id),
  qty numeric(12,2) not null default 0,
  updated_at timestamptz default now(),
  unique (location_id, product_id)
);

-- ========= TRANSFERS (SH -> Branch or Branch -> Branch) =========
create table transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_no serial,
  type transfer_type not null,
  from_location_id uuid not null references locations(id),
  to_location_id uuid not null references locations(id),
  status transfer_status not null default 'pending',
  remarks text,
  receiver_remarks text,
  created_by uuid references users(id),
  received_by uuid references users(id),
  created_at timestamptz default now(),
  received_at timestamptz
);

create table transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  unit text,
  qty_sent numeric(12,2) not null,
  qty_received numeric(12,2)
);

-- ========= STOCK REQUESTS (Branch -> Slaughter House demand) =========
create table stock_requests (
  id uuid primary key default gen_random_uuid(),
  request_no serial,
  branch_id uuid not null references locations(id),
  status request_status not null default 'pending',
  requested_by uuid references users(id),
  reviewed_by uuid references users(id),
  created_at timestamptz default now(),
  reviewed_at timestamptz
);

create table stock_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references stock_requests(id) on delete cascade,
  product_id uuid not null references products(id),
  qty_requested numeric(12,2) not null,
  qty_approved numeric(12,2)
);

-- ========= CUSTOMERS =========
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  created_at timestamptz default now()
);

-- ========= SALES / INVOICES =========
create table sales (
  id uuid primary key default gen_random_uuid(),
  invoice_no serial,
  location_id uuid not null references locations(id),
  customer_id uuid references customers(id),
  payment_method text default 'Cash',
  subtotal numeric(12,2) default 0,
  tax numeric(12,2) default 0,
  grand_total numeric(12,2) default 0,
  created_by uuid references users(id),
  created_at timestamptz default now()
);

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  product_id uuid not null references products(id),
  qty numeric(12,2) not null,
  weight numeric(12,2),
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null
);

-- ========= PHYSICAL STOCK COUNTS (difference tracking) =========
create table physical_counts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id),
  product_id uuid not null references products(id),
  system_qty numeric(12,2) not null,
  physical_qty numeric(12,2) not null,
  difference numeric(12,2) generated always as (physical_qty - system_qty) stored,
  counted_by uuid references users(id),
  counted_at timestamptz default now()
);

-- ========= ACTIVITY LOG (full audit trail) =========
create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  action text not null,
  entity text,
  entity_id uuid,
  details jsonb,
  created_at timestamptz default now()
);

-- =========================================================
-- RPC FUNCTIONS — atomic, multi-table operations
-- Called from the Node backend via supabase.rpc(...)
-- =========================================================

-- Create a transfer + its line items. Stock is NOT moved yet — it
-- moves only when the destination confirms receiving.
create or replace function create_transfer(
  p_type transfer_type,
  p_from uuid,
  p_to uuid,
  p_remarks text,
  p_created_by uuid,
  p_items jsonb -- [{product_id, qty, unit}]
) returns uuid as $$
declare
  v_transfer_id uuid;
  item jsonb;
begin
  insert into transfers (type, from_location_id, to_location_id, remarks, created_by)
  values (p_type, p_from, p_to, p_remarks, p_created_by)
  returning id into v_transfer_id;

  for item in select * from jsonb_array_elements(p_items) loop
    insert into transfer_items (transfer_id, product_id, unit, qty_sent)
    values (
      v_transfer_id,
      (item->>'product_id')::uuid,
      item->>'unit',
      (item->>'qty')::numeric
    );
  end loop;

  insert into activity_log(user_id, action, entity, entity_id, details)
  values (p_created_by, 'create_transfer', 'transfers', v_transfer_id, p_items);

  return v_transfer_id;
end;
$$ language plpgsql;


-- Confirm receiving: deducts source stock, adds destination stock,
-- marks the transfer completed. Runs as one atomic transaction.
create or replace function confirm_receive(
  p_transfer_id uuid,
  p_received_by uuid,
  p_receiver_remarks text,
  p_items jsonb -- [{transfer_item_id, qty_received}]
) returns void as $$
declare
  v_from uuid;
  v_to uuid;
  item jsonb;
  v_product_id uuid;
  v_qty numeric;
begin
  select from_location_id, to_location_id into v_from, v_to
  from transfers where id = p_transfer_id and status = 'pending'
  for update;

  if v_from is null then
    raise exception 'Transfer not found or already processed';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    update transfer_items
      set qty_received = (item->>'qty_received')::numeric
      where id = (item->>'transfer_item_id')::uuid
      returning product_id into v_product_id;

    v_qty := (item->>'qty_received')::numeric;

    insert into stock (location_id, product_id, qty)
    values (v_from, v_product_id, -v_qty)
    on conflict (location_id, product_id)
    do update set qty = stock.qty - v_qty, updated_at = now();

    insert into stock (location_id, product_id, qty)
    values (v_to, v_product_id, v_qty)
    on conflict (location_id, product_id)
    do update set qty = stock.qty + v_qty, updated_at = now();
  end loop;

  update transfers
    set status = 'completed',
        received_by = p_received_by,
        receiver_remarks = p_receiver_remarks,
        received_at = now()
    where id = p_transfer_id;

  insert into activity_log(user_id, action, entity, entity_id, details)
  values (p_received_by, 'confirm_receive', 'transfers', p_transfer_id, p_items);
end;
$$ language plpgsql;


-- Reject a pending transfer. No stock movement.
create or replace function reject_transfer(p_transfer_id uuid, p_user_id uuid, p_remarks text)
returns void as $$
begin
  update transfers
    set status = 'rejected',
        receiver_remarks = p_remarks,
        received_at = now(),
        received_by = p_user_id
    where id = p_transfer_id and status = 'pending';

  insert into activity_log(user_id, action, entity, entity_id, details)
  values (p_user_id, 'reject_transfer', 'transfers', p_transfer_id, jsonb_build_object('remarks', p_remarks));
end;
$$ language plpgsql;


-- Create a sale: deducts branch stock immediately (point-of-sale),
-- inserts sale + line items, computes totals.
create or replace function create_sale(
  p_location_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_created_by uuid,
  p_items jsonb -- [{product_id, qty, weight, unit_price}]
) returns uuid as $$
declare
  v_sale_id uuid;
  item jsonb;
  v_subtotal numeric := 0;
  v_line_total numeric;
  v_current_qty numeric;
begin
  insert into sales (location_id, customer_id, payment_method, created_by)
  values (p_location_id, p_customer_id, p_payment_method, p_created_by)
  returning id into v_sale_id;

  for item in select * from jsonb_array_elements(p_items) loop
    v_line_total := (item->>'qty')::numeric * (item->>'unit_price')::numeric;
    v_subtotal := v_subtotal + v_line_total;

    select qty into v_current_qty from stock
      where location_id = p_location_id and product_id = (item->>'product_id')::uuid
      for update;

    if v_current_qty is null or v_current_qty < (item->>'qty')::numeric then
      raise exception 'Insufficient stock for product %', item->>'product_id';
    end if;

    update stock set qty = qty - (item->>'qty')::numeric, updated_at = now()
      where location_id = p_location_id and product_id = (item->>'product_id')::uuid;

    insert into sale_items (sale_id, product_id, qty, weight, unit_price, line_total)
    values (
      v_sale_id,
      (item->>'product_id')::uuid,
      (item->>'qty')::numeric,
      nullif(item->>'weight','')::numeric,
      (item->>'unit_price')::numeric,
      v_line_total
    );
  end loop;

  update sales set subtotal = v_subtotal, grand_total = v_subtotal where id = v_sale_id;

  insert into activity_log(user_id, action, entity, entity_id, details)
  values (p_created_by, 'create_sale', 'sales', v_sale_id, p_items);

  return v_sale_id;
end;
$$ language plpgsql;


-- Approve a stock request and immediately create the matching transfer
-- from the Slaughter House to the requesting branch.
create or replace function approve_stock_request(
  p_request_id uuid,
  p_reviewed_by uuid,
  p_warehouse_id uuid,
  p_items jsonb -- [{product_id, qty_approved, unit}]
) returns uuid as $$
declare
  v_branch_id uuid;
  v_transfer_id uuid;
begin
  select branch_id into v_branch_id from stock_requests where id = p_request_id;

  update stock_requests
    set status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
    where id = p_request_id;

  update stock_request_items sri
    set qty_approved = (i->>'qty_approved')::numeric
    from jsonb_array_elements(p_items) i
    where sri.request_id = p_request_id
      and sri.product_id = (i->>'product_id')::uuid;

  v_transfer_id := create_transfer(
    'sh_to_branch'::transfer_type,
    p_warehouse_id,
    v_branch_id,
    'Auto-created from stock request',
    p_reviewed_by,
    p_items
  );

  update stock_requests set status = 'completed' where id = p_request_id;

  return v_transfer_id;
end;
$$ language plpgsql;

-- ========= INDEXES =========
create index idx_stock_location on stock(location_id);
create index idx_stock_product on stock(product_id);
create index idx_transfers_status on transfers(status);
create index idx_transfers_from on transfers(from_location_id);
create index idx_transfers_to on transfers(to_location_id);
create index idx_sales_location on sales(location_id);
create index idx_sales_created_at on sales(created_at);
create index idx_sale_items_sale on sale_items(sale_id);
create index idx_activity_log_entity on activity_log(entity, entity_id);
