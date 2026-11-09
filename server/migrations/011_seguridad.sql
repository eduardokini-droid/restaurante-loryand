-- Recuperación de contraseña y doble verificación (TOTP) para el panel.
alter table users add column email text;
alter table users add column totp_secret_enc text;           -- cifrado con AES-GCM (services/secrets.ts)
alter table users add column totp_enabled boolean not null default false;
alter table users add column totp_last_step bigint;          -- evita reutilizar el mismo código dos veces
create unique index users_email_unique on users (lower(email)) where email is not null;

-- Enlaces de recuperación de un solo uso. Solo se guarda el hash del enlace.
create table password_resets (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  origin     text not null check (origin in ('email', 'admin')),
  created_by text,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index password_resets_user on password_resets (user_id);

-- Códigos de emergencia de la doble verificación (un solo uso, guardados con hash).
create table recovery_codes (
  user_id   uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at   timestamptz,
  primary key (user_id, code_hash)
);

-- Segundo paso del inicio de sesión: la contraseña ya es correcta, falta el código.
create table login_challenges (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  attempts   integer not null default 0,
  expires_at timestamptz not null
);
