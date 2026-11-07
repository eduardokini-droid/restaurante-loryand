import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';

let app: FastifyInstance;
let est: string;
let adminCookie: string;
let waiterCookie: string;
let waiterId: string;
const P: Record<string, string> = {};
const T: Record<string, { id: string; qr_token: string; access_code: string }> = {};
let seq = 0;
const rid = () => `req-${Date.now()}-${++seq}`;

async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

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
  const [w] = await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup)
                        values (${est}, 1, 'Ana', ${await hashPassword('1234')}, ${pinLookup(est, '1234')}) returning id`;
  waiterId = w.id;
  const add = async (key: string, name: string, cents: number, extra: Record<string, unknown> = {}) => {
    const [p] = await sql`insert into products ${sql({ establishment_id: est, name, price_cents: cents, ...extra })} returning id`;
    P[key] = p.id;
  };
  await add('ensalada', 'Ensalada', 900, { course: 1 });
  await add('entrecot', 'Entrecot', 2200, { course: 2 });
  await add('refresco', 'Refresco', 250, { destination: 'bar', options: ['Coca-Cola', 'Coca-Cola Zero', 'Naranja'] });
  await add('oculto', 'Fuera de carta', 1500, { visible: false });
  for (const label of ['1', '2']) {
    const [t] = await sql`insert into tables (establishment_id, label) values (${est}, ${label}) returning id, qr_token, access_code`;
    T[label] = t as never;
  }
  adminCookie = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiterCookie = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234' });
  await call(waiterCookie, 'POST', '/api/service/shift/start');
});

async function order(items: object[], target: object = { tableId: T['1'].id }, requestId = rid(), cookie = waiterCookie) {
  return call(cookie, 'POST', '/api/service/orders', { clientRequestId: requestId, target, items });
}
async function deliverAll(accountId: string) {
  const acc = (await call(waiterCookie, 'GET', `/api/service/accounts/${accountId}`)).json();
  const pick = (st: string[]) => acc.items.filter((i: { status: string }) => st.includes(i.status)).map((i: { id: string }) => i.id);
  const held = pick(['held']);
  if (held.length) expect((await call(waiterCookie, 'PATCH', '/api/service/items', { itemIds: held, status: 'new' })).statusCode).toBe(200);
  const open = pick(['held', 'new', 'preparing']);
  if (open.length) expect((await call(adminCookie, 'PATCH', '/api/service/items', { itemIds: open, status: 'ready' })).statusCode).toBe(200);
  const toDeliver = pick(['held', 'new', 'preparing', 'ready', 'received']);
  if (toDeliver.length) expect((await call(waiterCookie, 'PATCH', '/api/service/items', { itemIds: toDeliver, status: 'delivered' })).statusCode).toBe(200);
}

describe('comandas', () => {
  it('un envío repetido con el mismo identificador no duplica el pedido', async () => {
    const id = rid();
    const a = await order([{ productId: P.ensalada, qty: 1 }], undefined, id);
    const b = await order([{ productId: P.ensalada, qty: 1 }], undefined, id);
    expect(a.json().duplicate).toBe(false);
    expect(b.json().duplicate).toBe(true);
    expect(b.json().orderId).toBe(a.json().orderId);
    const [{ n }] = await sql`select count(*)::int as n from order_items`;
    expect(n).toBe(1);
  });

  it('exige elegir una opción válida', async () => {
    expect((await order([{ productId: P.refresco, qty: 1 }])).statusCode).toBe(400);
    expect((await order([{ productId: P.refresco, qty: 1, option: 'Cerveza' }])).statusCode).toBe(400);
    expect((await order([{ productId: P.refresco, qty: 1, option: 'Naranja' }])).statusCode).toBe(200);
  });

  it('retiene el segundo pase hasta "Marchar ahora"', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 2 }, { productId: P.entrecot, qty: 2 }])).json();
    let acc = (await call(waiterCookie, 'GET', `/api/service/accounts/${r.accountId}`)).json();
    expect(acc.items.find((i: { name: string }) => i.name === 'Entrecot').status).toBe('held');
    const kds = (await call(adminCookie, 'GET', '/api/kds/kitchen')).json();
    expect(kds[0].items.map((i: { name: string }) => i.name)).toEqual(['Ensalada']);
    expect((await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/fire`)).json().course).toBe(2);
    acc = (await call(waiterCookie, 'GET', `/api/service/accounts/${r.accountId}`)).json();
    expect(acc.items.every((i: { status: string }) => i.status === 'new')).toBe(true);
  });

  it('el camarero debe fichar antes de pedir', async () => {
    await call(waiterCookie, 'POST', '/api/service/shift/end');
    const r = await order([{ productId: P.ensalada, qty: 1 }]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('not_on_shift');
  });

  it('en modo exclusivo el camarero solo pide en sus mesas', async () => {
    await call(adminCookie, 'PUT', '/api/admin/establishment', { settings: { sharedTables: false } });
    expect((await order([{ productId: P.ensalada, qty: 1 }])).statusCode).toBe(403);
    await call(adminCookie, 'PATCH', `/api/admin/waiters/${waiterId}`, { tableIds: [T['1'].id] });
    expect((await order([{ productId: P.ensalada, qty: 1 }])).statusCode).toBe(200);
  });

  it('cuenta de barra: requiere camarero y reutiliza la cuenta abierta del mismo nombre', async () => {
    const r1 = (await order([{ productId: P.refresco, qty: 1, option: 'Naranja' }], { barName: 'Luis' })).json();
    const r2 = (await order([{ productId: P.refresco, qty: 1, option: 'Naranja' }], { barName: 'luis ' })).json();
    expect(r2.accountId).toBe(r1.accountId);
    const tpv = await order([{ productId: P.refresco, qty: 1, option: 'Naranja' }], { barName: 'Marta' }, rid(), adminCookie);
    expect(tpv.statusCode).toBe(400);
  });
});

describe('cobros', () => {
  it('bloquea el cobro con productos sin entregar', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 1 }])).json();
    const p = await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 900 });
    expect(p.statusCode).toBe(409);
    expect(p.json().error).toBe('items_pending');
  });

  it('no cobra dos veces la misma operación y calcula el cambio', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 1 }])).json();
    await deliverAll(r.accountId);
    const key = rid();
    const body = { idempotencyKey: key, method: 'cash', amountCents: 900, tenderedCents: 2000 };
    const a = (await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, body)).json();
    const b = (await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, body)).json();
    expect(a.changeCents).toBe(1100);
    expect(a.accountStatus).toBe('paid');
    expect(b.duplicate).toBe(true);
    const [{ n }] = await sql`select count(*)::int as n from payments`;
    expect(n).toBe(1);
  });

  it('dos cobros simultáneos desde dispositivos distintos: solo uno prospera', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 1 }])).json();
    await deliverAll(r.accountId);
    const results = await Promise.all([1, 2, 3].map(() =>
      call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, { idempotencyKey: rid(), method: 'card', amountCents: 900 })));
    expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
    const [{ total }] = await sql`select coalesce(sum(amount_cents), 0)::int as total from payments`;
    expect(total).toBe(900);
  });

  it('pago parcial y no permite superar lo pendiente', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 2 }])).json();
    await deliverAll(r.accountId);
    const url = `/api/service/accounts/${r.accountId}/payments`;
    expect((await call(waiterCookie, 'POST', url, { idempotencyKey: rid(), method: 'card', amountCents: 1000 })).json().pendingCents).toBe(800);
    expect((await call(waiterCookie, 'POST', url, { idempotencyKey: rid(), method: 'cash', amountCents: 900 })).statusCode).toBe(409);
    expect((await call(waiterCookie, 'POST', url, { idempotencyKey: rid(), method: 'bizum', amountCents: 800 })).json().accountStatus).toBe('paid');
  });

  it('al cobrar emite ticket correlativo y la mesa queda "pagada · aún ocupada"', async () => {
    for (const label of ['1', '2']) {
      const r = (await order([{ productId: P.ensalada, qty: 1 }], { tableId: T[label].id })).json();
      await deliverAll(r.accountId);
      await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, { idempotencyKey: rid(), method: 'card', amountCents: 900 });
    }
    const docs = await sql`select series, number, payload from documents order by number`;
    expect(docs.map((d) => d.number)).toEqual([1, 2]);
    expect(docs[0].series).toBe(`T${new Date().getFullYear()}`);
    expect(docs[0].payload.vat[0]).toMatchObject({ rate: 10, totalCents: 900, baseCents: 818, vatCents: 82 });
    const [t] = await sql`select physical_state from tables where id = ${T['1'].id}`;
    expect(t.physical_state).toBe('paid_occupied');
  });
});

describe('estado físico de la mesa', () => {
  it('no se puede liberar con cuenta pendiente; flujo levantados → limpia', async () => {
    const r = (await order([{ productId: P.ensalada, qty: 1 }])).json();
    const url = `/api/service/tables/${T['1'].id}/state`;
    expect((await call(waiterCookie, 'POST', url, { state: 'free' })).statusCode).toBe(409);
    await deliverAll(r.accountId);
    await call(waiterCookie, 'POST', `/api/service/accounts/${r.accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 900 });
    expect((await call(waiterCookie, 'POST', url, { state: 'dirty' })).statusCode).toBe(200);
    const before = T['1'].access_code;
    expect((await call(waiterCookie, 'POST', url, { state: 'free' })).statusCode).toBe(200);
    const [t] = await sql`select physical_state, access_code from tables where id = ${T['1'].id}`;
    expect(t.physical_state).toBe('free');
    expect(typeof t.access_code).toBe('string');
    void before;
  });
});

describe('carta del cliente', () => {
  it('pide con la clave de la mesa y no ve productos ocultos', async () => {
    const t = T['1'];
    const carta = (await app.inject({ method: 'GET', url: `/api/public/table/${t.qr_token}` })).json();
    expect(carta.products.map((p: { name: string }) => p.name)).not.toContain('Fuera de carta');
    const bad = await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/orders`, payload: { accessCode: '0000x', clientRequestId: rid(), items: [{ productId: P.ensalada, qty: 1 }] } });
    expect(bad.statusCode).toBe(403);
    const hidden = await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/orders`, payload: { accessCode: t.access_code, clientRequestId: rid(), items: [{ productId: P.oculto, qty: 1 }] } });
    expect(hidden.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/orders`, payload: { accessCode: t.access_code, clientRequestId: rid(), items: [{ productId: P.ensalada, qty: 1 }] } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('acceso cerrado por el camarero impide pedir', async () => {
    const t = T['1'];
    await call(waiterCookie, 'POST', `/api/service/tables/${t.id}/access`, { action: 'close' });
    const r = await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/orders`, payload: { accessCode: t.access_code, clientRequestId: rid(), items: [{ productId: P.ensalada, qty: 1 }] } });
    expect(r.json().error).toBe('access_closed');
  });

  it('bloquea tras muchos intentos de clave fallidos', async () => {
    const t = T['1'];
    let last = 0;
    for (let i = 0; i < 22; i++) {
      last = (await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/verify`, payload: { accessCode: 'nope' } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('avisos: no se duplican mientras siguen abiertos', async () => {
    const t = T['1'];
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: `/api/public/table/${t.qr_token}/requests`, payload: { accessCode: t.access_code, kind: 'pay' } });
    }
    const reqs = (await call(waiterCookie, 'GET', '/api/service/requests')).json();
    expect(reqs).toHaveLength(1);
  });
});

describe('gestión', () => {
  it('no permite dos camareros con el mismo PIN', async () => {
    const r = await call(adminCookie, 'POST', '/api/admin/waiters', { name: 'Pepe', pin: '1234' });
    expect(r.statusCode).toBe(409);
    const ok = await call(adminCookie, 'POST', '/api/admin/waiters', { name: 'Pepe', pin: '5678' });
    expect(ok.json().username).toBe('camarero-2');
  });

  it('las opciones se separan por líneas, comas o punto y coma', async () => {
    const r = await call(adminCookie, 'POST', '/api/admin/products', { name: 'Tónica', priceCents: 300, options: 'Schweppes\nFever-Tree; 1724,  ' });
    expect(r.json().options).toEqual(['Schweppes', 'Fever-Tree', '1724']);
  });

  it('un camarero no accede a la gestión', async () => {
    expect((await call(waiterCookie, 'GET', '/api/admin/products')).statusCode).toBe(403);
  });

  it('unir cuentas traslada consumos y anula el origen', async () => {
    const a = (await order([{ productId: P.ensalada, qty: 1 }], { tableId: T['1'].id })).json();
    const b = (await order([{ productId: P.ensalada, qty: 1 }], { tableId: T['2'].id })).json();
    const m = (await call(waiterCookie, 'POST', '/api/service/accounts/merge', { sourceId: a.accountId, targetId: b.accountId })).json();
    expect(m.totalCents).toBe(1800);
    const [src] = await sql`select status from accounts where id = ${a.accountId}`;
    expect(src.status).toBe('cancelled');
  });

  it('el cierre de caja separa cobrado y pendiente', async () => {
    const a = (await order([{ productId: P.ensalada, qty: 1 }], { tableId: T['1'].id })).json();
    await deliverAll(a.accountId);
    await call(waiterCookie, 'POST', `/api/service/accounts/${a.accountId}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 900 });
    await order([{ productId: P.entrecot, qty: 1 }], { tableId: T['2'].id });
    const today = new Date().toISOString().slice(0, 10);
    const rep = (await call(adminCookie, 'GET', `/api/reports/cash?from=${today}&to=${today}`)).json();
    expect(rep.totalCents).toBe(900);
    expect(rep.pendingCents).toBe(2200);
    expect(rep.byWaiter[0].name).toBe('Ana');
  });
});
