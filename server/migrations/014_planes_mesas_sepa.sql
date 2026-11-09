-- Planes de Loryand, cobro por mesa activa y domiciliación SEPA.

-- Funciones que se pueden contratar. Se añaden las nuevas a los locales existentes para no quitarles nada.
update establishments set features = (
  select array(select distinct unnest(features || array['reservations', 'loyalty', 'stock', 'online']::text[]))
);
alter table establishments alter column features set default array['tpv','pda','kitchen','bar','menu','cash','reservations','loyalty','stock','online']::text[];

create table plans (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null unique,
  description           text not null default '',
  features              text[] not null default '{}',
  monthly_cents         integer not null default 0 check (monthly_cents >= 0),
  price_per_table_cents integer not null default 0 check (price_per_table_cents >= 0),
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);
insert into plans (name, description, features, price_per_table_cents, sort) values
  ('Básico', 'Carta, pedidos y mesas. Para locales que empiezan.', array['menu', 'pda', 'kitchen', 'bar'], 200, 1),
  ('Profesional', 'Operativa y gestión completa: TPV, caja, reservas y almacén.', array['menu', 'pda', 'kitchen', 'bar', 'tpv', 'cash', 'reservations', 'stock'], 300, 2),
  ('Premium', 'Todas las funciones, cobro online, fidelización y soporte prioritario.', array['menu', 'pda', 'kitchen', 'bar', 'tpv', 'cash', 'reservations', 'stock', 'loyalty', 'online'], 400, 3);

alter table contracts add column plan_id uuid references plans(id) on delete set null;
alter table contracts add column price_per_table_cents integer not null default 0 check (price_per_table_cents >= 0);
alter table contracts add column renewal_date date;
-- Domiciliación: el IBAN del cliente se guarda cifrado; para mostrarlo solo los 4 últimos dígitos.
alter table contracts add column iban_enc text;
alter table contracts add column iban_last4 text;
alter table contracts add column mandate_ref text not null default '';
alter table contracts add column mandate_date date;

-- Mesas activas por día: el cobro por mesa usa el máximo del mes.
create table table_usage (
  establishment_id uuid not null references establishments(id) on delete cascade,
  day              date not null,
  active_tables    integer not null,
  primary key (establishment_id, day)
);

create function record_table_usage(est uuid) returns void language sql as $$
  insert into table_usage (establishment_id, day, active_tables)
  values (est, (now() at time zone 'Europe/Madrid')::date, (select count(*) from tables where establishment_id = est and active))
  on conflict (establishment_id, day) do update set active_tables = greatest(table_usage.active_tables, excluded.active_tables);
$$;

create function tables_usage_trigger() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform record_table_usage(old.establishment_id); return old; end if;
  if tg_op = 'INSERT' or new.active is distinct from old.active then perform record_table_usage(new.establishment_id); end if;
  return new;
end $$;
create trigger tables_usage after insert or update of active or delete on tables for each row execute function tables_usage_trigger();
select record_table_usage(id) from establishments;

-- Remesas de recibos SEPA (adeudos directos CORE).
create table remittances (
  id              uuid primary key default gen_random_uuid(),
  msg_id          text not null unique,
  collection_date date not null,
  count           integer not null,
  total_cents     integer not null,
  status          text not null default 'sent' check (status in ('sent', 'collected')),
  xml             text not null,
  created_by      text not null,
  created_at      timestamptz not null default now()
);
alter table platform_invoices add column remittance_id uuid references remittances(id);
alter table platform_invoices add column returned_at date;   -- recibo devuelto por el banco
alter table platform_invoices add column max_tables integer; -- mesas facturadas en la cuota
