-- Pagos online (Redsys: tarjeta y Bizum) y avisos por WhatsApp.

-- Integraciones por establecimiento. Las claves secretas se guardan cifradas (AES-256-GCM).
create table integrations (
  establishment_id uuid not null references establishments(id) on delete cascade,
  kind             text not null check (kind in ('redsys','whatsapp')),
  enabled          boolean not null default false,
  config           jsonb not null default '{}'::jsonb,   -- datos no secretos
  secret_enc       text,                                  -- clave cifrada; nunca se devuelve al navegador
  updated_at       timestamptz not null default now(),
  primary key (establishment_id, kind)
);

-- Cobro online: el importe queda fijado al generar el QR.
create table online_payments (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  account_id       uuid not null references accounts(id) on delete cascade,
  token            text not null unique default encode(gen_random_bytes(16), 'hex'),
  order_code       text not null unique,                  -- Ds_Merchant_Order (12 caracteres, 4 primeros numéricos)
  amount_cents     integer not null check (amount_cents > 0),
  method           text check (method in ('card','bizum')),
  environment      text not null check (environment in ('test','live')),
  status           text not null default 'pending'
                   check (status in ('pending','processing','paid','failed','cancelled','conflict')),
  created_by       text not null default '',              -- 'client' o actor del personal
  response_code    text,
  auth_code        text,
  error            text,
  payment_id       uuid references payments(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index online_payments_account on online_payments (account_id, status);

-- Registro de mensajes enviados (o preparados para enviar a mano).
create table message_log (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  event            text not null check (event in ('reservation_confirmed','reservation_reminder','waitlist_ready','test')),
  to_phone         text not null,
  body             text not null,
  provider         text not null check (provider in ('link','meta')),
  status           text not null check (status in ('sent','failed','manual')),
  error            text,
  reservation_id   uuid references reservations(id) on delete set null,
  waitlist_id      uuid references waitlist(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index message_log_est on message_log (establishment_id, created_at desc);

alter table reservations add column reminder_sent_at timestamptz;
