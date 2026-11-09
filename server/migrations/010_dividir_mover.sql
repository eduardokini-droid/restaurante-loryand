-- Dividir la cuenta por productos: qué productos (y cuántas unidades) paga cada cobro.
create table payment_items (
  payment_id    uuid not null references payments(id) on delete cascade,
  order_item_id uuid not null references order_items(id) on delete cascade,
  qty           integer not null check (qty > 0),
  amount_cents  integer not null check (amount_cents >= 0),
  primary key (payment_id, order_item_id)
);
create index payment_items_item on payment_items (order_item_id);

-- Ticket propio de un cobro parcial por productos.
alter table documents add column payment_id uuid references payments(id) on delete set null;
