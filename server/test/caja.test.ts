import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let tpvUser: string;
let waiter: string;
let tableId: string;
let productId: string;
let seq = 0;
const rid = () => `cj-${Date.now()}-${++seq}`;
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}

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
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Encargada', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role, permissions) values (${est}, 'tpv', 'Caja barra', ${await hashPassword('secreto123')}, 'staff', ${['tpv']})`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate) values (${est}, 'Menú', 1100, 10) returning id`;
  productId = p.id;
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning id`;
  tableId = t.id;
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  tpvUser = await login('/api/auth/login', { username: 'tpv', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true });
});

async function sale(method: 'cash' | 'card' | 'bizum', qty = 1, tendered?: number) {
  const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId, qty }] })).json();
  const acc = (await call(waiter, 'GET', `/api/service/accounts/${o.accountId}`)).json();
  await call(waiter, 'PATCH' as 'POST', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
  const r = await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/payments`, { idempotencyKey: rid(), method, amountCents: 1100 * qty, tenderedCents: tendered });
  expect(r.statusCode, r.body).toBe(200);
}

describe('caja', () => {
  it('apertura con fondo, cobros, entradas y salidas, recuento ciego, descuadre y cierre Z correlativo', async () => {
    expect((await call(tpvUser, 'GET', '/api/cash/current')).json().session).toBeNull();
    expect((await call(waiter, 'POST', '/api/cash/open', { floatCents: 10000 })).statusCode).toBe(403);
    expect((await call(tpvUser, 'POST', '/api/cash/open', { floatCents: 15000 })).statusCode).toBe(200);
    expect((await call(tpvUser, 'POST', '/api/cash/open', { floatCents: 15000 })).json().error).toBe('cash_open');
    await sale('cash', 2, 5000);      // 22,00 en efectivo (el cambio no cuenta)
    await sale('card');               // 11,00
    await sale('bizum');              // 11,00
    await call(tpvUser, 'POST', '/api/cash/movements', { kind: 'out', amountCents: 3000, reason: 'Pago al panadero' });
    await call(tpvUser, 'POST', '/api/cash/movements', { kind: 'in', amountCents: 1000, reason: 'Cambio del banco' });
    expect((await call(tpvUser, 'POST', '/api/cash/movements', { kind: 'out', amountCents: 999999, reason: 'Demasiado' })).json().error).toBe('not_enough_cash');
    const cur = (await call(tpvUser, 'GET', '/api/cash/current')).json();
    expect(cur.summary.expectedCashCents).toBe(15000 + 2200 + 1000 - 3000);
    expect(cur.summary.byMethod).toEqual({ cash: { count: 1, cents: 2200 }, card: { count: 1, cents: 1100 }, bizum: { count: 1, cents: 1100 } });
    // el cierre lo hace el encargado (módulo Ventas y caja), no la caja del TPV
    expect((await call(tpvUser, 'POST', '/api/cash/close', { countedCashCents: 15000 })).statusCode).toBe(403);
    const z = (await call(admin, 'POST', '/api/cash/close', { countedCashCents: 15150, detail: { '50': 2, '20': 2, '10': 1, '0.5': 3 }, notes: 'Falta revisar' })).json();
    expect(z).toMatchObject({ number: 1, status: 'closed', expected_cash_cents: 15200, counted_cash_cents: 15150, difference_cents: -50 });
    expect(z.report).toMatchObject({ totalCents: 4400, documents: { simplified: 3, full: 0 } });
    expect(z.report.vat[0]).toMatchObject({ rate: 10, totalCents: 4400 });
    expect(z.report.byWaiter[0]).toMatchObject({ name: 'Ana', count: 3, cents: 4400 });
    // segunda caja: número 2
    await call(tpvUser, 'POST', '/api/cash/open', { floatCents: 15000 });
    const z2 = (await call(admin, 'POST', '/api/cash/close', { countedCashCents: 15000 })).json();
    expect(z2).toMatchObject({ number: 2, difference_cents: 0 });
    expect((await call(admin, 'GET', '/api/cash/sessions')).json().map((s: { number: number }) => s.number)).toEqual([2, 1]);
  });

  it('los cobros con la caja cerrada no se pierden: pasan a la siguiente caja que se abra', async () => {
    await sale('cash');
    const s = (await call(tpvUser, 'POST', '/api/cash/open', { floatCents: 0 })).json();
    const cur = (await call(tpvUser, 'GET', '/api/cash/current')).json();
    expect(cur.session.id).toBe(s.id);
    expect(cur.summary.byMethod.cash.cents).toBe(1100);
  });

  it('cajón y cierre Z en la impresora de tickets', async () => {
    const pr = (await call(admin, 'POST', '/api/printing/printers', { name: 'Caja', connection: 'tcp', address: '192.168.1.60', roles: ['ticket'] })).json();
    await call(tpvUser, 'POST', '/api/cash/open', { floatCents: 5000 });
    await sale('cash');                                   // abre el cajón automáticamente
    await call(tpvUser, 'POST', '/api/cash/drawer');      // apertura manual (queda registrada)
    await call(admin, 'POST', '/api/cash/close', { countedCashCents: 6100 });
    const jobs = await sql`select kind, payload from print_jobs where printer_id = ${pr.id} order by created_at`;
    expect(jobs.map((j) => j.kind)).toEqual(['drawer', 'drawer', 'closing']);
    expect([...jobs[0].payload.subarray(2, 7)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    const z = jobs[2].payload.toString('latin1');
    expect(z).toContain('CIERRE Z 1');
    expect(z).toContain('DESCUADRE');
    const [{ n }] = await sql`select count(*)::int as n from audit_log where action = 'cash.drawer'`;
    expect(n).toBe(1);
  });
});
