-- Protección de datos: ajustes por local, consentimientos y registro de pruebas del consentimiento.
alter table establishments add column privacy jsonb not null default '{}'::jsonb;

alter table reservations add column privacy_accepted_at timestamptz;
alter table reservations add column whatsapp_consent boolean not null default false;
alter table reservations add column anonymized_at timestamptz;

alter table waitlist add column whatsapp_consent boolean not null default false;
alter table waitlist add column anonymized_at timestamptz;

alter table customers add column privacy_accepted_at timestamptz;
alter table customers add column erased_at timestamptz;

-- Prueba de cada consentimiento (art. 7.1 RGPD): quién, qué, cuándo, con qué versión del texto y por qué vía.
create table consent_log (
  id               bigserial primary key,
  establishment_id uuid not null references establishments(id) on delete cascade,
  subject_kind     text not null check (subject_kind in ('reservation', 'waitlist', 'customer')),
  subject_id       uuid not null,
  purpose          text not null check (purpose in ('privacy', 'whatsapp', 'marketing')),
  granted          boolean not null,
  text_version     text not null,
  source           text not null check (source in ('public', 'staff', 'card')),
  actor            text,
  ip               text,
  created_at       timestamptz not null default now()
);
create index consent_log_subject on consent_log (subject_kind, subject_id);

-- Las reservas antiguas se anonimizan, no se borran: se mantienen las cifras de ocupación.
create index reservations_retention on reservations (starts_at) where anonymized_at is null;
