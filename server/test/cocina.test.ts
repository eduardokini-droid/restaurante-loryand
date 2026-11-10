import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';

let app: FastifyInstance;
let est: string;
let cocina: string;
let waiter: string;
let admin: string;
let table: string;
const P: Record<string, string> = {};
let seq = 0;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });
const board = async () => (await call(cocina, 'GET', '/api/kds/kitchen/board')).json();
const statusOf = (b: { items: { name: string; status: string }[] }, name: string) => b.items.find((i) => i.name === name)?.status;

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Demo') returning id`;
  est = e.id;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role, permissions) values (${est}, 'cocina', 'Cocina', ${await hashPassword('cocina1234')}, 'staff', '{kitchen}')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  for (const [k, name, course] of [['croq', 'Croquetas', 1], ['entre', 'Entrecot', 2]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate, destination, course) values (${est}, ${name}, 1000, 10, 'kitchen', ${course}) returning id`;
    P[k] = p.id;
  }
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '4') returning id`;
  table = t.id;
  const login = async (username: string, password: string) => cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } }));
  admin = await login('admin', 'secreto123');
  cocina = await login('cocina', 'cocina1234');
  waiter = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/waiter', payload: { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true } }));
});

describe('pantalla de cocina por columnas', () => {
  it('pase retenido en espera, tiempos desde que llega a cocina y entregados recientes', async () => {
    const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: `k-${Date.now()}-${++seq}`, target: { tableId: table }, items: [{ productId: P.croq, qty: 2 }, { productId: P.entre, qty: 1 }] })).json();
    let b = await board();
    expect(b).toMatchObject({ warnMin: 10, lateMin: 20 });
    expect(statusOf(b, 'Croquetas')).toBe('new');
    expect(statusOf(b, 'Entrecot')).toBe('held');
    expect(b.items.find((i: { name: string }) => i.name === 'Entrecot').sent_at).toBeNull();
    expect(b.items[0]).toMatchObject({ place: 'Mesa 4', waiter_name: 'Ana', number: o.number });
    // Al marchar el segundo pase, su tiempo empieza a contar entonces.
    await sql`update order_items set sent_at = now() - interval '25 minutes' where name = 'Croquetas'`;
    await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/fire`);
    b = await board();
    const entre = b.items.find((i: { name: string }) => i.name === 'Entrecot');
    expect(entre.status).toBe('new');
    expect(Date.now() - new Date(entre.sent_at).getTime()).toBeLessThan(60_000);
    // Columnas: preparar, listo y entregado; lo entregado sigue a la vista un rato.
    const croq = b.items.find((i: { name: string }) => i.name === 'Croquetas').id;
    await call(cocina, 'PATCH', '/api/service/items', { itemIds: [croq], status: 'preparing' });
    await call(cocina, 'PATCH', '/api/service/items', { itemIds: [croq], status: 'ready' });
    await call(cocina, 'PATCH', '/api/service/items', { itemIds: [croq], status: 'delivered' });
    b = await board();
    expect(statusOf(b, 'Croquetas')).toBe('delivered');
    await sql`update order_items set status_at = now() - interval '31 minutes' where id = ${croq}`;
    expect(statusOf(await board(), 'Croquetas')).toBeUndefined();
    // Los avisos de tiempo se ajustan por local.
    await call(admin, 'PUT', '/api/admin/establishment', { settings: { kdsWarnMin: 8, kdsLateMin: 15 } });
    expect(await board()).toMatchObject({ warnMin: 8, lateMin: 15 });
    // La pantalla de cocina no puede tocar lo de barra.
    const [beer] = await sql`insert into products (establishment_id, name, price_cents, vat_rate, destination) values (${est}, 'Caña', 250, 10, 'bar') returning id`;
    await call(waiter, 'POST', '/api/service/orders', { clientRequestId: `k-${Date.now()}-${++seq}`, target: { tableId: table }, items: [{ productId: beer.id, qty: 1 }] });
    const [cana] = await sql`select id from order_items where name = 'Caña'`;
    expect((await call(cocina, 'PATCH', '/api/service/items', { itemIds: [cana.id], status: 'delivered' })).statusCode).toBe(403);
    // Un camarero no ve la pantalla de cocina.
    expect((await call(waiter, 'GET', '/api/kds/kitchen/board')).statusCode).toBe(403);
  });
});
