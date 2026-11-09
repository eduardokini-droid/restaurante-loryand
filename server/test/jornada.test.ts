import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { autoCloseForgotten } from '../src/services/timesheet.js';

let app: FastifyInstance;
let est: string;
let admin: string;
const W: Record<string, string> = {};
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

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
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${est}, 'admin', 'Marta (encargada)', ${await hashPassword('secreto123')}, 'admin')`;
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  const ana = (await call(admin, 'POST', '/api/admin/waiters', { name: 'Ana', pin: '1111', documentId: '12345678z' })).json();
  const pepe = (await call(admin, 'POST', '/api/admin/waiters', { name: 'Pepe', pin: '2222', staffRole: 'cocina' })).json();
  W.Ana = ana.id; W.Pepe = pepe.id;
});

describe('registro de jornada', () => {
  it('el personal de cocina ficha y hace pausas, pero no puede tomar comandas', async () => {
    const pepe = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-2', pin: '2222', clockIn: true });
    const me = (await call(pepe, 'GET', '/api/auth/me')).json();
    expect(me.staffRole).toBe('cocina');
    expect(me.shift).not.toBeNull();
    expect((await call(pepe, 'POST', '/api/service/shift/break/start')).statusCode).toBe(200);
    expect((await call(pepe, 'POST', '/api/service/shift/break/start')).json().error).toBe('break_open');
    await sql`update shift_breaks set started_at = now() - interval '30 minutes'`;
    await sql`update shifts set started_at = now() - interval '4 hours'`;
    await call(pepe, 'POST', '/api/service/shift/break/end');
    await call(pepe, 'POST', '/api/service/shift/end');
    const mine = (await call(pepe, 'GET', `/api/service/my-shifts?from=${today()}&to=${today()}`)).json();
    expect(mine.shifts[0]).toMatchObject({ break_min: 30, worked_min: 210 });
    const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '1') returning id`;
    const [p] = await sql`insert into products (establishment_id, name, price_cents) values (${est}, 'Café', 150) returning id`;
    await call(pepe, 'POST', '/api/service/shift/start');
    const r = await call(pepe, 'POST', '/api/service/orders', { clientRequestId: 'x-1-aaaaaaa', target: { tableId: t.id }, items: [{ productId: p.id, qty: 1 }] });
    expect(r.statusCode).toBe(403);
    expect((await call(admin, 'GET', '/api/service/waiters')).json().map((w: { name: string }) => w.name)).toEqual(['Ana']);
    expect((await call(admin, 'GET', '/api/service/waiters?todos=1')).json()).toHaveLength(2);
  });

  it('salida olvidada: se cierra con la última actividad y queda pendiente de revisar, sin inventar horas', async () => {
    const [s] = await sql`insert into shifts (waiter_id, started_at) values (${W.Ana}, now() - interval '20 hours') returning id`;
    await sql`with a as (insert into accounts (establishment_id, bar_name, waiter_id) values (${est}, 'X', ${W.Ana}) returning id)
              insert into orders (establishment_id, account_id, number, source, waiter_id, client_request_id, created_at)
              select ${est}, a.id, 1, 'pda', ${W.Ana}, 'r1', now() - interval '13 hours' from a`;
    expect(await autoCloseForgotten()).toBe(1);
    const [x] = await sql`select ended_at, needs_review, extract(epoch from (now() - ended_at))/3600 as hours_ago from shifts where id = ${s.id}`;
    expect(x.needs_review).toBe(true);
    expect(Math.round(x.hours_ago)).toBe(13);
    const [e] = await sql`select action, actor from shift_edits where shift_id = ${s.id}`;
    expect(e).toEqual({ action: 'auto_close', actor: 'sistema' });
    // al fichar de nuevo, el turno olvidado ya no bloquea
    const ana = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1111', clockIn: true });
    expect((await call(ana, 'GET', '/api/auth/me')).json().shift).not.toBeNull();
  });

  it('correcciones del encargado con motivo obligatorio, sin solapes, y con historial completo', async () => {
    const day = daysAgo(1);
    const create = await call(admin, 'POST', '/api/staff/shifts', { waiterId: W.Ana, startedAt: `${day}T09:00:00+01:00`, endedAt: `${day}T17:00:00+01:00`, reason: 'Olvidó fichar: confirmado con ella' });
    expect(create.statusCode, create.body).toBe(200);
    const sid = create.json().id;
    expect((await call(admin, 'POST', '/api/staff/shifts', { waiterId: W.Ana, startedAt: `${day}T16:00:00+01:00`, endedAt: `${day}T20:00:00+01:00`, reason: 'Turno de tarde' })).json().error).toBe('overlap');
    expect((await call(admin, 'PATCH', `/api/staff/shifts/${sid}`, { endedAt: `${day}T18:00:00+01:00`, reason: 'x' })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/staff/shifts/${sid}`, { endedAt: `${day}T08:00:00+01:00`, reason: 'Salida antes de entrada' })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/api/staff/shifts/${sid}`, { endedAt: `${day}T18:00:00+01:00`, reason: 'Se quedó a cerrar la cocina' })).statusCode).toBe(200);
    const hist = (await call(admin, 'GET', `/api/staff/shifts/${sid}/history`)).json();
    expect(hist.map((h: { action: string }) => h.action)).toEqual(['create', 'update']);
    expect(hist[1].actor).toContain('Marta');
    expect(new Date(hist[1].before.endedAt).toISOString()).toBe(new Date(`${day}T17:00:00+01:00`).toISOString());
    const list = (await call(admin, 'GET', `/api/staff/shifts?from=${day}&to=${day}`)).json();
    expect(list[0]).toMatchObject({ worked_min: 540, corrections: 2 });
    // anular no borra: queda con su motivo y no cuenta horas
    await call(admin, 'POST', `/api/staff/shifts/${sid}/void`, { reason: 'Registrado por error en otro trabajador' });
    const after = (await call(admin, 'GET', `/api/staff/shifts?from=${day}&to=${day}`)).json();
    expect(after[0]).toMatchObject({ status: 'voided', worked_min: 0 });
  });

  it('exportación CSV para Excel con DNI, pausas, horas, estado y correcciones', async () => {
    const day = daysAgo(2);
    await call(admin, 'POST', '/api/staff/shifts', { waiterId: W.Ana, startedAt: `${day}T10:00:00+01:00`, endedAt: `${day}T14:30:00+01:00`, reason: 'Alta manual por fallo del móvil' });
    const r = await call(admin, 'GET', `/api/staff/timesheet.csv?from=${day}&to=${today()}`);
    expect(r.headers['content-type']).toContain('text/csv');
    const csv = r.body;
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Fecha;Trabajador;DNI/NIE;Puesto;Entrada;Salida;Pausas (min);Tiempo trabajado (h:mm);Estado;Correcciones e incidencias');
    expect(csv).toMatch(/Ana;12345678Z;Sala;10:00;14:30;0;4:30;Corregido;Marta \(encargada\)/);
    expect(csv).toContain('Totales del periodo');
  });

  it('un camarero no ve el registro de los demás', async () => {
    const ana = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1111' });
    expect((await call(ana, 'GET', `/api/staff/shifts?from=${today()}&to=${today()}`)).statusCode).toBe(403);
  });
});
