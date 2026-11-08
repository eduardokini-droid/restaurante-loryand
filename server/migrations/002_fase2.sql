-- Fase 2: menú del día, reservas, lista de espera, uniones de mesas y factura completa.

-- ---------- Menú del día ----------
create table daily_menus (
  establishment_id uuid primary key references establishments(id) on delete cascade,
  name             text not null default 'Menú del día',
  price_cents      integer not null check (price_cents > 0),
  vat_rate         numeric(4,2) not null default 10.00,
  -- { first: [], second: [], dessert: [], drink: [], coffee: [] }
  sections         jsonb not null,
  active           boolean not null default false,
  updated_at       timestamptz not null default now()
);

-- Línea de cabecera del menú (lleva el precio, no va a cocina ni barra) y sus componentes (precio 0).
alter table order_items drop constraint order_items_destination_check;
alter table order_items add constraint order_items_destination_check check (destination in ('kitchen','bar','none'));
alter table order_items add column parent_item_id uuid references order_items(id) on delete cascade;

-- ---------- Uniones de mesas ----------
-- Las mesas con la misma etiqueta de unión se tratan como una sola para la lista de espera y suman plazas.
alter table tables add column join_group text;

-- ---------- Reservas ----------
create table reservations (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  name             text not null,
  phone            text not null default '',
  email            text not null default '',
  party_size       integer not null check (party_size between 1 and 100),
  starts_at        timestamptz not null,
  duration_min     integer not null default 90 check (duration_min between 15 and 600),
  notes            text not null default '',
  zone_pref        text,
  table_ids        uuid[] not null default '{}',
  status           text not null default 'requested'
                   check (status in ('requested','confirmed','seated','finished','cancelled','no_show')),
  deposit_cents    integer not null default 0,
  deposit_status   text not null default 'none' check (deposit_status in ('none','pending','paid','refunded')),
  source           text not null default 'staff' check (source in ('staff','public')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index reservations_day on reservations (establishment_id, starts_at);

-- ---------- Lista de espera presencial ----------
create table waitlist (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  name             text not null,
  party_size       integer not null check (party_size between 1 and 100),
  phone            text not null default '',
  zone_pref        text,
  status           text not null default 'waiting' check (status in ('waiting','notified','seated','cancelled','no_show')),
  table_ids        uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  notified_at      timestamptz,
  seated_at        timestamptz,
  closed_at        timestamptz
);
create index waitlist_active on waitlist (establishment_id, created_at) where status in ('waiting','notified');

-- Historial de ocupación física: base para estimar cuánto tarda en quedar libre una mesa.
create table table_occupancy (
  id         bigserial primary key,
  table_id   uuid not null references tables(id) on delete cascade,
  seats      integer not null,
  started_at timestamptz not null,
  ended_at   timestamptz
);
create unique index table_occupancy_open on table_occupancy (table_id) where ended_at is null;

-- ---------- Factura completa ----------
alter table documents add column replaces_id uuid references documents(id);
