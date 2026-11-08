-- Fase 3: plano, almacén y escandallos, fidelización y cupones, copias de seguridad e idiomas.

-- ---------- Plano del local ----------
alter table tables add column pos_x integer;         -- posición en % del ancho del plano (0-100)
alter table tables add column pos_y integer;         -- posición en % del alto del plano (0-100)
alter table tables add column shape text not null default 'square' check (shape in ('square','round','rect'));

-- ---------- Idiomas ----------
alter table categories add column translations jsonb not null default '{}'::jsonb;

-- ---------- Almacén ----------
-- Cada artículo se guarda en su unidad. Un envase (p. ej. botella = 0,7 l) permite que las recetas
-- usen ml aunque el stock se cuente en unidades.
create table stock_items (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  product_id       uuid references products(id) on delete set null,   -- artículo de la carta que se vende tal cual
  name             text not null,
  unit             text not null check (unit in ('ud','kg','g','l','ml')),
  pack_qty         numeric(12,4),                                       -- contenido de 1 ud (solo si unit = 'ud')
  pack_unit        text check (pack_unit in ('kg','g','l','ml')),
  stock            numeric(14,4) not null default 0,
  min_stock        numeric(14,4),
  cost_per_unit    numeric(14,4) not null default 0,                    -- céntimos por unidad del artículo
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  check ((pack_qty is null) = (pack_unit is null)),
  check (pack_qty is null or unit = 'ud')
);
create unique index stock_items_product on stock_items (product_id) where product_id is not null and not archived;

create table stock_movements (
  id               bigserial primary key,
  establishment_id uuid not null references establishments(id) on delete cascade,
  item_id          uuid not null references stock_items(id) on delete cascade,
  kind             text not null check (kind in ('purchase','waste','adjustment','sale','sale_reversal')),
  qty              numeric(14,4) not null,          -- con signo, en la unidad del artículo
  unit_cost        numeric(14,4),                   -- céntimos por unidad (compras)
  supplier         text not null default '',
  reference        text not null default '',
  order_item_id    uuid references order_items(id) on delete set null,
  actor            text not null default '',
  created_at       timestamptz not null default now()
);
create index stock_movements_item on stock_movements (item_id, created_at desc);

-- Escandallo: ingredientes consumidos por cada unidad vendida.
create table recipe_lines (
  product_id uuid not null references products(id) on delete cascade,
  item_id    uuid not null references stock_items(id) on delete cascade,
  qty        numeric(12,4) not null check (qty > 0),
  unit       text not null check (unit in ('ud','kg','g','l','ml')),
  primary key (product_id, item_id)
);

-- ---------- Fidelización ----------
create table customers (
  id                uuid primary key default gen_random_uuid(),
  establishment_id  uuid not null references establishments(id) on delete cascade,
  name              text not null,
  phone             text not null default '',
  email             text not null default '',
  notes             text not null default '',
  points            integer not null default 0,
  marketing_consent boolean not null default false,
  card_token        text not null unique default encode(gen_random_bytes(12), 'hex'),
  created_at        timestamptz not null default now()
);
create unique index customers_phone on customers (establishment_id, phone) where phone <> '';

alter table accounts add column customer_id uuid references customers(id) on delete set null;

create table coupons (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  customer_id      uuid references customers(id) on delete cascade,     -- null = cupón general
  code             text not null,
  description      text not null default '',
  kind             text not null check (kind in ('percent','amount')),
  value            integer not null check (value > 0),                  -- % o céntimos
  min_total_cents  integer not null default 0,
  valid_from       date,
  valid_until      date,
  max_uses         integer,
  uses             integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (establishment_id, code),
  check (kind <> 'percent' or value <= 100)
);

-- Descuento aplicado a una cuenta: reduce el total; no es un cobro.
create table account_discounts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  coupon_id    uuid references coupons(id) on delete set null,
  label        text not null,
  amount_cents integer not null check (amount_cents > 0),
  created_at   timestamptz not null default now(),
  unique (account_id, coupon_id)
);

-- ---------- Copias de seguridad ----------
create table backups (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  kind             text not null check (kind in ('daily','manual','preventive')),
  size_bytes       integer not null,
  summary          jsonb not null,
  data             jsonb not null,
  created_at       timestamptz not null default now()
);
create index backups_est on backups (establishment_id, created_at desc);
