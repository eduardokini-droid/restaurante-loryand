-- Registro de jornada (art. 34.9 del Estatuto de los Trabajadores): todo el personal ficha,
-- pausas, correcciones trazables y conservación (los fichajes no se borran, se anulan con motivo).

-- Personal: además de sala (camareros), cocina, barra y otros. Todos fichan con su usuario y PIN.
alter table waiters add column staff_role text not null default 'sala' check (staff_role in ('sala','cocina','barra','otros'));
alter table waiters add column document_id text not null default '';   -- DNI/NIE (opcional) para el registro

alter table shifts add column status text not null default 'valid' check (status in ('valid','voided'));
alter table shifts add column needs_review boolean not null default false;
alter table shifts add column origin text not null default 'self' check (origin in ('self','manager','auto'));
alter table shifts add column created_at timestamptz not null default now();

drop index shifts_one_open;
create unique index shifts_one_open on shifts (waiter_id) where ended_at is null and status = 'valid';
create index shifts_waiter_time on shifts (waiter_id, started_at);

create table shift_breaks (
  id         uuid primary key default gen_random_uuid(),
  shift_id   uuid not null references shifts(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  check (ended_at is null or ended_at > started_at)
);
create unique index shift_breaks_one_open on shift_breaks (shift_id) where ended_at is null;

-- Historial de correcciones: quién, cuándo, qué había antes, qué hay ahora y por qué.
create table shift_edits (
  id         bigserial primary key,
  shift_id   uuid not null references shifts(id) on delete cascade,
  action     text not null check (action in ('create','update','void','auto_close')),
  actor      text not null,
  before     jsonb,
  after      jsonb,
  reason     text not null,
  created_at timestamptz not null default now()
);
create index shift_edits_shift on shift_edits (shift_id, created_at);
