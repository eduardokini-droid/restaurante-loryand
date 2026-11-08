-- Copia externa de las copias de seguridad (almacenamiento compatible con S3: Supabase Storage, etc.).
alter table backups add column offsite_key text;
alter table backups add column offsite_at timestamptz;
alter table backups add column offsite_error text;
