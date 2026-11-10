-- Logotipo en el ticket impreso y QR para pedir la factura completa.
-- Cada documento tiene un enlace secreto propio (el QR del ticket).
alter table documents add column public_token text not null default encode(gen_random_bytes(12), 'hex');
create unique index documents_public_token on documents (public_token);

-- Logotipo en blanco y negro listo para la impresora de tickets (1 bit por punto, filas de izquierda a derecha).
alter table establishments add column logo_print bytea;
alter table establishments add column logo_print_width integer;
alter table establishments add column logo_print_height integer;
