import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { applyRetention, LEGAL_VERSION } from '../src/services/legal.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let waiter: string;
let tableId: string;
let seq = 0;
const rid = () => `rgpd-${Date.now()}-${++seq}`;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });
const pub = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload });
const tomorrow = () => new Date(Date.now() + 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const consents = (id: string) => sql`select purpose, granted, source, text_version from consent_log where subject_id = ${id} order by id`;

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Casa Demo') returning id`;
  est = e.id;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning id`;
  tableId = t.id;
  admin = cookieOf(await pub('POST', '/api/auth/login', { username: 'admin', password: 'secreto123' }));
  waiter = cookieOf(await pub('POST', '/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true }));
  await call(admin, 'PUT', '/api/integrations/whatsapp', { enabled: true, provider: 'link', templates: { reservation_confirmed: 'a', reservation_reminder: 'b', waitlist_ready: 'c' },
    events: { reservationConfirmed: true, reservationReminder: true, reminderHours: 3, waitlistReady: true } });
});

describe('textos legales', () => {
  it('se generan con los datos del local y avisan de lo que falta', async () => {
    let t = (await pub('GET', '/api/public/legal/demo')).json();
    expect(t.incomplete).toEqual(['Razón social o nombre del titular', 'NIF / CIF', 'Dirección completa', 'Correo de contacto']);
    await call(admin, 'PUT', '/api/admin/establishment', { legalName: 'Hostelería Laurel S.L.', taxId: 'B12345678', address: 'C/ Mayor 1', postalCode: '28001', city: 'Madrid', email: 'hola@laurel.es',
      privacy: { contactEmail: 'privacidad@laurel.es', registry: 'Inscrita en el Registro Mercantil de Madrid, tomo 1, folio 2, hoja M-3', reservationMonths: 6 } });
    t = (await pub('GET', '/api/public/legal/demo')).json();
    expect(t.incomplete).toEqual([]);
    expect(t.version).toBe(LEGAL_VERSION);
    const all = JSON.stringify(t);
    expect(all).toContain('Hostelería Laurel S.L. (NIF B12345678)');
    expect(all).toContain('privacidad@laurel.es');
    expect(all).toContain('Registro Mercantil de Madrid');
    expect(t.layers.reservation).toContain('hasta 6 meses');
    expect(all).toContain('www.aepd.es');
    expect((await call(admin, 'PUT', '/api/admin/establishment', { privacy: { contactEmail: 'no-es-correo' } })).statusCode).toBe(400);
  });
});

describe('consentimientos', () => {
  it('reserva en línea: exige aceptar la privacidad y guarda la prueba; WhatsApp solo si se acepta', async () => {
    const info = (await pub('GET', '/api/public/booking/demo')).json();
    expect(info.privacyNotice).toContain('Responsable: Casa Demo');
    expect(info.whatsappNotice).toContain('WhatsApp');
    const base = { name: 'Laura', phone: '600000000', partySize: 2, date: tomorrow(), time: '21:00' };
    const no = await pub('POST', '/api/public/booking/demo', base);
    expect(no.statusCode).toBe(400);
    expect(no.json().message).toContain('política de privacidad');
    const a = (await pub('POST', '/api/public/booking/demo', { ...base, acceptPrivacy: true })).json();
    const b = (await pub('POST', '/api/public/booking/demo', { ...base, name: 'Marta', acceptPrivacy: true, whatsappConsent: true })).json();
    expect(await consents(a.id)).toEqual([{ purpose: 'privacy', granted: true, source: 'public', text_version: LEGAL_VERSION }]);
    expect((await consents(b.id)).map((c) => c.purpose)).toEqual(['privacy', 'whatsapp']);
    // Al confirmar, solo se prepara WhatsApp para quien lo aceptó.
    expect((await call(admin, 'PATCH', `/api/reservations/${a.id}`, { status: 'confirmed' })).json().message).toBeNull();
    expect((await call(admin, 'PATCH', `/api/reservations/${b.id}`, { status: 'confirmed' })).json().message.status).toBe('manual');
  });

  it('reserva por teléfono y lista de espera: sin la casilla no hay WhatsApp; retirar el permiso queda registrado', async () => {
    const r = (await call(admin, 'POST', '/api/reservations', { name: 'Gil', phone: '611111111', partySize: 2, date: tomorrow(), time: '21:00' })).json();
    expect(r.message).toBeNull();
    const r2 = (await call(admin, 'POST', '/api/reservations', { name: 'Ruiz', phone: '622222222', partySize: 2, date: tomorrow(), time: '21:30', whatsappConsent: true })).json();
    expect(r2.message.status).toBe('manual');
    await call(admin, 'PATCH', `/api/reservations/${r2.id}`, { whatsappConsent: false });
    expect((await consents(r2.id)).map((c) => [c.purpose, c.granted, c.source])).toEqual([['whatsapp', true, 'staff'], ['whatsapp', false, 'staff']]);
    const g = (await call(waiter, 'POST', '/api/waitlist', { name: 'Pedro', partySize: 2, phone: '633333333' })).json();
    expect((await call(waiter, 'POST', `/api/waitlist/${g.id}/assign`, { tableIds: [tableId] })).json().message).toBeNull();
  });
});

describe('fidelización: alta, acceso y supresión', () => {
  it('el alta exige informar al cliente; exportar sus datos; suprimir conserva la venta sin la persona', async () => {
    expect((await call(waiter, 'POST', '/api/loyalty/customers', { name: 'Lucía', phone: '600111222' })).statusCode).toBe(400);
    const c = (await call(waiter, 'POST', '/api/loyalty/customers', { name: 'Lucía Pérez', phone: '600111222', email: 'l@p.es', privacyAccepted: true, marketingConsent: true })).json();
    expect(c.privacy_accepted_at).toBeTruthy();
    // Una venta asociada a la clienta.
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate) values (${est}, 'Caña', 250, 10) returning id`;
    const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId: p.id, qty: 2 }] })).json();
    await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/customer`, { customerId: c.id });
    const exp = await call(admin, 'GET', `/api/loyalty/customers/${c.id}/export`);
    expect(exp.headers['content-disposition']).toContain('attachment');
    const data = exp.json();
    expect(data.cliente).toMatchObject({ name: 'Lucía Pérez', phone: '600111222', email: 'l@p.es', marketing_consent: true });
    expect(data.consentimientos.map((x: { purpose: string }) => x.purpose)).toEqual(['privacy', 'marketing']);
    expect((await call(waiter, 'GET', `/api/loyalty/customers/${c.id}/export`)).statusCode).toBe(403);

    expect((await call(admin, 'POST', `/api/loyalty/customers/${c.id}/erase`)).json()).toEqual({ ok: true });
    expect(await sql`select 1 from customers where id = ${c.id}`).toHaveLength(0);
    const [acc] = await sql`select customer_id from accounts where id = ${o.accountId}`;
    expect(acc.customer_id).toBeNull();
    const [log] = await sql`select actor, detail from audit_log where action = 'customer.erase'`;
    expect(JSON.stringify(log)).not.toContain('Lucía');
    expect((await consents(c.id)).at(-1)).toMatchObject({ purpose: 'privacy', granted: false });
  });

  it('desde la tarjeta digital el cliente deja de recibir ofertas o se da de baja', async () => {
    const c = (await call(waiter, 'POST', '/api/loyalty/customers', { name: 'Mario Gil', phone: '611', privacyAccepted: true, marketingConsent: true })).json();
    const card = (await pub('GET', `/api/public/card/${c.card_token}`)).json();
    expect(card).toMatchObject({ slug: 'demo', marketingConsent: true });
    await pub('POST', `/api/public/card/${c.card_token}/marketing`, { consent: false });
    expect((await pub('GET', `/api/public/card/${c.card_token}`)).json().marketingConsent).toBe(false);
    expect((await consents(c.id)).at(-1)).toMatchObject({ purpose: 'marketing', granted: false, source: 'card' });
    expect((await pub('POST', `/api/public/card/${c.card_token}/erase`)).json()).toEqual({ ok: true });
    expect((await pub('GET', `/api/public/card/${c.card_token}`)).statusCode).toBe(404);
  });
});

describe('plazos de conservación', () => {
  it('anonimiza reservas antiguas, borra la lista de espera cerrada y el registro de avisos según los plazos del local', async () => {
    await call(admin, 'PUT', '/api/admin/establishment', { privacy: { reservationMonths: 3, waitlistDays: 10, messageLogMonths: 2 } });
    const old = new Date(Date.now() - 100 * 86_400_000);
    const recent = new Date(Date.now() - 20 * 86_400_000);
    await sql`insert into reservations (establishment_id, name, phone, email, notes, party_size, starts_at, status, whatsapp_consent) values
      (${est}, 'Vieja', '600', 'v@x.es', 'alergia al marisco', 4, ${old}, 'finished', true), (${est}, 'Reciente', '611', '', '', 2, ${recent}, 'finished', false)`;
    await sql`insert into waitlist (establishment_id, name, party_size, phone, status, created_at, closed_at) values
      (${est}, 'Espera vieja', 2, '622', 'seated', ${recent}, ${recent}), (${est}, 'Esperando', 2, '633', 'waiting', ${recent}, null)`;
    await sql`insert into message_log (establishment_id, event, to_phone, body, provider, status, created_at) values
      (${est}, 'test', '34600', 'hola', 'link', 'manual', ${old}), (${est}, 'test', '34611', 'hola', 'link', 'manual', now())`;
    expect(await applyRetention()).toEqual({ reservations: 1, waitlist: 1, messages: 1 });
    const res = await sql`select name, phone, email, notes, party_size, anonymized_at is not null as anon from reservations order by starts_at`;
    expect(res[0]).toMatchObject({ name: 'Reserva anonimizada', phone: '', email: '', notes: '', party_size: 4, anon: true });
    expect(res[1]).toMatchObject({ name: 'Reciente', anon: false });
    expect((await sql`select name, phone from waitlist order by name`).map((w) => w.phone)).toEqual(['', '633']);
    expect(await sql`select 1 from message_log`).toHaveLength(1);
    expect(await applyRetention()).toEqual({ reservations: 0, waitlist: 0, messages: 0 });
  });
});
