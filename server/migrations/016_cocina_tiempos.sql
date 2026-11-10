-- Tiempos de cocina: cuándo se envió cada plato (al pedir o al «Marchar» su pase) y cuándo cambió de estado.
alter table order_items add column sent_at timestamptz;
alter table order_items add column status_at timestamptz not null default now();
update order_items i set sent_at = o.created_at, status_at = o.created_at from orders o where o.id = i.order_id and i.status <> 'held';

create function order_items_times() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status_at := now();
    if new.status <> 'held' and new.sent_at is null then new.sent_at := now(); end if;
  elsif new.status is distinct from old.status then
    new.status_at := now();
    if old.status = 'held' and new.status <> 'held' and new.sent_at is null then new.sent_at := now(); end if;
  end if;
  return new;
end $$;
create trigger order_items_times before insert or update of status on order_items for each row execute function order_items_times();
