-- Acceso de camareros desde el TPV: QR de un solo uso y corta duración. Siempre exige además el PIN.
create table waiter_access_tokens (
  token_hash  text primary key,
  waiter_id   uuid not null references waiters(id) on delete cascade,
  created_by  text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index waiter_access_tokens_waiter on waiter_access_tokens (waiter_id, created_at desc);
