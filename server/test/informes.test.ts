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
let waiter: string;
const T: string[] = [];
const P: Record<string, string> = {};
let seq = 0;
const rid = () => `inf-${Date.now()}-${++seq}`;
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

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
  const [c] = await sql`insert into categories (establishment_id, name) values (${est}, 'Bebidas') returning id`;
  for (const [k, name, price, cat] of [['cana', 'Caña', 250, c.id], ['plato', 'Plato', 1000, null]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate, category_id) values (${est}, ${name}, ${price}, 10, ${cat}) returning id`;
    P[k] = p.id;
  }
  T.length = 0;
  for (const l of ['1', '2', '3']) { const [t] = await sql`insert into tables (establishment_id, label) values (${est}, ${l}) returning id`; T.push(t.id); }
  admin = String((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'secreto123' } })).headers['set-cookie']).split(';')[0];
  waiter = String((await app.inject({ method: 'POST', url: '/api/auth/waiter', payload: { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true } })).headers['set-cookie']).split(';')[0];
});

async function sale(tableId: string, items: object[], method: string, close = true) {
  const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items })).json();
  const acc = (await call(waiter, 'GET', `/api/service/accounts/${o.accountId}`)).json();
  await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
  if (close) await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/payments`, { idempotencyKey: rid(), method, amountCents: acc.totalCents });
}

describe('informe de ventas', () => {
  it('por producto, categoría, forma de pago y camarero; solo cuentas cobradas', async () => {
    await sale(T[0], [{ productId: P.cana, qty: 4 }, { productId: P.plato, qty: 1 }], 'cash');   // 20,00
    await sale(T[1], [{ productId: P.cana, qty: 2 }], 'card');                                     // 5,00
    await sale(T[2], [{ productId: P.plato, qty: 3 }], 'cash', false);                             // abierta: no cuenta
    const r = (await call(admin, 'GET', `/api/reports/sales?from=${today()}&to=${today()}`)).json();
    expect(r.kpi).toMatchObject({ tickets: 2, total_cents: 2500, averageTicketCents: 1250 });
    expect(r.byProduct).toEqual([
      { name: 'Caña', category: 'Bebidas', qty: 6, gross_cents: 1500, net_cents: 1364 },
      { name: 'Plato', category: 'Sin categoría', qty: 1, gross_cents: 1000, net_cents: 909 },
    ]);
    expect(r.byCategory[0]).toMatchObject({ category: 'Bebidas', qty: 6, gross_cents: 1500 });
    expect(r.byMethod).toEqual([{ method: 'cash', count: 1, cents: 2000 }, { method: 'card', count: 1, cents: 500 }]);
    expect(r.byWaiter[0]).toMatchObject({ name: 'Ana', taken_cents: 2500, payments: 2, collected_cents: 2500 });
    expect(r.byHour.reduce((s: number, h: { cents: number }) => s + h.cents, 0)).toBe(2500);
    expect(r.byDay).toEqual([{ day: today(), tickets: 2, cents: 2500 }]);
  });

  it('CSV para Excel con secciones, decimales con coma y BOM; solo con permiso de caja', async () => {
    await sale(T[0], [{ productId: P.cana, qty: 2 }], 'bizum');
    const res = await call(admin, 'GET', `/api/reports/sales.csv?from=${today()}&to=${today()}`);
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain('Total cobrado (€);5,00');
    expect(res.body).toContain('Caña;Bebidas;2;5,00;4,55');
    expect(res.body).toContain('Bizum;1;5,00');
    expect((await call(waiter, 'GET', `/api/reports/sales?from=${today()}&to=${today()}`)).statusCode).toBe(403);
  });
});
