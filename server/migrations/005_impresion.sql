-- Impresión directa en impresoras de tickets (ESC/POS) mediante un agente local.

-- Agente de impresión: programa que corre en un ordenador del local y entrega los trabajos a las impresoras.
create table print_agents (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  name             text not null,
  token_hash       text not null unique,      -- el token solo se muestra una vez al crearlo
  last_seen_at     timestamptz,
  version          text,
  created_at       timestamptz not null default now()
);

create table printers (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  name             text not null,
  -- tcp: impresora de red (IP:puerto, normalmente 9100) · device: /dev/usb/lp0 (Linux) ·
  -- windows: impresora compartida de Windows · cups: impresora de macOS/Linux
  connection       text not null check (connection in ('tcp','device','windows','cups')),
  address          text not null,
  width_chars      integer not null default 48 check (width_chars between 24 and 64),
  roles            text[] not null default '{}',   -- kitchen, bar, ticket
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table print_jobs (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  printer_id       uuid not null references printers(id) on delete cascade,
  kind             text not null check (kind in ('kitchen','bar','ticket','proforma','test','fire')),
  title            text not null,
  payload          bytea not null,                 -- bytes ESC/POS listos para la impresora
  status           text not null default 'queued' check (status in ('queued','sent','printed','failed')),
  attempts         integer not null default 0,
  error            text,
  agent_id         uuid references print_agents(id) on delete set null,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  printed_at       timestamptz
);
create index print_jobs_queue on print_jobs (establishment_id, status, created_at) where status in ('queued','sent');
