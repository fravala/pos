-- ============================================================================
-- POS SaaS Multi-Tenant — Schema completo + RLS + Vistas + Triggers
-- Auth custom (NO GoTrue). RLS lee claims de current_setting('request.jwt.claims')
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. TENANTS / LOCATIONS / BOT
-- ============================================================================

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  logo_url text,
  whatsapp_number varchar(20),
  description text,
  settings jsonb not null default '{}'::jsonb, -- business_hours, social, etc.
  created_at timestamptz not null default now()
);

create table bot_instances (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  phone_number varchar(20) not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 2. USERS (auth custom)
-- ============================================================================

create type user_role as enum ('SUPERADMIN', 'ADMIN', 'CASHIER');

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,       -- null si SUPERADMIN
  location_id uuid references locations(id) on delete cascade,   -- null si ADMIN global de tenant
  role user_role not null default 'CASHIER',
  username text not null unique,
  password_hash text not null,
  status text not null default 'ACTIVE', -- ACTIVE / DISABLED
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 3. INVENTARIO HÍBRIDO / ESCANDALLO
-- ============================================================================

create type restock_mode as enum ('VENDOR_ROUTE', 'SELF_PURCHASE');

create table vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  contact_info jsonb default '{}'::jsonb
);

create table inventory_catalog (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  image_url text,
  description text,
  restock_mode restock_mode not null default 'SELF_PURCHASE',
  vendor_id uuid references vendors(id),
  self_purchase_lead_time int, -- días
  unit_measurement text not null default 'unit', -- kg, lt, unit, etc
  unit_cost numeric(12,4) not null default 0,
  created_at timestamptz not null default now()
);

create table inventory_stock (
  catalog_id uuid not null references inventory_catalog(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  current_stock numeric(12,4) not null default 0, -- puede ser negativo (soft limit)
  safety_stock numeric(12,4) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (catalog_id, location_id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  image_url text,
  base_price numeric(12,2) not null,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table recipes_bom (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  ingredient_id uuid not null references inventory_catalog(id) on delete cascade,
  quantity_to_deduct numeric(12,4) not null
);

-- ============================================================================
-- 4. ORDERS / ORDER_ITEMS (modificadores dinámicos)
-- ============================================================================

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  cash_session_id uuid, -- fk agregada tras crear cash_sessions
  source text not null default 'POS', -- POS / WEB_CATALOG / WHATSAPP_BOT
  status text not null default 'OPEN', -- OPEN / PAID / CANCELLED
  total numeric(12,2) not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity int not null default 1,
  unit_price numeric(12,2) not null,
  -- modifiers: { "removed_ingredients": ["uuid1"], "added_extras": [{"ingredient_id":"uuid2","qty":1,"extra_price":15}] }
  modifiers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 5. CASH FLOW
-- ============================================================================

create table cash_sessions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  opened_by uuid not null references users(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  status text not null default 'OPEN', -- OPEN / CLOSED
  opening_balance numeric(12,2) not null default 0,
  expected_balance numeric(12,2),
  actual_balance numeric(12,2),
  discrepancy numeric(12,2)
);

alter table orders
  add constraint fk_orders_cash_session
  foreign key (cash_session_id) references cash_sessions(id);

create table cash_transactions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cash_sessions(id) on delete cascade,
  type text not null, -- SALE / WITHDRAWAL / ADDITION
  payment_method text, -- CASH / TRANSFER / CARD
  amount numeric(12,2) not null,
  reference_id uuid, -- order_id si type=SALE
  description text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 6. WEEKLY SALES ANALYTICS (ML output)
-- ============================================================================

create table weekly_sales_analytics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  week_start date not null,
  abc_matrix jsonb not null default '[]'::jsonb,          -- [{product_id, class:'A'|'B'|'C', revenue, margin}]
  cross_selling_combos jsonb not null default '[]'::jsonb, -- [{items:[id1,id2], support, confidence, lift}]
  generated_at timestamptz not null default now(),
  unique (location_id, week_start)
);

create table purchase_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  catalog_id uuid not null references inventory_catalog(id),
  suggested_qty numeric(12,4) not null,
  restock_mode restock_mode not null,
  vendor_id uuid references vendors(id),
  reasoning text,
  status text not null default 'PENDING', -- PENDING / ORDERED / DISMISSED
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 7. VISTA: COSTO DE PRODUCTO
-- ============================================================================

create or replace view view_product_costs as
select
  p.id as product_id,
  p.tenant_id,
  p.name as product_name,
  sum(r.quantity_to_deduct * ic.unit_cost) as total_cost
from products p
join recipes_bom r on r.product_id = p.id
join inventory_catalog ic on ic.id = r.ingredient_id
group by p.id, p.tenant_id, p.name;

-- ============================================================================
-- 8. RLS — helpers para leer JWT claims
-- ============================================================================

create or replace function jwt_tenant_id() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'tenant_id', '')::uuid
$$ language sql stable;

create or replace function jwt_location_id() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'location_id', '')::uuid
$$ language sql stable;

create or replace function jwt_role() returns text as $$
  select current_setting('request.jwt.claims', true)::jsonb->>'user_role'
$$ language sql stable;

-- ============================================================================
-- 9. RLS — activar y políticas
-- ============================================================================

alter table tenants enable row level security;
alter table locations enable row level security;
alter table bot_instances enable row level security;
alter table users enable row level security;
alter table vendors enable row level security;
alter table inventory_catalog enable row level security;
alter table inventory_stock enable row level security;
alter table products enable row level security;
alter table recipes_bom enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table cash_sessions enable row level security;
alter table cash_transactions enable row level security;
alter table weekly_sales_analytics enable row level security;
alter table purchase_suggestions enable row level security;

-- tenants: solo SUPERADMIN ve todos; ADMIN/CASHIER ven el propio
create policy tenants_isolation on tenants
  for all using (
    jwt_role() = 'SUPERADMIN' or id = jwt_tenant_id()
  );

create policy locations_isolation on locations
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy bot_instances_isolation on bot_instances
  for all using (
    jwt_role() = 'SUPERADMIN' or
    location_id in (select id from locations where tenant_id = jwt_tenant_id())
  );

create policy users_isolation on users
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy vendors_isolation on vendors
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy inventory_catalog_isolation on inventory_catalog
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy inventory_stock_isolation on inventory_stock
  for all using (
    jwt_role() = 'SUPERADMIN' or
    location_id in (select id from locations where tenant_id = jwt_tenant_id())
  );

create policy products_isolation on products
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy recipes_bom_isolation on recipes_bom
  for all using (
    jwt_role() = 'SUPERADMIN' or
    product_id in (select id from products where tenant_id = jwt_tenant_id())
  );

-- orders: ADMIN ve todas las locations del tenant; CASHIER solo su location
create policy orders_isolation on orders
  for all using (
    jwt_role() = 'SUPERADMIN'
    or (jwt_role() = 'ADMIN' and tenant_id = jwt_tenant_id())
    or (jwt_role() = 'CASHIER' and location_id = jwt_location_id())
  );

create policy order_items_isolation on order_items
  for all using (
    jwt_role() = 'SUPERADMIN' or
    order_id in (
      select id from orders o where
        (jwt_role() = 'ADMIN' and o.tenant_id = jwt_tenant_id())
        or (jwt_role() = 'CASHIER' and o.location_id = jwt_location_id())
    )
  );

create policy cash_sessions_isolation on cash_sessions
  for all using (
    jwt_role() = 'SUPERADMIN'
    or (jwt_role() = 'ADMIN' and location_id in (select id from locations where tenant_id = jwt_tenant_id()))
    or (jwt_role() = 'CASHIER' and location_id = jwt_location_id())
  );

create policy cash_transactions_isolation on cash_transactions
  for all using (
    jwt_role() = 'SUPERADMIN' or
    session_id in (
      select id from cash_sessions cs where
        (jwt_role() = 'ADMIN' and cs.location_id in (select id from locations where tenant_id = jwt_tenant_id()))
        or (jwt_role() = 'CASHIER' and cs.location_id = jwt_location_id())
    )
  );

create policy weekly_sales_analytics_isolation on weekly_sales_analytics
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

create policy purchase_suggestions_isolation on purchase_suggestions
  for all using (
    jwt_role() = 'SUPERADMIN' or tenant_id = jwt_tenant_id()
  );

-- ============================================================================
-- 10. TRIGGER: deducción de inventario al insertar order_item
--     (respeta removed_ingredients / added_extras, permite stock negativo)
-- ============================================================================

create or replace function fn_deduct_inventory() returns trigger as $$
declare
  v_order_location uuid;
  v_removed uuid[];
  v_extra jsonb;
  r record;
begin
  select location_id into v_order_location from orders where id = new.order_id;

  select coalesce(array_agg((elem)::uuid), '{}')
    into v_removed
    from jsonb_array_elements_text(coalesce(new.modifiers->'removed_ingredients', '[]'::jsonb)) elem;

  -- deducción base según receta, saltando ingredientes removidos
  for r in
    select ingredient_id, quantity_to_deduct
    from recipes_bom
    where product_id = new.product_id
      and ingredient_id <> all(v_removed)
  loop
    insert into inventory_stock (catalog_id, location_id, current_stock)
    values (r.ingredient_id, v_order_location, -1 * r.quantity_to_deduct * new.quantity)
    on conflict (catalog_id, location_id)
    do update set current_stock = inventory_stock.current_stock - (r.quantity_to_deduct * new.quantity),
                  updated_at = now();
  end loop;

  -- deducción de extras añadidos
  for v_extra in
    select * from jsonb_array_elements(coalesce(new.modifiers->'added_extras', '[]'::jsonb))
  loop
    insert into inventory_stock (catalog_id, location_id, current_stock)
    values (
      (v_extra->>'ingredient_id')::uuid,
      v_order_location,
      -1 * coalesce((v_extra->>'qty')::numeric, 1) * new.quantity
    )
    on conflict (catalog_id, location_id)
    do update set current_stock = inventory_stock.current_stock - (coalesce((v_extra->>'qty')::numeric, 1) * new.quantity),
                  updated_at = now();
  end loop;

  return new;
end;
$$ language plpgsql;

create trigger trg_deduct_inventory
  after insert on order_items
  for each row execute function fn_deduct_inventory();

-- ============================================================================
-- 11. TRIGGER: Corte de caja — recalcular expected_balance al cerrar sesión
-- ============================================================================

create or replace function fn_close_cash_session() returns trigger as $$
declare
  v_sales numeric(12,2);
  v_additions numeric(12,2);
  v_withdrawals numeric(12,2);
begin
  if new.status = 'CLOSED' and old.status = 'OPEN' then
    select coalesce(sum(amount),0) into v_sales from cash_transactions
      where session_id = new.id and type = 'SALE' and payment_method = 'CASH';
    select coalesce(sum(amount),0) into v_additions from cash_transactions
      where session_id = new.id and type = 'ADDITION';
    select coalesce(sum(amount),0) into v_withdrawals from cash_transactions
      where session_id = new.id and type = 'WITHDRAWAL';

    new.expected_balance := new.opening_balance + v_sales + v_additions - v_withdrawals;
    new.discrepancy := coalesce(new.actual_balance, 0) - new.expected_balance;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_close_cash_session
  before update on cash_sessions
  for each row execute function fn_close_cash_session();

-- ============================================================================
-- Indexes de soporte
-- ============================================================================

create index idx_locations_tenant on locations(tenant_id);
create index idx_users_tenant on users(tenant_id);
create index idx_inventory_catalog_tenant on inventory_catalog(tenant_id);
create index idx_products_tenant on products(tenant_id);
create index idx_orders_tenant_location on orders(tenant_id, location_id);
create index idx_order_items_order on order_items(order_id);
create index idx_cash_sessions_location on cash_sessions(location_id);
create index idx_weekly_analytics_location_week on weekly_sales_analytics(location_id, week_start);
