import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { toItemUnit } from '../src/services/stock.js';
import { vatBreakdown } from '../src/services/documents.js';
import { translateTexts } from '../src/services/translate.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let waiter: string;
let tableId: string;
const P: Record<string, string> = {};
let seq = 0;
const rid = () => `f3-${Date.now()}-${++seq}`;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const today = () => new Date().toISOString().slice(0, 10);

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
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  for (const [k, name, price, vat] of [['gintonic', 'Gin tonic', 900, 10], ['vino', 'Botella de vino', 2000, 10], ['plato', 'Plato', 1000, 10], ['camiseta', 'Camiseta', 2100, 21]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate) values (${est}, ${name}, ${price}, ${vat}) returning id`;
    P[k] = p.id;
  }
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning id`;
  tableId = t.id;
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234' });
  await call(waiter, 'POST', '/api/service/shift/start');
});

async function order(items: object[]) {
  const r = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function payAll(accountId: string) {
  const acc = (await call(waiter, 'GET', `/api/service/accounts/${accountId}`)).json();
  await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.filter((i: { destination: string }) => i.destination !== 'none').map((i: { id: string }) => i.id), status: 'delivered' });
  const r = await call(waiter, 'POST', `/api/service/accounts/${accountId}/payments`, { idempotencyKey: rid(), method: 'card', amountCents: acc.pendingCents });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

describe('unidades del almacén', () => {
  it('convierte entre unidades compatibles y envases', () => {
    expect(toItemUnit(30, 'ml', { name: 'Ginebra', unit: 'l', pack_qty: null, pack_unit: null })).toBeCloseTo(0.03);
    expect(toItemUnit(50, 'ml', { name: 'Ginebra', unit: 'ud', pack_qty: 0.7, pack_unit: 'l' })).toBeCloseTo(0.0714, 3);
    expect(() => toItemUnit(2, 'ud', { name: 'Harina', unit: 'kg', pack_qty: null, pack_unit: null })).toThrow(/no se puede usar/);
    expect(() => toItemUnit(30, 'ml', { name: 'Botella', unit: 'ud', pack_qty: null, pack_unit: null })).toThrow(/contenido del envase/);
  });

  it('avisa del error típico de 30 litros en vez de 30 ml', async () => {
    const gin = (await call(admin, 'POST', '/api/stock/items', { name: 'Ginebra', unit: 'ud', packQty: 0.7, packUnit: 'l', costPerUnitCents: 1400, stock: 10 })).json();
    const bad = await call(admin, 'PUT', `/api/stock/recipes/${P.gintonic}`, { lines: [{ itemId: gin.id, qty: 30, unit: 'l' }] });
    expect(bad.json().error).toBe('confirm_large');
    expect((await call(admin, 'PUT', `/api/stock/recipes/${P.gintonic}`, { lines: [{ itemId: gin.id, qty: 50, unit: 'ml' }] })).statusCode).toBe(200);
  });
});

describe('escandallos, ventas y rentabilidad', () => {
  it('la venta descuenta según el escandallo, la anulación lo devuelve y calcula el margen', async () => {
    const gin = (await call(admin, 'POST', '/api/stock/items', { name: 'Ginebra', unit: 'ud', packQty: 0.7, packUnit: 'l', costPerUnitCents: 1400, stock: 10, minStock: 9.95 })).json();
    const tonica = (await call(admin, 'POST', '/api/stock/items', { name: 'Tónica', unit: 'ud', costPerUnitCents: 60, stock: 24 })).json();
    await call(admin, 'PUT', `/api/stock/recipes/${P.gintonic}`, { lines: [{ itemId: gin.id, qty: 50, unit: 'ml' }, { itemId: tonica.id, qty: 1, unit: 'ud' }] });
    const o = await order([{ productId: P.gintonic, qty: 2 }]);
    let items = (await call(admin, 'GET', '/api/stock/items')).json();
    const g = items.find((i: { name: string }) => i.name === 'Ginebra');
    expect(Number(g.stock)).toBeCloseTo(10 - 0.1429, 3);
    expect(g.low).toBe(true);
    expect(Number(items.find((i: { name: string }) => i.name === 'Tónica').stock)).toBe(22);
    // anular devuelve al almacén
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${o.accountId}`)).json();
    await call(waiter, 'PATCH', '/api/service/items', { itemIds: [acc.items[0].id], status: 'cancelled' });
    items = (await call(admin, 'GET', '/api/stock/items')).json();
    expect(Number(items.find((i: { name: string }) => i.name === 'Tónica').stock)).toBe(24);
    // rentabilidad: 9,00 € con IVA 10 % → 8,18 € netos; coste 50 ml de 0,7 l a 14 € = 1,00 € + tónica 0,60 €
    await order([{ productId: P.gintonic, qty: 1 }]);
    const rep = (await call(admin, 'GET', `/api/reports/profitability?from=${today()}&to=${today()}`)).json();
    const row = rep.find((r: { name: string }) => r.name === 'Gin tonic');
    expect(row).toMatchObject({ sold: 1, net_cents: 818, costCents: 160, marginCents: 658, recipe: 'complete' });
  });

  it('un producto vinculado a un artículo descuenta una unidad por venta', async () => {
    await call(admin, 'POST', '/api/stock/items', { name: 'Vino tinto (botella)', unit: 'ud', productId: P.vino, stock: 6, costPerUnitCents: 700 });
    await order([{ productId: P.vino, qty: 2 }]);
    const items = (await call(admin, 'GET', '/api/stock/items')).json();
    expect(Number(items[0].stock)).toBe(4);
  });

  it('compras con coste medio ponderado, mermas y corrección de stock', async () => {
    const h = (await call(admin, 'POST', '/api/stock/items', { name: 'Harina', unit: 'kg', stock: 10, costPerUnitCents: 100 })).json();
    await call(admin, 'POST', '/api/stock/movements', { itemId: h.id, kind: 'purchase', qty: 10, unitCostCents: 200, supplier: 'Molinos', reference: 'F-123' });
    await call(admin, 'POST', '/api/stock/movements', { itemId: h.id, kind: 'waste', qty: 1, reference: 'Saco roto' });
    await call(admin, 'POST', '/api/stock/movements', { itemId: h.id, kind: 'adjustment', qty: 18.5 });
    const [it] = (await call(admin, 'GET', '/api/stock/items')).json();
    expect(Number(it.stock)).toBe(18.5);
    expect(Number(it.cost_per_unit)).toBe(150);
    const moves = (await call(admin, 'GET', `/api/stock/movements?itemId=${h.id}`)).json();
    expect(moves.map((m: { kind: string }) => m.kind)).toEqual(['adjustment', 'waste', 'purchase', 'adjustment']);
  });
});

describe('fidelización y cupones', () => {
  it('cupón de cliente: descuento, IVA proporcional, puntos y un solo uso', async () => {
    const c = (await call(waiter, 'POST', '/api/loyalty/customers', { privacyAccepted: true, name: 'Lucía Pérez', phone: '600 111 222' })).json();
    expect((await call(waiter, 'POST', '/api/loyalty/customers', { privacyAccepted: true, name: 'Otra', phone: '600111222' })).statusCode).toBe(409);
    const k = (await call(admin, 'POST', '/api/loyalty/coupons', { customerId: c.id, kind: 'percent', value: 10, maxUses: 1 })).json();
    const o = await order([{ productId: P.plato, qty: 2 }, { productId: P.camiseta, qty: 1 }]);
    const acc = (await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/coupon`, { code: k.code.toLowerCase() })).json();
    expect(acc.itemsTotalCents).toBe(4100);
    expect(acc.discountCents).toBe(410);
    expect(acc.totalCents).toBe(3690);
    expect(acc.customer.name).toBe('Lucía Pérez');
    const pay = await payAll(o.accountId);
    const [doc] = await sql`select payload, total_cents from documents where id = ${pay.documentId}`;
    expect(doc.total_cents).toBe(3690);
    const vatTotal = doc.payload.vat.reduce((s: number, v: { totalCents: number }) => s + v.totalCents, 0);
    expect(vatTotal).toBe(3690);
    const [cust] = await sql`select points from customers where id = ${c.id}`;
    expect(cust.points).toBe(36);
    const o2 = await order([{ productId: P.plato, qty: 1 }]);
    expect((await call(waiter, 'POST', `/api/service/accounts/${o2.accountId}/coupon`, { code: k.code })).json().error).toBe('coupon_used');
    const list = (await call(admin, 'GET', '/api/loyalty/customers')).json();
    expect(list[0]).toMatchObject({ visits: 1, spent_cents: 3690, inactive: false });
  });

  it('respeta el mínimo, la caducidad y no deja la cuenta a cero', async () => {
    const min = (await call(admin, 'POST', '/api/loyalty/coupons', { kind: 'amount', value: 500, minTotalCents: 5000, code: 'MIN50' })).json();
    const old = (await call(admin, 'POST', '/api/loyalty/coupons', { kind: 'amount', value: 500, code: 'VIEJO' })).json();
    await sql`update coupons set valid_until = current_date - 1 where id = ${old.id}`;
    const full = (await call(admin, 'POST', '/api/loyalty/coupons', { kind: 'percent', value: 100, code: 'GRATIS' })).json();
    const o = await order([{ productId: P.plato, qty: 1 }]);
    expect((await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/coupon`, { code: min.code })).json().error).toBe('coupon_min');
    expect((await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/coupon`, { code: old.code })).json().error).toBe('coupon_expired');
    expect((await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/coupon`, { code: full.code })).json().error).toBe('coupon_full');
  });

  it('quitar un cupón devuelve su uso y la tarjeta digital muestra puntos y cupones', async () => {
    const c = (await call(waiter, 'POST', '/api/loyalty/customers', { privacyAccepted: true, name: 'Mario Gil', phone: '611' })).json();
    const k = (await call(admin, 'POST', '/api/loyalty/coupons', { customerId: c.id, kind: 'amount', value: 200, description: 'Café gratis' })).json();
    const o = await order([{ productId: P.plato, qty: 1 }]);
    const acc = (await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/coupon`, { code: k.code })).json();
    await call(waiter, 'DELETE', `/api/service/accounts/${o.accountId}/discounts/${acc.discounts[0].id}`);
    const [kk] = await sql`select uses from coupons where id = ${k.id}`;
    expect(kk.uses).toBe(0);
    const card = (await app.inject({ method: 'GET', url: `/api/public/card/${c.card_token}` })).json();
    expect(card).toMatchObject({ name: 'Mario', points: 0 });
    expect(card.coupons[0].description).toBe('Café gratis');
  });

  it('desglose de IVA con descuento proporcional', () => {
    const v = vatBreakdown([{ unitCents: 1000, qty: 2, vatRate: 10 }, { unitCents: 2100, qty: 1, vatRate: 21 }], 410);
    expect(v.reduce((s, x) => s + x.totalCents, 0)).toBe(3690);
    expect(v.find((x) => x.rate === 10)!.totalCents).toBe(1800);
  });
});

describe('copias de seguridad', () => {
  it('incluye lista de espera y estados, verifica y restaura con copia preventiva', async () => {
    await call(waiter, 'POST', '/api/waitlist', { name: 'Grupo en espera', partySize: 2 });
    await call(admin, 'PUT', '/api/admin/establishment', { name: 'Nombre original' });
    const o = await order([{ productId: P.plato, qty: 1 }]);
    await payAll(o.accountId);
    const b = (await call(admin, 'POST', '/api/backups')).json();
    expect(b.summary.counts.waitlist).toBe(1);
    expect(b.summary.counts.table_occupancy).toBe(1);
    // cambios posteriores que la restauración debe deshacer
    await call(admin, 'PUT', '/api/admin/establishment', { name: 'Nombre cambiado' });
    await sql`delete from waitlist`;
    await call(admin, 'PATCH', `/api/admin/products/${P.plato}`, { priceCents: 1500 });
    const v = (await call(admin, 'POST', '/api/backups/verify', { backupId: b.id })).json();
    expect(v.problems).toEqual([]);
    const r = await call(admin, 'POST', '/api/backups/restore', { backupId: b.id });
    expect(r.statusCode, r.body).toBe(200);
    const [e] = await sql`select name from establishments where id = ${est}`;
    expect(e.name).toBe('Nombre original');
    const [{ n }] = await sql`select count(*)::int as n from waitlist`;
    expect(n).toBe(1);
    const [p] = await sql`select price_cents from products where id = ${P.plato}`;
    expect(p.price_cents).toBe(1000);
    const kinds = (await call(admin, 'GET', '/api/backups')).json().backups.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain('preventive');
    // el administrador sigue con su sesión: los usuarios del panel no se tocan
    expect((await call(admin, 'GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('bloquea restaurar si se perderían facturas o hay servicio activo, y rechaza otro negocio', async () => {
    const b = (await call(admin, 'POST', '/api/backups')).json();
    const o = await order([{ productId: P.plato, qty: 1 }]);
    let v = (await call(admin, 'POST', '/api/backups/verify', { backupId: b.id })).json();
    expect(v.problems.join(' ')).toMatch(/cuenta\(s\) abiertas/);
    await payAll(o.accountId);
    v = (await call(admin, 'POST', '/api/backups/verify', { backupId: b.id })).json();
    expect(v.problems.join(' ')).toMatch(/factura\(s\) emitidas después/);
    expect((await call(admin, 'POST', '/api/backups/restore', { backupId: b.id })).json().error).toBe('restore_blocked');
    const [{ data }] = await sql`select data from backups where id = ${b.id}`;
    const foreign = { ...data, establishmentId: '00000000-0000-0000-0000-000000000000' };
    v = (await call(admin, 'POST', '/api/backups/verify', { data: foreign })).json();
    expect(v.problems.join(' ')).toMatch(/otro establecimiento/);
    expect((await call(admin, 'POST', '/api/backups/verify', { data: { hola: 1 } })).json().error).toBe('bad_backup');
  });

  it('un camarero no puede gestionar copias', async () => {
    expect((await call(waiter, 'GET', '/api/backups')).statusCode).toBe(403);
  });
});

describe('idiomas y plano', () => {
  afterEach(() => { delete process.env.DEEPL_API_KEY; });

  it('traducciones manuales visibles en la carta del cliente', async () => {
    await call(admin, 'PATCH', `/api/admin/products/${P.plato}`, { translations: { en: { name: 'Dish', description: '' } } });
    const [t] = await sql`select qr_token from tables where id = ${tableId}`;
    const carta = (await app.inject({ method: 'GET', url: `/api/public/table/${t.qr_token}` })).json();
    expect(carta.products.find((p: { name: string }) => p.name === 'Plato').translations.en.name).toBe('Dish');
  });

  it('sin clave de DeepL avisa; con clave traduce a los seis idiomas', async () => {
    expect((await call(admin, 'POST', `/api/admin/products/${P.plato}/translate`)).json().error).toBe('translation_unavailable');
    process.env.DEEPL_API_KEY = 'test:fx';
    const calls: string[] = [];
    const fake = (async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      calls.push(b.target_lang);
      return { ok: true, json: async () => ({ translations: b.text.map((x: string) => ({ text: `${b.target_lang}:${x}` })) }) };
    }) as unknown as typeof fetch;
    const out = await translateTexts(['Croquetas', 'Caseras'], fake);
    expect(calls).toEqual(['EN-GB', 'FR', 'DE', 'IT', 'PT-PT', 'RU']);
    expect(out.fr).toEqual(['FR:Croquetas', 'FR:Caseras']);
  });

  it('guarda la posición de las mesas en el plano', async () => {
    await call(admin, 'PATCH', `/api/admin/tables/${tableId}`, { posX: 40, posY: 25, shape: 'round' });
    const floor = (await call(waiter, 'GET', '/api/service/floor')).json();
    expect(floor.tables[0]).toMatchObject({ pos_x: 40, pos_y: 25, shape: 'round' });
  });
});

describe('editar un campo no altera los demás', () => {
  it('producto: cambiar el precio conserva opciones, alérgenos, destino, pase, visibilidad y categoría', async () => {
    const [c] = await sql`insert into categories (establishment_id, name) values (${est}, 'Bebidas') returning id`;
    const p = (await call(admin, 'POST', '/api/admin/products', {
      name: 'Refresco', priceCents: 250, vatRate: 21, destination: 'bar', course: 3, visible: false,
      options: 'Cola\nNaranja', allergens: ['sulfitos'], categoryId: c.id, description: 'Lata 33 cl',
    })).json();
    const u = (await call(admin, 'PATCH', `/api/admin/products/${p.id}`, { priceCents: 300 })).json();
    expect(u).toMatchObject({ price_cents: 300, destination: 'bar', course: 3, visible: false, options: ['Cola', 'Naranja'], allergens: ['sulfitos'], category_id: c.id, description: 'Lata 33 cl' });
    expect(Number(u.vat_rate)).toBe(21);
  });

  it('mesa: mover en el plano conserva plazas, zona y estado activo', async () => {
    await call(admin, 'PATCH', `/api/admin/tables/${tableId}`, { seats: 2, zone: 'terraza', active: false });
    await call(admin, 'PATCH', `/api/admin/tables/${tableId}`, { posX: 10, posY: 20 });
    const [t] = await sql`select seats, zone, active, pos_x from tables where id = ${tableId}`;
    expect(t).toMatchObject({ seats: 2, zone: 'terraza', active: false, pos_x: 10 });
  });

  it('cliente: cambiar los puntos conserva teléfono, correo y consentimiento', async () => {
    const c = (await call(waiter, 'POST', '/api/loyalty/customers', { privacyAccepted: true, name: 'Ana', phone: '600', email: 'a@b.es', marketingConsent: true })).json();
    await call(admin, 'PATCH', `/api/loyalty/customers/${c.id}`, { points: 50 });
    const [x] = await sql`select phone, email, marketing_consent, points from customers where id = ${c.id}`;
    expect(x).toMatchObject({ phone: '600', email: 'a@b.es', marketing_consent: true, points: 50 });
  });
});
