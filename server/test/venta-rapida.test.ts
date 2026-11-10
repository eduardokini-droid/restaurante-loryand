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
let gestor: string;
const P: Record<string, string> = {};
let seq = 0;
const rid = () => `qs-${Date.now()}-${++seq}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users cascade');
  const [e] = await sql`insert into establishments (slug, name) values ('demo', 'Cafetería Demo') returning id`;
  est = e.id;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor', ${await hashPassword('gestor-1234')}, 'superadmin')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  for (const [k, name, price, dest, course] of [['cafe', 'Café con leche', 150, 'bar', 3], ['tostada', 'Tostada', 210, 'kitchen', 2]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate, destination, course) values (${est}, ${name}, ${price}, 10, ${dest}, ${course}) returning id`;
    P[k] = p.id;
  }
  admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'secreto123' } }));
  gestor = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gestor', password: 'gestor-1234' } }));
  waiter = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/waiter', payload: { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true } }));
});

describe('venta rápida', () => {
  it('pide y cobra en un paso; la barra queda servida y la cocina recibe su parte', async () => {
    const body = { clientRequestId: rid(), items: [{ productId: P.cafe, qty: 2 }, { productId: P.tostada, qty: 1 }], method: 'cash', tenderedCents: 1000 };
    const r = (await call(admin, 'POST', '/api/service/quick-sale', body)).json();
    expect(r).toMatchObject({ accountStatus: 'paid', pendingCents: 0, changeCents: 490, totalCents: 510, duplicate: false });
    expect(r.documentId).toBeTruthy();
    const items = await sql`select destination, status from order_items i join orders o on o.id = i.order_id where o.account_id = ${r.accountId} order by destination`;
    // Aunque la tostada sea de 2.º pase, en mostrador no se retiene.
    expect(items.map((i) => [i.destination, i.status])).toEqual([['bar', 'delivered'], ['kitchen', 'new']]);
    const kds = (await call(admin, 'GET', '/api/kds/kitchen')).json();
    expect(JSON.stringify(kds)).toContain('Tostada');
    // Repetir (doble pulsación o reintento) no crea ni cobra otra vez.
    const again = (await call(admin, 'POST', '/api/service/quick-sale', body)).json();
    expect(again).toMatchObject({ duplicate: true, accountId: r.accountId });
    expect(await sql`select 1 from payments`).toHaveLength(1);
    expect(await sql`select 1 from accounts`).toHaveLength(1);
    // No aparece como cuenta abierta en la sala.
    expect((await call(admin, 'GET', '/api/service/floor')).json().bar).toHaveLength(0);
  });

  it('solo desde el TPV y si el plan lo incluye; un producto inexistente no deja cuentas a medias', async () => {
    const body = { clientRequestId: rid(), items: [{ productId: P.cafe, qty: 1 }], method: 'card' };
    expect((await call(waiter, 'POST', '/api/service/quick-sale', body)).statusCode).toBe(403);
    const bad = await call(admin, 'POST', '/api/service/quick-sale', { ...body, items: [{ productId: '00000000-0000-0000-0000-000000000000', qty: 1 }] });
    expect(bad.statusCode).toBe(400);
    expect(await sql`select 1 from accounts where status = 'open'`).toHaveLength(0);
    await sql`update establishments set features = array['menu','kitchen'] where id = ${est}`;
    admin = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'secreto123' } }));
    expect((await call(admin, 'POST', '/api/service/quick-sale', body)).statusCode).toBe(403);
  });
});

describe('logotipo, fotos y tipo de negocio', () => {
  it('sube el logotipo, lo sirve con su tipo y aparece en el panel y en la carta', async () => {
    expect((await call(admin, 'POST', '/api/admin/images', { kind: 'logo', dataUrl: 'data:image/png;base64,SGVsbG8gbXVuZG8=' })).json().message).toContain('no es una imagen válida');
    const img = (await call(admin, 'POST', '/api/admin/images', { kind: 'logo', dataUrl: PNG })).json();
    expect(img.url).toBe(`/api/img/${img.id}`);
    const got = await app.inject({ method: 'GET', url: img.url });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(got.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    await call(admin, 'PUT', '/api/admin/logo', { imageId: img.id });
    expect((await call(admin, 'GET', '/api/auth/me')).json().establishment.logo_url).toBe(img.url);
    const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning qr_token`;
    expect((await app.inject({ method: 'GET', url: `/api/public/table/${t.qr_token}` })).json().logoUrl).toBe(img.url);
    // Una imagen de otro local no se puede usar como logotipo.
    const [other] = await sql`insert into establishments (slug, name) values ('otro', 'Otro') returning id`;
    const [foreign] = await sql`insert into images (establishment_id, kind, mime, bytes, data) values (${other.id}, 'logo', 'image/png', 1, ${Buffer.from([1])}) returning id`;
    expect((await call(admin, 'PUT', '/api/admin/logo', { imageId: foreign.id })).statusCode).toBe(404);
  });

  it('foto de producto subida al servidor; tipo de negocio; resumen de 30 días para el gestor', async () => {
    const img = (await call(admin, 'POST', '/api/admin/images', { kind: 'product', dataUrl: PNG })).json();
    expect((await call(admin, 'PATCH', `/api/admin/products/${P.cafe}`, { photoUrl: img.url })).statusCode).toBe(200);
    expect((await call(admin, 'PATCH', `/api/admin/products/${P.cafe}`, { photoUrl: 'http://inseguro.com/a.jpg' })).statusCode).toBe(400);
    const menu = (await call(admin, 'GET', '/api/service/menu')).json();
    expect(menu.products.find((p: { id: string }) => p.id === P.cafe).photo_url).toBe(img.url);
    await call(admin, 'PUT', '/api/admin/establishment', { businessType: 'cafe' });
    expect((await call(admin, 'GET', '/api/auth/me')).json().establishment.business_type).toBe('cafe');
    await call(admin, 'POST', '/api/service/quick-sale', { clientRequestId: rid(), items: [{ productId: P.cafe, qty: 2 }], method: 'card' });
    const [c] = (await call(gestor, 'GET', '/api/platform/clients')).json();
    expect(c).toMatchObject({ business_type: 'cafe', orders_30d: 1, sales_30d: 300 });
  });
});
