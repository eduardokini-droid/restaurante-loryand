import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { newOrderCode, parseNotification, sign } from '../src/services/redsys.js';
import { decryptSecret, encryptSecret } from '../src/services/secrets.js';
import { normalizePhone, sendDueReminders, setMessagingFetch } from '../src/services/messaging.js';

// Clave pública del entorno de pruebas de Redsys (comercio 999008881, terminal 001).
const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
let app: FastifyInstance;
let est: string;
let admin: string;
let waiter: string;
let tableId: string;
let tableToken: string;
let accessCode: string;
let productId: string;
let seq = 0;
const rid = () => `f4-${Date.now()}-${++seq}`;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
/** Simula la notificación que Redsys envía al servidor. */
function bankNotify(order: string, amount: number, response = '0000', key = TEST_KEY) {
  const params = Buffer.from(JSON.stringify({ Ds_Order: order, Ds_Amount: String(amount), Ds_Response: response, Ds_AuthorisationCode: '123456', Ds_Currency: '978' })).toString('base64');
  const signature = sign(key, order, params).replace(/\+/g, '-').replace(/\//g, '_');
  return app.inject({ method: 'POST', url: '/api/redsys/notify', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: params, Ds_Signature: signature }).toString() });
}

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  setMessagingFetch(fetch);
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Casa Demo') returning id`;
  est = e.id;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  const [p] = await sql`insert into products (establishment_id, name, price_cents) values (${est}, 'Plato', 1250) returning id`;
  productId = p.id;
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning id, qr_token, access_code`;
  tableId = t.id; tableToken = t.qr_token; accessCode = t.access_code;
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234' });
  await call(waiter, 'POST', '/api/service/shift/start');
});

async function enableRedsys(extra: object = {}) {
  const r = await call(admin, 'PUT', '/api/integrations/redsys', { enabled: true, merchantCode: '999008881', terminal: '1', environment: 'test', card: true, bizum: true, secret: TEST_KEY, ...extra });
  expect(r.statusCode, r.body).toBe(200);
}
async function openAccount() {
  const r = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId, qty: 2 }] });
  return r.json().accountId as string;
}

describe('firma Redsys', () => {
  it('firma y verifica; detecta manipulaciones', () => {
    const order = newOrderCode();
    expect(order).toMatch(/^\d{4}[0-9A-Z]{8}$/);
    const params = Buffer.from(JSON.stringify({ Ds_Order: order, Ds_Amount: '2500', Ds_Response: '0000' })).toString('base64');
    const s = sign(TEST_KEY, order, params);
    expect(s).toHaveLength(44);
    expect(parseNotification(TEST_KEY, params, s)?.amountCents).toBe(2500);
    const tampered = Buffer.from(JSON.stringify({ Ds_Order: order, Ds_Amount: '1', Ds_Response: '0000' })).toString('base64');
    expect(parseNotification(TEST_KEY, tampered, s)).toBeNull();
    expect(parseNotification('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', params, s)).toBeNull();
  });

  it('la clave se guarda cifrada y nunca se devuelve completa', async () => {
    expect(decryptSecret(encryptSecret('hola'))).toBe('hola');
    await enableRedsys();
    const [row] = await sql`select secret_enc, config from integrations where kind = 'redsys'`;
    expect(row.secret_enc).not.toContain(TEST_KEY);
    expect(row.config.terminal).toBe('001');
    const view = (await call(admin, 'GET', '/api/integrations')).json();
    expect(view.redsys.secret).toBe('••••gJ7'.replace('••••gJ7', `••••${TEST_KEY.slice(-4)}`));
    expect(JSON.stringify(view)).not.toContain(TEST_KEY);
    expect((await call(waiter, 'GET', '/api/integrations')).statusCode).toBe(403);
  });
});

describe('cobro online', () => {
  it('flujo completo: QR, formulario Redsys con Bizum, notificación del banco y ticket', async () => {
    await enableRedsys();
    const accountId = await openAccount();
    const qr = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    expect(qr.amountCents).toBe(2500);
    // mientras el pago online está en curso no se puede cobrar a mano
    const cash = await call(waiter, 'POST', `/api/service/accounts/${accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 2500 });
    expect(cash.json().error).toBe('online_pending');
    const page = (await app.inject({ method: 'GET', url: `/api/public/pay/${qr.token}` })).json();
    expect(page).toMatchObject({ amountCents: 2500, environment: 'test', status: 'pending', place: 'Mesa 1' });
    const form = (await app.inject({ method: 'POST', url: `/api/public/pay/${qr.token}/start`, payload: { method: 'bizum' } })).json();
    expect(form.url).toBe('https://sis-t.redsys.es:25443/sis/realizarPago');
    const params = JSON.parse(Buffer.from(form.fields.Ds_MerchantParameters, 'base64').toString());
    expect(params).toMatchObject({ DS_MERCHANT_AMOUNT: '2500', DS_MERCHANT_MERCHANTCODE: '999008881', DS_MERCHANT_TERMINAL: '001', DS_MERCHANT_PAYMETHODS: 'z', DS_MERCHANT_CURRENCY: '978' });
    expect(params.DS_MERCHANT_MERCHANTURL).toMatch(/\/api\/redsys\/notify$/);
    expect(form.fields.Ds_SignatureVersion).toBe('HMAC_SHA256_V1');
    expect(form.fields.Ds_Signature).toBe(sign(TEST_KEY, params.DS_MERCHANT_ORDER, form.fields.Ds_MerchantParameters));
    // los platos no están entregados, pero el banco ya ha cobrado: el pago se aplica igualmente
    const r = await bankNotify(params.DS_MERCHANT_ORDER, 2500);
    expect(r.body).toBe('OK');
    await bankNotify(params.DS_MERCHANT_ORDER, 2500); // notificación repetida: no duplica
    const pays = await sql`select method, amount_cents from payments where account_id = ${accountId}`;
    expect(pays).toEqual([{ method: 'bizum', amount_cents: 2500 }]);
    const [acc] = await sql`select status from accounts where id = ${accountId}`;
    expect(acc.status).toBe('paid');
    expect((await app.inject({ method: 'GET', url: `/api/public/pay/${qr.token}` })).json().status).toBe('paid');
    const [doc] = await sql`select type from documents where account_id = ${accountId}`;
    expect(doc.type).toBe('simplified');
  });

  it('firma falsa: se ignora; denegada: la cuenta sigue abierta y se puede cobrar a mano', async () => {
    await enableRedsys();
    const accountId = await openAccount();
    const qr = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    const [op] = await sql`select order_code from online_payments where token = ${qr.token}`;
    expect((await bankNotify(op.order_code, 2500, '0000', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')).body).toBe('KO');
    expect((await bankNotify(op.order_code, 2500, '0190')).body).toBe('OK');
    const [x] = await sql`select status from online_payments where token = ${qr.token}`;
    expect(x.status).toBe('failed');
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${accountId}`)).json();
    await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
    const cash = await call(waiter, 'POST', `/api/service/accounts/${accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 2500 });
    expect(cash.statusCode).toBe(200);
  });

  it('si se cobra en efectivo tras retirar el QR y luego el banco confirma, queda en conflicto para devolver', async () => {
    await enableRedsys();
    const accountId = await openAccount();
    const qr = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    const [op] = await sql`select id, order_code from online_payments where token = ${qr.token}`;
    expect((await call(waiter, 'POST', `/api/service/online-payments/${op.id}/cancel`)).statusCode).toBe(200);
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${accountId}`)).json();
    await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
    await call(waiter, 'POST', `/api/service/accounts/${accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 2500 });
    await bankNotify(op.order_code, 2500);
    const [x] = await sql`select status, error from online_payments where id = ${op.id}`;
    expect(x.status).toBe('conflict');
    const [{ total }] = await sql`select sum(amount_cents)::int as total from payments where account_id = ${accountId}`;
    expect(total).toBe(2500); // no se ha cobrado dos veces en el programa
    const today = new Date().toISOString().slice(0, 10);
    const rep = (await call(admin, 'GET', `/api/reports/cash?from=${today}&to=${today}`)).json();
    expect(rep.onlineConflicts).toHaveLength(1);
  });

  it('el QR fija el importe: si se añaden consumiciones, se genera otro y el anterior se retira', async () => {
    await enableRedsys();
    const accountId = await openAccount();
    const a = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    const again = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    expect(again.token).toBe(a.token);
    await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { accountId }, items: [{ productId, qty: 1 }] });
    const b = (await call(waiter, 'POST', `/api/service/accounts/${accountId}/online-payment`)).json();
    expect(b.amountCents).toBe(3750);
    const [old] = await sql`select status from online_payments where token = ${a.token}`;
    expect(old.status).toBe('cancelled');
    expect((await app.inject({ method: 'POST', url: `/api/public/pay/${a.token}/start`, payload: { method: 'card' } })).json().error).toBe('not_pending');
  });

  it('"Pagar mi cuenta" desde la carta exige la clave y que el cobro online esté activo', async () => {
    const accountId = await openAccount();
    void accountId;
    const off = await app.inject({ method: 'POST', url: `/api/public/table/${tableToken}/pay`, payload: { accessCode } });
    expect(off.json().error).toBe('online_disabled');
    await enableRedsys({ bizum: false });
    expect((await app.inject({ method: 'GET', url: `/api/public/table/${tableToken}` })).json().onlinePayment).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/public/table/${tableToken}/pay`, payload: { accessCode: 'x' } })).json().error).toBe('bad_code');
    const ok = (await app.inject({ method: 'POST', url: `/api/public/table/${tableToken}/pay`, payload: { accessCode } })).json();
    expect(ok.token).toMatch(/^[a-f0-9]{32}$/);
    expect((await app.inject({ method: 'POST', url: `/api/public/pay/${ok.token}/start`, payload: { method: 'bizum' } })).json().error).toBe('method_disabled');
  });
});

describe('WhatsApp', () => {
  it('normaliza teléfonos españoles e internacionales', () => {
    expect(normalizePhone('600 12 31 23')).toBe('34600123123');
    expect(normalizePhone('+44 7700 900123')).toBe('447700900123');
    expect(normalizePhone('0033 6 12 34 56 78')).toBe('33612345678');
    expect(normalizePhone('123')).toBeNull();
  });

  it('modo enlace: al confirmar una reserva prepara el mensaje de WhatsApp', async () => {
    await call(admin, 'PUT', '/api/integrations/whatsapp', { enabled: true, provider: 'link', templates: { reservation_confirmed: 'a', reservation_reminder: 'b', waitlist_ready: 'c' }, events: { reservationConfirmed: true, reservationReminder: true, reminderHours: 3, waitlistReady: true } });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = (await call(admin, 'POST', '/api/reservations', { whatsappConsent: true, name: 'Laura', phone: '600 123 123', partySize: 4, date: tomorrow, time: '21:00' })).json();
    expect(r.message.status).toBe('manual');
    expect(r.message.link).toMatch(/^https:\/\/wa\.me\/34600123123\?text=Hola%20Laura/);
    expect(decodeURIComponent(r.message.link)).toContain('21:00');
    const log = (await call(admin, 'GET', '/api/messages')).json();
    expect(log[0]).toMatchObject({ event: 'reservation_confirmed', status: 'manual', customer: 'Laura' });
  });

  it('modo automático (Meta): plantilla con parámetros, y enlace de respaldo si falla', async () => {
    const sent: any[] = [];
    let fail = false;
    setMessagingFetch((async (url: string, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return fail ? { ok: false, status: 400, json: async () => ({ error: { message: 'Plantilla no aprobada' } }) } : { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    await call(admin, 'PUT', '/api/integrations/whatsapp', { enabled: true, provider: 'meta', phoneNumberId: '1234567890', token: 'EAAB-token-de-prueba-123456',
      templates: { reservation_confirmed: 'reserva_confirmada', reservation_reminder: 'recordatorio_reserva', waitlist_ready: 'mesa_lista' },
      events: { reservationConfirmed: true, reservationReminder: true, reminderHours: 3, waitlistReady: true } });
    const g = (await call(waiter, 'POST', '/api/waitlist', { name: 'Pedro', partySize: 2, phone: '611222333', whatsappConsent: true })).json();
    const a = (await call(waiter, 'POST', `/api/waitlist/${g.id}/assign`, { tableIds: [tableId] })).json();
    expect(a.message.status).toBe('sent');
    expect(sent[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(sent[0].auth).toBe('Bearer EAAB-token-de-prueba-123456');
    expect(sent[0].body.template).toMatchObject({ name: 'mesa_lista', language: { code: 'es' } });
    expect(sent[0].body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Pedro', 'Casa Demo', 'mesa 1']);
    fail = true;
    const test = (await call(admin, 'POST', '/api/integrations/whatsapp/test', { phone: '600000000' })).json();
    expect(test).toMatchObject({ status: 'failed', error: 'Plantilla no aprobada' });
    expect(test.link).toMatch(/^https:\/\/wa\.me\/34600000000/);
  });

  it('recordatorio automático una sola vez por reserva', async () => {
    const sent: string[] = [];
    setMessagingFetch((async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body).template.name); return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch);
    await call(admin, 'PUT', '/api/integrations/whatsapp', { enabled: true, provider: 'meta', phoneNumberId: '1', token: 'EAAB-token-de-prueba-123456',
      templates: { reservation_confirmed: 'reserva_confirmada', reservation_reminder: 'recordatorio_reserva', waitlist_ready: 'mesa_lista' },
      events: { reservationConfirmed: false, reservationReminder: true, reminderHours: 3, waitlistReady: true } });
    const soon = new Date(Date.now() + 2 * 3600_000);
    const later = new Date(Date.now() + 10 * 3600_000);
    await sql`insert into reservations (establishment_id, name, phone, party_size, starts_at, status, whatsapp_consent) values
      (${est}, 'Pronto', '600111111', 2, ${soon}, 'confirmed', true), (${est}, 'Tarde', '600222222', 2, ${later}, 'confirmed', true),
      (${est}, 'Solicitud', '600333333', 2, ${soon}, 'requested', true), (${est}, 'Sin permiso', '600444444', 2, ${soon}, 'confirmed', false)`;
    expect(await sendDueReminders()).toBe(1);
    expect(await sendDueReminders()).toBe(0);
    expect(sent).toEqual(['recordatorio_reserva']);
  });
});

describe('seguridad', () => {
  it('solo la notificación de Redsys acepta formularios web; el resto de la API exige JSON', async () => {
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie: admin };
    const r = await app.inject({ method: 'POST', url: '/api/admin/users', headers: form, payload: 'name=Intruso&username=intruso&password=12345678' });
    expect(r.statusCode).toBe(415);
    const p = await app.inject({ method: 'PUT', url: '/api/integrations/redsys', headers: form, payload: 'enabled=true' });
    expect(p.statusCode).toBe(415);
    const n = await app.inject({ method: 'POST', url: '/api/redsys/notify', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'Ds_MerchantParameters=x&Ds_Signature=y' });
    expect(n.body).toBe('KO');
  });
});
