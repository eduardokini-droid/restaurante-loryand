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
const T: Record<string, string> = {};
const P: Record<string, string> = {};
let seq = 0;
const rid = () => `dv-${Date.now()}-${++seq}`;
const call = (cookie: string, method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, payload, headers: { cookie } });
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
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Admin', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')})`;
  for (const [k, name, price, vat] of [['entrecot', 'Entrecot', 2200, 10], ['cana', 'Caña', 250, 10], ['vino', 'Vino', 1800, 21]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, vat_rate) values (${est}, ${name}, ${price}, ${vat}) returning id`;
    P[k] = p.id;
  }
  for (const l of ['1', '2', '3']) { const [t] = await sql`insert into tables (establishment_id, label) values (${est}, ${l}) returning id`; T[l] = t.id; }
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234', clockIn: true });
});

async function order(target: object, items: object[]) {
  const r = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target, items });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function deliverAll(accountId: string) {
  const acc = (await call(waiter, 'GET', `/api/service/accounts/${accountId}`)).json();
  await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
  return (await call(waiter, 'GET', `/api/service/accounts/${accountId}`)).json();
}
const pay = (accountId: string, body: object) => call(waiter, 'POST', `/api/service/accounts/${accountId}/payments`, { idempotencyKey: rid(), ...body });

describe('dividir la cuenta por productos', () => {
  it('cada persona paga lo suyo con su propio ticket; el último ticket lleva solo lo que queda', async () => {
    const o = await order({ tableId: T['1'] }, [{ productId: P.entrecot, qty: 2 }, { productId: P.cana, qty: 3 }, { productId: P.vino, qty: 1 }]);
    const acc = await deliverAll(o.accountId);
    const id = (name: string) => acc.items.find((i: { name: string }) => i.name === name).id;
    // Persona A: un entrecot y una caña = 24,50
    const a = await pay(o.accountId, { method: 'card', amountCents: 2450, items: [{ itemId: id('Entrecot'), qty: 1 }, { itemId: id('Caña'), qty: 1 }] });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ accountStatus: 'open', pendingCents: 6950 - 2450 });
    // no se puede pagar dos veces lo mismo
    expect((await pay(o.accountId, { method: 'cash', amountCents: 7200, items: [{ itemId: id('Caña'), qty: 3 }] })).json().error).toBe('already_paid');
    // importe distinto al de los productos: rechazado
    expect((await pay(o.accountId, { method: 'cash', amountCents: 100, items: [{ itemId: id('Caña'), qty: 1 }] })).json().error).toBe('amount_mismatch');
    // Persona B: el resto, en efectivo, sin elegir productos
    const b = (await pay(o.accountId, { method: 'cash', amountCents: 4500 })).json();
    expect(b.accountStatus).toBe('paid');
    const docs = await sql`select total_cents, payload, payment_id from documents where account_id = ${o.accountId} order by number`;
    expect(docs).toHaveLength(2);
    expect(docs[0].payload.lines.map((l: { name: string; qty: number }) => `${l.qty} ${l.name}`)).toEqual(['1 Entrecot', '1 Caña']);
    expect(docs[0].total_cents).toBe(2450);
    expect(docs[0].payload.payments).toHaveLength(1);
    expect(docs[1].payload.lines.map((l: { name: string; qty: number }) => `${l.qty} ${l.name}`).sort()).toEqual(['1 Entrecot', '1 Vino', '2 Caña']);
    expect(docs[1].total_cents).toBe(4500);
    expect(docs[0].total_cents + docs[1].total_cents).toBe(6950);
    // IVA de cada ticket cuadra con su total
    for (const d of docs) expect(d.payload.vat.reduce((s: number, v: { totalCents: number }) => s + v.totalCents, 0)).toBe(d.total_cents);
  });

  it('si todo se paga por productos no queda ticket final vacío; con descuento se reparte en proporción', async () => {
    const o = await order({ tableId: T['1'] }, [{ productId: P.entrecot, qty: 1 }, { productId: P.cana, qty: 2 }]);
    await sql`insert into account_discounts (account_id, label, amount_cents) values (${o.accountId}, 'Descuento 10 %', 270)`;
    const acc = await deliverAll(o.accountId);
    expect(acc.totalCents).toBe(2430);
    const id = (name: string) => acc.items.find((i: { name: string }) => i.name === name).id;
    const first = (await pay(o.accountId, { method: 'card', amountCents: 1980, items: [{ itemId: id('Entrecot'), qty: 1 }] })).json();
    expect(first.pendingCents).toBe(450);
    const last = (await pay(o.accountId, { method: 'bizum', amountCents: 450, items: [{ itemId: id('Caña'), qty: 2 }] })).json();
    expect(last.accountStatus).toBe('paid');
    const docs = await sql`select total_cents from documents where account_id = ${o.accountId} order by number`;
    expect(docs.map((d) => d.total_cents)).toEqual([1980, 450]);
  });

  it('la factura completa de un ticket parcial reproduce solo sus productos', async () => {
    const o = await order({ tableId: T['1'] }, [{ productId: P.entrecot, qty: 1 }, { productId: P.vino, qty: 1 }]);
    const acc = await deliverAll(o.accountId);
    const vino = acc.items.find((i: { name: string }) => i.name === 'Vino').id;
    const r = (await pay(o.accountId, { method: 'card', amountCents: 1800, items: [{ itemId: vino, qty: 1 }] })).json();
    const full = (await call(waiter, 'POST', `/api/service/documents/${r.documentId}/full`, { name: 'Empresa S.L.', taxId: 'B12345678', address: 'Calle 1' })).json();
    const [d] = await sql`select total_cents, payload from documents where id = ${full.id}`;
    expect(d.total_cents).toBe(1800);
    expect(d.payload.lines).toHaveLength(1);
    expect(d.payload.customer.name).toBe('Empresa S.L.');
  });
});

describe('cambiar de mesa', () => {
  it('la cuenta pasa entera a la mesa nueva; la vieja queda pendiente de limpiar', async () => {
    const o = await order({ tableId: T['1'] }, [{ productId: P.cana, qty: 2 }]);
    const r = await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/move`, { tableId: T['3'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().account.tableLabel).toBe('3');
    const states = Object.fromEntries((await sql`select label, physical_state from tables`).map((t) => [t.label, t.physical_state]));
    expect(states).toMatchObject({ '1': 'dirty', '3': 'occupied' });
    // nuevas comandas en la mesa 3 van a la misma cuenta
    const o2 = await order({ tableId: T['3'] }, [{ productId: P.cana, qty: 1 }]);
    expect(o2.accountId).toBe(o.accountId);
  });

  it('no mezcla con una mesa ocupada (remite a «Unir cuentas») y sienta a un cliente de barra', async () => {
    const a = await order({ tableId: T['1'] }, [{ productId: P.cana, qty: 1 }]);
    await order({ tableId: T['2'] }, [{ productId: P.cana, qty: 1 }]);
    expect((await call(waiter, 'POST', `/api/service/accounts/${a.accountId}/move`, { tableId: T['2'] })).json().error).toBe('table_busy');
    const bar = await order({ barName: 'Luis' }, [{ productId: P.cana, qty: 1 }]);
    const r = (await call(waiter, 'POST', `/api/service/accounts/${bar.accountId}/move`, { tableId: T['3'] })).json();
    expect(r.account).toMatchObject({ tableLabel: '3', barName: null });
  });
});

describe('nombres de descuentos en el ticket', () => {
  it('sin dividir, el ticket conserva el nombre del cupón; dividido, indica la parte proporcional', async () => {
    const o = await order({ tableId: T['2'] }, [{ productId: P.entrecot, qty: 1 }]);
    await sql`insert into account_discounts (account_id, label, amount_cents) values (${o.accountId}, 'Cupón BIENVENIDA (-10 %)', 220)`;
    await deliverAll(o.accountId);
    await pay(o.accountId, { method: 'cash', amountCents: 1980 });
    const [d] = await sql`select payload from documents where account_id = ${o.accountId}`;
    expect(d.payload.discounts).toEqual([{ label: 'Cupón BIENVENIDA (-10 %)', amountCents: 220 }]);
  });
});
