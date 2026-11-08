import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { propose, type Unit, type WaitGroup } from '../src/services/waitlist.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let waiter: string;
const T: Record<string, string> = {};
let seq = 0;
const rid = () => `f2-${Date.now()}-${++seq}`;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

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
  for (const [label, seats, zone, group] of [['1', 2, 'salon', null], ['2', 4, 'salon', null], ['3', 6, 'salon', null], ['T1', 4, 'terraza', null], ['5', 4, 'salon', 'A'], ['6', 4, 'salon', 'A']] as const) {
    const [t] = await sql`insert into tables (establishment_id, label, seats, zone, join_group) values (${est}, ${label}, ${seats}, ${zone}, ${group}) returning id`;
    T[label] = t.id;
  }
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234' });
  await call(waiter, 'POST', '/api/service/shift/start');
});

describe('menú del día', () => {
  const menu = { name: 'Menú del día', priceCents: 1450, active: true, sections: { first: 'Lentejas\nEnsalada', second: 'Merluza\nPollo asado', dessert: 'Flan', drink: 'Agua\nVino', coffee: '' } };

  it('valida precio y apartados obligatorios', async () => {
    expect((await call(admin, 'PUT', '/api/admin/menu', { ...menu, priceCents: 0 })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/menu', { ...menu, sections: { ...menu.sections, second: '' } })).statusCode).toBe(400);
    const long = Array.from({ length: 21 }, (_, i) => `Plato ${i}`).join('\n');
    expect((await call(admin, 'PUT', '/api/admin/menu', { ...menu, sections: { ...menu.sections, first: long } })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/menu', menu)).statusCode).toBe(200);
  });

  it('cobra el precio una vez y reparte los platos entre cocina y barra por pases', async () => {
    await call(admin, 'PUT', '/api/admin/menu', menu);
    const bad = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId: T['2'] }, items: [{ menu: { first: 'Lentejas', second: 'Merluza' } }] });
    expect(bad.statusCode).toBe(400); // falta postre y bebida
    const r = await call(waiter, 'POST', '/api/service/orders', {
      clientRequestId: rid(), target: { tableId: T['2'] },
      items: [{ menu: { first: 'Lentejas', second: 'Merluza', dessert: 'Flan', drink: 'Vino' } }, { menu: { first: 'Ensalada', second: 'Pollo asado', dessert: 'Flan', drink: 'Agua' } }],
    });
    expect(r.statusCode, r.body).toBe(200);
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${r.json().accountId}`)).json();
    expect(acc.totalCents).toBe(2900);
    const kitchen = (await call(admin, 'GET', '/api/kds/kitchen')).json();
    expect(kitchen[0].items.map((i: { name: string }) => i.name).sort()).toEqual(['Ensalada', 'Lentejas']);
    const bar = (await call(admin, 'GET', '/api/kds/bar')).json();
    expect(bar[0].items.map((i: { name: string }) => i.name).sort()).toEqual(['Agua', 'Vino']);
    expect(acc.heldCourses).toEqual([2, 3]);
    // La cabecera del menú no bloquea el cobro: solo cuentan los platos.
    expect(acc.undeliveredCount).toBe(8);
  });

  it('no permite pedir el menú si está desactivado', async () => {
    await call(admin, 'PUT', '/api/admin/menu', { ...menu, active: false });
    const r = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId: T['2'] }, items: [{ menu: { first: 'Lentejas', second: 'Merluza', dessert: 'Flan', drink: 'Vino' } }] });
    expect(r.statusCode).toBe(400);
  });
});

describe('lista de espera', () => {
  it('ejemplo del manual: A(6), B(2), C(4) y queda libre una mesa de 4 → se propone a B', () => {
    const unit = (key: string, seats: number, state: Unit['state'] = 'free'): Unit => ({ key, tableIds: [key], labels: [key], seats, zone: 'salon', state, occupiedSince: null });
    const g = (id: string, party: number, minutesAgo: number): WaitGroup => ({ id, name: id, party_size: party, phone: '', zone_pref: null, status: 'waiting', table_ids: [], created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), notified_at: null });
    const p = propose([unit('m4', 4), unit('m6', 6, 'occupied')], [g('A', 6, 30), g('B', 2, 20), g('C', 4, 10)], 60);
    expect(p.find((x) => x.groupId === 'B')?.unit?.key).toBe('m4');
    expect(p.find((x) => x.groupId === 'A')?.unit).toBeNull();
    expect(p.find((x) => x.groupId === 'A')?.estimateMin).toBeGreaterThan(0); // A espera a la mesa de 6
    expect(p.find((x) => x.groupId === 'C')?.estimateMin).toBeNull(); // no hay otra mesa que le quepa
  });

  it('elige la capacidad más ajustada, respeta la zona y usa las uniones como una sola mesa', async () => {
    await call(waiter, 'POST', '/api/waitlist', { name: 'Pareja', partySize: 2 });
    await call(waiter, 'POST', '/api/waitlist', { name: 'Terraza', partySize: 3, zonePref: 'terraza' });
    await call(waiter, 'POST', '/api/waitlist', { name: 'Grande', partySize: 8 });
    const w = (await call(waiter, 'GET', '/api/waitlist')).json();
    const by = (n: string) => w.groups.find((g: { name: string }) => g.name === n);
    expect(by('Pareja').proposal.labels).toEqual(['1']);
    expect(by('Terraza').proposal.labels).toEqual(['T1']);
    expect(by('Grande').proposal.labels.sort()).toEqual(['5', '6']);
  });

  it('avisar protege la mesa; sentar la ocupa; pagada no es libre', async () => {
    const g = (await call(waiter, 'POST', '/api/waitlist', { name: 'Ruiz', partySize: 2 })).json();
    expect((await call(waiter, 'POST', `/api/waitlist/${g.id}/assign`, { tableIds: [T['1']] })).statusCode).toBe(200);
    const other = (await call(waiter, 'POST', '/api/waitlist', { name: 'Otro', partySize: 2 })).json();
    const r = await call(waiter, 'POST', `/api/waitlist/${other.id}/assign`, { tableIds: [T['1']] });
    expect(r.statusCode).toBe(409);
    expect((await call(waiter, 'POST', `/api/waitlist/${g.id}/seat`)).statusCode).toBe(200);
    const [t] = await sql`select physical_state from tables where id = ${T['1']}`;
    expect(t.physical_state).toBe('occupied');
    const w = (await call(waiter, 'GET', '/api/waitlist')).json();
    expect(w.groups.find((x: { name: string }) => x.name === 'Otro').proposal.labels).not.toContain('1');
  });

  it('una mesa con reserva confirmada en las próximas dos horas no se propone', async () => {
    const now = new Date(Date.now() + 60 * 60_000);
    const date = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const time = now.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
    const r = await call(admin, 'POST', '/api/reservations', { name: 'Reserva', partySize: 2, date, time, tableIds: [T['1']] });
    expect(r.statusCode, r.body).toBe(200);
    await call(waiter, 'POST', '/api/waitlist', { name: 'Pareja', partySize: 2 });
    const w = (await call(waiter, 'GET', '/api/waitlist')).json();
    expect(w.groups[0].proposal.labels).toEqual(['2']);
  });
});

describe('reservas', () => {
  it('detecta solapes de mesa', async () => {
    const base = { partySize: 2, date: tomorrow(), tableIds: [T['2']] };
    expect((await call(admin, 'POST', '/api/reservations', { ...base, name: 'A', time: '21:00' })).statusCode).toBe(200);
    const clash = await call(admin, 'POST', '/api/reservations', { ...base, name: 'B', time: '22:00' });
    expect(clash.statusCode).toBe(409);
    expect((await call(admin, 'POST', '/api/reservations', { ...base, name: 'C', time: '22:30' })).statusCode).toBe(200);
  });

  it('con fianza no se puede confirmar hasta que esté pagada', async () => {
    await call(admin, 'PUT', '/api/reservations/settings', { depositPerPersonCents: 1000, depositFromParty: 6 });
    const r = (await call(admin, 'POST', '/api/reservations', { name: 'Grupo', partySize: 8, date: tomorrow(), time: '21:00' })).json();
    expect(r.status).toBe('requested');
    expect(r.deposit_cents).toBe(8000);
    expect((await call(admin, 'PATCH', `/api/reservations/${r.id}`, { status: 'confirmed' })).json().error).toBe('deposit_required');
    expect((await call(admin, 'PATCH', `/api/reservations/${r.id}`, { status: 'confirmed', depositStatus: 'paid' })).statusCode).toBe(200);
  });

  it('formulario público: crea una solicitud, no una reserva confirmada, y respeta los turnos', async () => {
    const info = (await app.inject({ method: 'GET', url: '/api/public/booking/demo' })).json();
    expect(info.lunch.start).toBe('13:00');
    const out = await app.inject({ method: 'POST', url: '/api/public/booking/demo', payload: { name: 'Laura', phone: '600000000', partySize: 2, date: tomorrow(), time: '18:00' } });
    expect(out.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/public/booking/demo', payload: { name: 'Laura', phone: '600000000', partySize: 2, date: tomorrow(), time: '21:00' } });
    expect(ok.json().status).toBe('requested');
  });

  it('sentar una reserva ocupa sus mesas', async () => {
    const r = (await call(admin, 'POST', '/api/reservations', { name: 'Gil', partySize: 4, date: tomorrow(), time: '21:00', tableIds: [T['2']] })).json();
    expect((await call(admin, 'PATCH', `/api/reservations/${r.id}`, { status: 'seated' })).statusCode).toBe(200);
    const [t] = await sql`select physical_state from tables where id = ${T['2']}`;
    expect(t.physical_state).toBe('occupied');
  });
});

describe('factura completa e informes', () => {
  async function paidTicket() {
    const [p] = await sql`insert into products (establishment_id, name, price_cents) values (${est}, 'Plato', 1210) returning id`;
    const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId: T['2'] }, items: [{ productId: p.id, qty: 1 }] })).json();
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${o.accountId}`)).json();
    await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
    return (await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/payments`, { idempotencyKey: rid(), method: 'card', amountCents: 1210 })).json().documentId as string;
  }

  it('convierte el ticket en factura completa una sola vez y el ticket queda sustituido', async () => {
    const ticket = await paidTicket();
    const customer = { name: 'Empresa S.L.', taxId: 'B12345678', address: 'Calle 1', city: 'Madrid' };
    expect((await call(waiter, 'POST', `/api/service/documents/${ticket}/full`, { ...customer, taxId: 'x' })).statusCode).toBe(400);
    const full = await call(waiter, 'POST', `/api/service/documents/${ticket}/full`, customer);
    expect(full.statusCode, full.body).toBe(200);
    expect(full.json().series).toBe(`F${new Date().getFullYear()}`);
    expect((await call(waiter, 'POST', `/api/service/documents/${ticket}/full`, customer)).json().error).toBe('already_replaced');
    const today = new Date().toISOString().slice(0, 10);
    const rep = (await call(admin, 'GET', `/api/reports/cash?from=${today}&to=${today}`)).json();
    expect(rep.documents).toEqual([{ type: 'full', count: 1, total_cents: 1210 }]);
  });

  it('no convierte tickets de otro trimestre', async () => {
    const ticket = await paidTicket();
    await sql`update documents set created_at = now() - interval '4 months' where id = ${ticket}`;
    const r = await call(waiter, 'POST', `/api/service/documents/${ticket}/full`, { name: 'Empresa S.L.', taxId: 'B12345678', address: 'Calle 1' });
    expect(r.json().error).toBe('other_quarter');
  });

  it('informe de camareros con fichajes, comandas y cobros', async () => {
    await paidTicket();
    const today = new Date().toISOString().slice(0, 10);
    const rep = (await call(admin, 'GET', `/api/reports/waiters?from=${today}&to=${today}`)).json();
    expect(rep[0]).toMatchObject({ name: 'Ana', orders: 1, payments: 1, collected_cents: 1210 });
    expect(rep[0].shifts).toHaveLength(1);
  });
});
