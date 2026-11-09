import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { buildPain008, creditorId, validCreditorId, validIban } from '../src/services/sepa.js';

let app: FastifyInstance;
let gestor: string;
let admin: string;
let est: string;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object, e?: string) =>
  app.inject({ method: method as 'POST', url, payload, headers: { cookie, ...(e ? { 'x-establishment-id': e } : {}) } });
const login = async (username: string, password: string) => cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } }));
const month = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 7);
const ISSUER = { name: 'Loryand Soluciones S.L.', taxId: 'B99999999', address: 'C/ Tecnología 1', postalCode: '45001', city: 'Toledo', email: 'f@loryand.es', iban: 'ES91 2100 0418 4502 0005 1332' };
const CLIENT_IBAN = 'ES7921000813610123456789';

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users, platform_invoices, remittances cascade');
  await sql`update platform_settings set data = '{}'::jsonb`;
  const [e] = await sql`insert into establishments (slug, name, legal_name, tax_id, address, city) values ('laurel', 'El Laurel', 'Laurel S.L.', 'B11111111', 'C/ Mayor 1', 'Toledo') returning id`;
  est = e.id;
  await sql`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor', ${await hashPassword('gestor-1234')}, 'superadmin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  gestor = await login('gestor', 'gestor-1234');
  admin = await login('admin', 'secreto123');
});

describe('SEPA', () => {
  it('valida IBAN e identificador de acreedor', () => {
    expect(validIban('ES91 2100 0418 4502 0005 1332')).toBe(true);
    expect(validIban('ES91 2100 0418 4502 0005 1333')).toBe(false);
    expect(validIban('ES9121000418450200051')).toBe(false);
    expect(validCreditorId('DE98ZZZ09999999999')).toBe(true);           // ejemplo oficial del EPC
    expect(creditorId('09999999999', 'ZZZ', 'DE')).toBe('DE98ZZZ09999999999');
    const es = creditorId('B99999999');
    expect(es).toMatch(/^ES\d{2}000B99999999$/);
    expect(validCreditorId(es)).toBe(true);
  });

  it('el fichero de remesa lleva totales, mandatos y texto sin tildes', () => {
    const xml = buildPain008({ msgId: 'M1', createdAt: new Date('2026-11-10T10:00:00Z'), collectionDate: '2026-11-20',
      creditor: { name: 'Loryand Soluciones', iban: 'ES9121000418450200051332', id: 'ES12000B99999999' },
      debits: [{ endToEndId: 'LR-2026-0001', amountCents: 3630, mandateId: 'MANDATO-001', mandateDate: '2026-01-15', debtorName: 'Cafetería Ñandú & Cía', debtorIban: CLIENT_IBAN, concept: 'Cuota de noviembre' },
               { endToEndId: 'LR-2026-0002', amountCents: 1210, mandateId: 'MANDATO-002', mandateDate: '2026-02-01', debtorName: 'Bar Sol', debtorIban: 'ES6621000418401234567891', concept: 'Cuota' }] });
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(xml).toContain('<CtrlSum>48.40</CtrlSum>');
    expect(xml).toContain('<Nm>Cafeteria Nandu Cia</Nm>');
    expect(xml).toContain('<LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp>');
    expect(xml).toContain('<MndtId>MANDATO-001</MndtId><DtOfSgntr>2026-01-15</DtOfSgntr>');
    expect(xml).toContain(`<IBAN>${CLIENT_IBAN}</IBAN>`);
    expect(xml).toContain('<ReqdColltnDt>2026-11-20</ReqdColltnDt>');
  });
});

describe('planes y funciones contratadas', () => {
  it('el plan activa sus funciones y el programa bloquea las demás', async () => {
    const plans = (await call(gestor, 'GET', '/api/platform/plans')).json();
    expect(plans.map((p: { name: string }) => p.name)).toEqual(['Básico', 'Profesional', 'Premium']);
    const basico = plans[0];
    await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { planId: basico.id });
    const [e] = await sql`select features from establishments where id = ${est}`;
    expect(e.features.sort()).toEqual(['bar', 'kitchen', 'menu', 'pda']);
    const [c] = await sql`select plan_name, price_per_table_cents from contracts where establishment_id = ${est}`;
    expect(c).toEqual({ plan_name: 'Básico', price_per_table_cents: 200 });
    // El administrador no ve TPV, caja, reservas, almacén ni fidelización.
    admin = await login('admin', 'secreto123');
    const me = (await call(admin, 'GET', '/api/auth/me')).json();
    expect(me.modules).not.toContain('tpv');
    expect(me.modules).not.toContain('reservations');
    expect(me.modules).toContain('kitchen');
    expect((await call(admin, 'GET', '/api/reservations')).statusCode).toBe(403);
    expect((await call(admin, 'GET', '/api/reports/sales?from=2026-01-01&to=2026-01-31')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/public/booking/laurel' })).statusCode).toBe(404);
    // El gestor dentro del local también ve solo lo contratado.
    expect((await call(gestor, 'GET', '/api/reservations', undefined, est)).statusCode).toBe(403);
    // Cambiar las funciones del plan las cambia en el local.
    await call(gestor, 'PUT', `/api/platform/plans/${basico.id}`, { features: ['menu', 'kitchen', 'bar', 'pda', 'reservations'] });
    expect((await call(admin, 'GET', '/api/reservations/settings')).statusCode).toBe(200);
  });

  it('sin «carta» no se abre la carta QR y sin «PDA» los camareros no entran desde el móvil', async () => {
    const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning qr_token`;
    expect((await app.inject({ method: 'GET', url: `/api/public/table/${t.qr_token}` })).statusCode).toBe(200);
    await sql`update establishments set features = array['tpv','cash'] where id = ${est}`;
    const r = await app.inject({ method: 'GET', url: `/api/public/table/${t.qr_token}` });
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toContain('carta digital no está disponible');
    const w = await app.inject({ method: 'POST', url: '/api/auth/waiter', payload: { establishment: 'laurel', username: 'camarero-1', pin: '1234' } });
    expect(w.statusCode).toBe(403);
  });
});

describe('cobro por mesa activa', () => {
  it('se factura el máximo de mesas activas del mes, aunque luego se desactiven', async () => {
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    for (const l of ['1', '2', '3', '4', '5']) await sql`insert into tables (establishment_id, label) values (${est}, ${l})`;
    await sql`update tables set active = false where establishment_id = ${est} and label in ('4', '5')`;
    const [u] = await sql`select active_tables from table_usage where establishment_id = ${est}`;
    expect(u.active_tables).toBe(5);
    await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { planName: 'Plan por mesas', monthlyCents: 0, pricePerTableCents: 200 });
    const r = (await call(gestor, 'POST', '/api/platform/invoices/generate', { period: month() })).json();
    expect(r.created).toBe(1);
    const [inv] = (await call(gestor, 'GET', '/api/platform/invoices')).json();
    expect(inv.lines).toEqual([{ description: expect.stringContaining('activas en'), qty: 5, unitCents: 200, vatRate: 21 }]);
    expect(inv).toMatchObject({ base_cents: 1000, vat_cents: 210, total_cents: 1210, max_tables: 5 });
    const clients = (await call(gestor, 'GET', '/api/platform/clients')).json();
    expect(clients[0]).toMatchObject({ active_tables: 3, max_tables_month: 5 });
  });

  it('cuota fija más mesas: dos líneas; sin mesas y sin cuota fija no se factura', async () => {
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { planName: 'Plan mixto', monthlyCents: 0, pricePerTableCents: 300 });
    expect((await call(gestor, 'POST', '/api/platform/invoices/generate', { period: month() })).json().skipped[0].reason).toBe('Sin mesas activas ese mes');
    await sql`insert into tables (establishment_id, label) values (${est}, '1'), (${est}, '2')`;
    await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { monthlyCents: 1500 });
    await call(gestor, 'POST', '/api/platform/invoices/generate', { period: month() });
    const [inv] = (await call(gestor, 'GET', '/api/platform/invoices')).json();
    expect(inv.lines.map((l: { qty: number; unitCents: number }) => [l.qty, l.unitCents])).toEqual([[1, 1500], [2, 300]]);
    expect(inv.total_cents).toBe(Math.round(2100 * 1.21));
  });
});

describe('remesa SEPA', () => {
  it('IBAN cifrado, remesa con las facturas domiciliadas, cobro y devolución', async () => {
    await call(gestor, 'PUT', '/api/platform/billing-settings', { ...ISSUER, iban: 'ES00 0000' }).then((r) => expect(r.json().message).toContain('IBAN'));
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    expect((await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { iban: 'ES12 3456' })).statusCode).toBe(400);
    const c = (await call(gestor, 'PUT', `/api/platform/clients/${est}/contract`, { planName: 'Plan', monthlyCents: 3000, paymentMethod: 'direct_debit', iban: 'ES79 2100 0813 6101 2345 6789', mandateRef: 'MANDATO-001', mandateDate: '2026-01-15' })).json();
    expect(c.iban_enc).toBeUndefined();
    expect(c.iban_last4).toBe('6789');
    const [raw] = await sql`select iban_enc from contracts where establishment_id = ${est}`;
    expect(raw.iban_enc).not.toContain('2100');
    await call(gestor, 'POST', '/api/platform/invoices/generate', { period: month() });
    const cand = (await call(gestor, 'GET', '/api/platform/remittances/candidates')).json();
    expect(cand).toHaveLength(1);
    expect(cand[0]).toMatchObject({ ready: true, iban_last4: '6789', total_cents: 3630 });
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    expect((await call(gestor, 'POST', '/api/platform/remittances', { invoiceIds: [cand[0].id], collectionDate: today })).json().error).toBe('collection_date');
    const later = new Date(Date.now() + 5 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const rem = (await call(gestor, 'POST', '/api/platform/remittances', { invoiceIds: [cand[0].id], collectionDate: later })).json();
    expect(rem).toMatchObject({ count: 1, totalCents: 3630 });
    const xml = (await call(gestor, 'GET', `/api/platform/remittances/${rem.id}/xml`)).body;
    expect(xml).toContain(`<IBAN>${CLIENT_IBAN}</IBAN>`);
    expect(xml).toContain('<CtrlSum>36.30</CtrlSum>');
    expect(xml).toMatch(/<CdtrSchmeId><Id><PrvtId><Othr><Id>ES\d{2}000B99999999<\/Id>/);
    expect((await call(gestor, 'GET', '/api/platform/remittances/candidates')).json()).toHaveLength(0);
    expect((await call(gestor, 'POST', '/api/platform/remittances', { invoiceIds: [cand[0].id], collectionDate: later })).json().error).toBe('not_collectable');
    await call(gestor, 'POST', `/api/platform/remittances/${rem.id}/collected`);
    let [inv] = (await call(gestor, 'GET', '/api/platform/invoices')).json();
    expect(inv).toMatchObject({ status: 'paid', paid_method: 'Domiciliación SEPA', paid_at: later });
    // El banco devuelve el recibo: vuelve a estar pendiente, cuenta como impago y puede ir en otra remesa.
    await call(gestor, 'POST', `/api/platform/invoices/${inv.id}/returned`);
    [inv] = (await call(gestor, 'GET', '/api/platform/invoices')).json();
    expect(inv).toMatchObject({ status: 'issued', remittance_id: null });
    expect(inv.returned_at).toBeTruthy();
    expect((await call(gestor, 'GET', '/api/platform/summary')).json().returned).toBe(1);
    expect((await call(gestor, 'GET', '/api/platform/remittances/candidates')).json()).toHaveLength(1);
  });
});
