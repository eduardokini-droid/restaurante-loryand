import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { validSpanishTaxId } from '../src/services/nif.js';
import { documentTicket } from '../src/services/escpos.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let product: string;
let seq = 0;
const rid = () => `fq-${Date.now()}-${++seq}`;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });
const pub = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name, legal_name, tax_id, address, city) values ('demo', 'El Laurel', 'Laurel S.L.', 'B11111111', 'C/ Mayor 1', 'Toledo') returning id`;
  est = e.id;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate, destination) values (${est}, 'Menú', 1210, 10, 'bar') returning id`;
  product = p.id;
  admin = cookieOf(await pub('POST', '/api/auth/login', { username: 'admin', password: 'secreto123' }));
});

const sale = async () => (await call(admin, 'POST', '/api/service/quick-sale', { clientRequestId: rid(), items: [{ productId: product, qty: 1 }], method: 'card' })).json();

describe('NIF, NIE y CIF', () => {
  it('comprueba la letra o el dígito de control', () => {
    expect(validSpanishTaxId('12345678Z')).toBe(true);
    expect(validSpanishTaxId('12345678-z')).toBe(true);
    expect(validSpanishTaxId('12345678A')).toBe(false);
    expect(validSpanishTaxId('X1234567L')).toBe(true);
    expect(validSpanishTaxId('X1234567A')).toBe(false);
    expect(validSpanishTaxId('B12345674')).toBe(true);
    expect(validSpanishTaxId('B12345675')).toBe(false);
    expect(validSpanishTaxId('hola')).toBe(false);
  });
});

describe('ticket impreso', () => {
  it('lleva el logotipo en blanco y negro y el QR nativo de la impresora', () => {
    const doc = { type: 'simplified', series: 'T', number: 7, created_at: new Date(), total_cents: 1210, payload: { issuer: { name: 'El Laurel' }, place: 'Barra', lines: [], vat: [] } };
    const logo = { width: 16, height: 2, data: Buffer.from([0xff, 0x00, 0x0f, 0xf0]) };
    const buf = documentTicket(doc, 48, { logo, invoiceUrl: 'https://x.es/factura/abc' });
    expect(buf.includes(Buffer.from([0x1d, 0x76, 0x30, 0, 2, 0, 2, 0, 0xff, 0x00, 0x0f, 0xf0]))).toBe(true);   // GS v 0
    const url = Buffer.from('https://x.es/factura/abc');
    expect(buf.includes(Buffer.concat([Buffer.from([0x1d, 0x28, 0x6b, url.length + 3, 0, 0x31, 0x50, 0x30]), url]))).toBe(true);
    expect(buf.includes(Buffer.from([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]))).toBe(true);                 // imprimir QR
    const plain = documentTicket(doc, 48);
    expect(plain.includes(Buffer.from([0x1d, 0x76, 0x30]))).toBe(false);
    expect(plain.includes(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(false);
  });

  it('el logotipo para la impresora se guarda con el tamaño correcto', async () => {
    const img = (await call(admin, 'POST', '/api/admin/images', { kind: 'logo', dataUrl: PNG })).json();
    expect((await call(admin, 'PUT', '/api/admin/logo', { imageId: img.id, print: { width: 16, height: 2, data: Buffer.from([1, 2, 3]).toString('base64') } })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/logo', { imageId: img.id, print: { width: 16, height: 2, data: Buffer.from([1, 2, 3, 4]).toString('base64') } })).statusCode).toBe(200);
    const [e] = await sql`select logo_print_width, logo_print_height, length(logo_print) as n from establishments where id = ${est}`;
    expect(e).toEqual({ logo_print_width: 16, logo_print_height: 2, n: 4 });
    await call(admin, 'PUT', '/api/admin/logo', { imageId: null });
    const [e2] = await sql`select logo_print from establishments where id = ${est}`;
    expect(e2.logo_print).toBeNull();
  });
});

describe('factura completa desde el QR del ticket', () => {
  it('el cliente pone sus datos y la factura sustituye al ticket una sola vez', async () => {
    const s = await sale();
    const [doc] = await sql`select public_token from documents where id = ${s.documentId}`;
    const info = (await pub('GET', `/api/public/invoice/${doc.public_token}`)).json();
    expect(info).toMatchObject({ establishment: 'El Laurel', type: 'simplified', totalCents: 1210, canRequest: true, document: null });
    const bad = await pub('POST', `/api/public/invoice/${doc.public_token}`, { name: 'Ana Ruiz', taxId: '12345678A', address: 'C/ Sol 2' });
    expect(bad.json().error).toBe('bad_tax_id');
    const ok = (await pub('POST', `/api/public/invoice/${doc.public_token}`, { name: 'Ana Ruiz', taxId: '12345678-z', address: 'C/ Sol 2', postalCode: '45001', city: 'Toledo' })).json();
    expect(ok.code).toMatch(/^F/);
    const full = (await pub('GET', `/api/public/invoice/${ok.token}`)).json();
    expect(full).toMatchObject({ type: 'full', totalCents: 1210, canRequest: false });
    expect(full.document.payload.customer).toMatchObject({ name: 'Ana Ruiz', taxId: '12345678Z' });
    // El ticket queda sustituido y apunta a su factura; no se puede pedir otra.
    const again = (await pub('GET', `/api/public/invoice/${doc.public_token}`)).json();
    expect(again).toMatchObject({ status: 'replaced', canRequest: false, reason: 'already', fullToken: ok.token });
    expect((await pub('POST', `/api/public/invoice/${doc.public_token}`, { name: 'Otro', taxId: 'B12345674', address: 'C/ Luna' })).json().error).toBe('already_replaced');
    const [a] = await sql`select actor from audit_log where action = 'document.full_by_customer'`;
    expect(a.actor).toBe('cliente');
  });

  it('cliente extranjero, trimestre anterior y enlace inventado', async () => {
    const s = await sale();
    const [doc] = await sql`select public_token from documents where id = ${s.documentId}`;
    const ok = await pub('POST', `/api/public/invoice/${doc.public_token}`, { name: 'Hans Müller GmbH', taxId: 'DE123456789', foreign: true, address: 'Berliner Str. 1, Berlin' });
    expect(ok.statusCode).toBe(200);
    const s2 = await sale();
    await sql`update documents set created_at = now() - interval '4 months' where id = ${s2.documentId}`;
    const [d2] = await sql`select public_token from documents where id = ${s2.documentId}`;
    expect((await pub('GET', `/api/public/invoice/${d2.public_token}`)).json()).toMatchObject({ canRequest: false, reason: 'other_quarter' });
    expect((await pub('GET', '/api/public/invoice/0123456789abcdef01234567')).statusCode).toBe(404);
    expect((await pub('GET', '/api/public/invoice/no-valido')).statusCode).toBe(400);
  });
});
