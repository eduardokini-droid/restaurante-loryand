-- Tipo de negocio, logotipo y fotos de productos guardadas en el propio servidor.
alter table establishments add column business_type text not null default 'restaurant'
  check (business_type in ('restaurant', 'bar', 'cafe', 'pub', 'bakery', 'icecream', 'other'));

create table images (
  id               uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references establishments(id) on delete cascade,
  kind             text not null check (kind in ('logo', 'product')),
  mime             text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes            integer not null,
  data             bytea not null,
  created_at       timestamptz not null default now()
);
create index images_est on images (establishment_id, kind);

alter table establishments add column logo_image_id uuid references images(id) on delete set null;
