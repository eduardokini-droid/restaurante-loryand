-- Restaurante Loryand · esquema base (fase 1)
-- Importes siempre en céntimos (integer) para evitar errores de redondeo.

create extension if not exists pgcrypto;

create table establishments (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  legal_name    text not null default '',
  tax_id        text not null default '',
  phone         text not null default '',
  email         text not null default '',
  address       text not null default '',
  postal_code   text not null default '',
  city          text not null default '',
  province      text not null default '',
  -- Funciones contratadas (módulos visibles en la navegación).
  features      text[] not null default array['tpv','pda','kitchen','bar','menu','tables','cash']::text[],
  -- Ajustes operativos: mesas compartidas, bloqueo de cobro, etc.
  settings      jsonb not null default '{"sharedTables": true, "blockPaymentUntilDelivered": true}'::jsonb,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Usuarios del panel: gestor general (establishment_id null), administradores y secundarios.
create table users (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid references establishments(id) on delete cascade,
  username         text not null unique,
  name             text not null,
  password_hash    text not null,
  role             text not null check (role in ('superadmin','admin','staff')),
  permissions      text[] not null default array[]::text[],
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  check ((role = 'superadmin') = (establishment_id is null))
);

-- Camareros: acceso personal por usuario + PIN de 4 a 6 cifras.
-- pin_lookup es un HMAC determinista para garantizar PIN distintos dentro del local.
create table waiters (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  code             integer not null,
  name             text not null,
  pin_hash         text not null,
  pin_lookup       text not null,
  qr_token         text not null unique default encode(gen_random_bytes(18), 'hex'),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (establishment_id, code),
  unique (establishment_id, pin_lookup)
);

create table waiter_tables (
  waiter_id uuid not null references waiters(id) on delete cascade,
  table_id  uuid not null,
  primary key (waiter_id, table_id)
);

-- Fichajes (entrada / salida de turno).
create table shifts (
  id         uuid primary key default gen_random_uuid(),
  waiter_id  uuid not null references waiters(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);
create unique index shifts_one_open on shifts (waiter_id) where ended_at is null;

-- Sesiones (panel y PDA). Se guarda el hash del token, nunca el token.
create table sessions (
  token_hash  text primary key,
  user_id     uuid references users(id) on delete cascade,
  waiter_id   uuid references waiters(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  check ((user_id is null) <> (waiter_id is null))
);

create table categories (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  parent_id        uuid references categories(id) on delete cascade,
  name             text not null,
  sort             integer not null default 0
);

create table products (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  category_id      uuid references categories(id) on delete set null,
  subcategory_id   uuid references categories(id) on delete set null,
  name             text not null,
  description      text not null default '',
  price_cents      integer not null check (price_cents >= 0),
  vat_rate         numeric(4,2) not null default 10.00,
  destination      text not null default 'kitchen' check (destination in ('kitchen','bar')),
  course           integer not null default 1 check (course between 1 and 5),
  visible          boolean not null default true,
  options          text[] not null default array[]::text[],
  allergens        text[] not null default array[]::text[],
  photo_url        text,
  translations     jsonb not null default '{}'::jsonb,
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index products_est on products (establishment_id) where not archived;

create table tables (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  label            text not null,
  zone             text not null default 'salon' check (zone in ('salon','terraza','barra','reservado')),
  seats            integer not null default 4 check (seats > 0),
  active           boolean not null default true,
  -- Estado físico: independiente de la cuenta económica.
  physical_state   text not null default 'free' check (physical_state in ('free','occupied','paid_occupied','dirty')),
  qr_token         text not null unique default encode(gen_random_bytes(12), 'hex'),
  access_code      text not null default lpad((floor(random()*10000))::int::text, 4, '0'),
  access_open      boolean not null default true,
  unique (establishment_id, label)
);

alter table waiter_tables add constraint waiter_tables_table_fk foreign key (table_id) references tables(id) on delete cascade;

-- Cuenta económica: una mesa o un cliente de barra identificado.
create table accounts (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  table_id         uuid references tables(id) on delete set null,
  bar_name         text,
  waiter_id        uuid references waiters(id) on delete set null,
  status           text not null default 'open' check (status in ('open','paid','cancelled')),
  opened_at        timestamptz not null default now(),
  closed_at        timestamptz,
  check ((table_id is null) <> (bar_name is null))
);
-- Garantía en base de datos: una sola cuenta abierta por mesa y por nombre de barra.
create unique index accounts_one_open_table on accounts (table_id) where status = 'open' and table_id is not null;
create unique index accounts_one_open_bar on accounts (establishment_id, lower(bar_name)) where status = 'open' and bar_name is not null;

create table orders (
  id                uuid primary key default gen_random_uuid(),
  establishment_id  uuid not null references establishments(id) on delete cascade,
  account_id        uuid not null references accounts(id) on delete cascade,
  number            integer not null,
  source            text not null check (source in ('tpv','pda','client')),
  waiter_id         uuid references waiters(id) on delete set null,
  user_id           uuid references users(id) on delete set null,
  -- Idempotencia: el mismo envío repetido (doble pulsación, reintento sin conexión) no duplica.
  client_request_id text not null,
  note              text not null default '',
  created_at        timestamptz not null default now(),
  unique (establishment_id, client_request_id),
  unique (establishment_id, number)
);

create table order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  name          text not null,
  option        text,
  unit_cents    integer not null,
  vat_rate      numeric(4,2) not null,
  qty           integer not null check (qty > 0),
  destination   text not null check (destination in ('kitchen','bar')),
  course        integer not null default 1,
  status        text not null default 'new'
                check (status in ('held','new','preparing','ready','received','delivered','cancelled')),
  ready_at      timestamptz,
  delivered_at  timestamptz,
  updated_at    timestamptz not null default now()
);
create index order_items_status on order_items (status) where status not in ('delivered','cancelled');

create table payments (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  account_id       uuid not null references accounts(id) on delete cascade,
  method           text not null check (method in ('cash','card','bizum')),
  amount_cents     integer not null check (amount_cents > 0),
  tendered_cents   integer,
  change_cents     integer,
  idempotency_key  text not null,
  waiter_id        uuid references waiters(id) on delete set null,
  user_id          uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (establishment_id, idempotency_key)
);

-- Documentos: proforma (informativa), factura simplificada (ticket) y completa.
create table documents (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  account_id       uuid references accounts(id) on delete set null,
  type             text not null check (type in ('proforma','simplified','full')),
  series           text not null,
  number           integer not null,
  total_cents      integer not null,
  payload          jsonb not null,
  status           text not null default 'valid' check (status in ('valid','voided','replaced')),
  created_at       timestamptz not null default now(),
  unique (establishment_id, series, number)
);

-- Registro de auditoría: quién hizo qué.
create table audit_log (
  id               bigserial primary key,
  establishment_id uuid references establishments(id) on delete cascade,
  actor            text not null,
  action           text not null,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

-- Avisos del cliente desde la carta (llamar al camarero, pedir la cuenta...).
create table service_requests (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  table_id         uuid not null references tables(id) on delete cascade,
  kind             text not null check (kind in ('pay','waiter','other')),
  note             text not null default '',
  status           text not null default 'open' check (status in ('open','attended')),
  attended_by      uuid references waiters(id) on delete set null,
  created_at       timestamptz not null default now(),
  attended_at      timestamptz
);
-- Evita avisos repetidos del mismo tipo para la misma mesa mientras siga abierto.
create unique index service_requests_one_open on service_requests (table_id, kind) where status = 'open';
