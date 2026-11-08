-- Arqueo y cierre de caja: apertura con fondo, entradas/salidas, recuento con descuadre y cierre Z.

create table cash_sessions (
  id                  uuid primary key default gen_random_uuid(),
  establishment_id    uuid not null references establishments(id) on delete cascade,
  number              integer,                          -- número de cierre Z (al cerrar)
  status              text not null default 'open' check (status in ('open','closed')),
  opened_at           timestamptz not null default now(),
  opened_by           text not null,
  opening_float_cents integer not null check (opening_float_cents >= 0),
  closed_at           timestamptz,
  closed_by           text,
  expected_cash_cents integer,
  counted_cash_cents  integer,
  difference_cents    integer,
  counted_detail      jsonb,                            -- billetes y monedas contados
  notes               text not null default '',
  report              jsonb,                            -- informe Z congelado al cerrar
  unique (establishment_id, number)
);
-- Una sola caja abierta por establecimiento.
create unique index cash_sessions_one_open on cash_sessions (establishment_id) where status = 'open';

create table cash_movements (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references cash_sessions(id) on delete cascade,
  kind         text not null check (kind in ('in','out')),
  amount_cents integer not null check (amount_cents > 0),
  reason       text not null,
  actor        text not null,
  created_at   timestamptz not null default now()
);

alter table payments add column cash_session_id uuid references cash_sessions(id) on delete set null;

-- Nuevos tipos de trabajo de impresión: apertura de cajón y cierre Z.
alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check check (kind in ('kitchen','bar','ticket','proforma','test','fire','drawer','closing'));
