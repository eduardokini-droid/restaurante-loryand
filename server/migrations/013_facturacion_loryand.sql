-- Facturación de Loryand a sus clientes (los establecimientos) e incidencias de soporte.

-- Datos del emisor (Loryand) y ajustes de facturación: una sola fila.
create table platform_settings (
  id   boolean primary key default true check (id),
  data jsonb not null default '{}'::jsonb
);
insert into platform_settings (id) values (true);

-- Contrato de cada establecimiento.
create table contracts (
  establishment_id uuid primary key references establishments(id) on delete cascade,
  plan_name        text not null default 'Plan TPV',
  monthly_cents    integer not null default 0 check (monthly_cents >= 0),
  vat_rate         numeric(4,2) not null default 21 check (vat_rate >= 0 and vat_rate <= 30),
  start_date       date not null default current_date,
  status           text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  payment_method   text not null default 'transfer' check (payment_method in ('transfer', 'direct_debit', 'card', 'other')),
  -- Datos de facturación del cliente: si están vacíos se usan los del establecimiento.
  billing_name     text not null default '',
  billing_tax_id   text not null default '',
  billing_address  text not null default '',
  billing_email    text not null default '',
  notes            text not null default '',
  updated_at       timestamptz not null default now()
);

-- Facturas emitidas por Loryand. Nunca se borran: se corrigen con una rectificativa.
create table platform_invoices (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete restrict,
  kind             text not null default 'invoice' check (kind in ('invoice', 'rectifying')),
  series           text not null,
  year             integer not null,
  number           integer not null,
  issue_date       date not null,
  due_date         date not null,
  period           text,                       -- 'AAAA-MM' en las cuotas mensuales
  rectifies_id     uuid references platform_invoices(id),
  reason           text,                       -- motivo de la rectificación
  issuer           jsonb not null,
  customer         jsonb not null,
  lines            jsonb not null,             -- [{description, qty, unitCents, vatRate}]
  base_cents       integer not null,
  vat_cents        integer not null,
  total_cents      integer not null,
  status           text not null default 'issued' check (status in ('issued', 'paid', 'rectified')),
  paid_at          date,
  paid_method      text,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  unique (series, year, number)
);
-- Una sola cuota por cliente y mes (la generación es repetible sin duplicar).
create unique index platform_invoices_period on platform_invoices (establishment_id, period) where period is not null and kind = 'invoice';
create index platform_invoices_est on platform_invoices (establishment_id, issue_date desc);

-- Incidencias de soporte.
create table support_tickets (
  id               uuid primary key default gen_random_uuid(),
  number           serial unique,
  establishment_id uuid not null references establishments(id) on delete cascade,
  title            text not null,
  category         text not null default 'other' check (category in ('bug', 'question', 'hardware', 'billing', 'request', 'other')),
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status           text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'resolved')),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  unread_gestor    boolean not null default true,
  unread_client    boolean not null default false
);
create index support_tickets_status on support_tickets (status, updated_at desc);

create table support_messages (
  id          bigserial primary key,
  ticket_id   uuid not null references support_tickets(id) on delete cascade,
  author_kind text not null check (author_kind in ('client', 'gestor')),
  author_name text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index support_messages_ticket on support_messages (ticket_id, created_at);
