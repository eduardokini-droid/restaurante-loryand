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
const W: Record<string, { id: string; qr: string }> = {};
const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

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
  for (const [code, name, pin] of [[1, 'Ana', '1111'], [2, 'Luis', '2222']] as const) {
    const [w] = await sql`insert into waiters (establishment_id, code, name, pin_hash, pin_lookup) values (${est}, ${code}, ${name}, ${await hashPassword(pin)}, ${pinLookup(est, pin)}) returning id, qr_token`;
    W[name] = { id: w.id, qr: w.qr_token };
  }
  const r = await post('/api/auth/login', { username: 'admin', password: 'secreto123' });
  admin = String(r.headers['set-cookie']).split(';')[0];
});

describe('acceso de camareros desde el TPV', () => {
  it('el QR del TPV solo sirve con el PIN de ese camarero, una vez, y puede fichar la entrada', async () => {
    const a = (await call(admin, 'POST', '/api/service/waiter-access', { waiterId: W.Ana.id })).json();
    expect(a.path).toBe(`/personal?acceso=${a.token}`);
    expect((await app.inject({ method: 'GET', url: `/api/auth/waiter-access/${a.token}` })).json()).toMatchObject({ waiter: 'Ana', establishment: 'Casa Demo', valid: true });
    // Luis lee el QR de Ana: con su propio PIN no entra
    const wrong = await post('/api/auth/waiter', { accessToken: a.token, pin: '2222' });
    expect(wrong.statusCode).toBe(401);
    // Ana entra con su PIN y ficha a la vez
    const ok = await post('/api/auth/waiter', { accessToken: a.token, pin: '1111', clockIn: true });
    expect(ok.statusCode, ok.body).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    const me = (await call(cookie, 'GET', '/api/auth/me')).json();
    expect(me.actor.name).toBe('Ana');
    expect(me.shift).not.toBeNull();
    // segundo uso: rechazado
    expect((await post('/api/auth/waiter', { accessToken: a.token, pin: '1111' })).json().error).toBe('access_expired');
    expect((await app.inject({ method: 'GET', url: `/api/auth/waiter-access/${a.token}` })).json().valid).toBe(false);
  });

  it('caduca a los 2 minutos y solo lo genera el personal del TPV, no un camarero', async () => {
    const a = (await call(admin, 'POST', '/api/service/waiter-access', { waiterId: W.Ana.id })).json();
    await sql`update waiter_access_tokens set expires_at = now() - interval '1 second'`;
    expect((await post('/api/auth/waiter', { accessToken: a.token, pin: '1111' })).statusCode).toBe(410);
    const b = (await call(admin, 'POST', '/api/service/waiter-access', { waiterId: W.Ana.id })).json();
    const ok = await post('/api/auth/waiter', { accessToken: b.token, pin: '1111' });
    const waiter = String(ok.headers['set-cookie']).split(';')[0];
    expect((await call(waiter, 'POST', '/api/service/waiter-access', { waiterId: W.Luis.id })).statusCode).toBe(403);
  });

  it('el QR personal impreso ya no entra sin PIN', async () => {
    expect((await post('/api/auth/waiter', { qrToken: W.Ana.qr })).statusCode).toBe(400);
    expect((await post('/api/auth/waiter', { qrToken: W.Ana.qr, pin: '2222' })).statusCode).toBe(401);
    expect((await post('/api/auth/waiter', { qrToken: W.Ana.qr, pin: '1111' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/auth/waiter-qr/${W.Ana.qr}` })).json().waiter).toBe('Ana');
  });

  it('muchos PIN fallidos bloquean temporalmente', async () => {
    const a = (await call(admin, 'POST', '/api/service/waiter-access', { waiterId: W.Ana.id })).json();
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await post('/api/auth/waiter', { accessToken: a.token, pin: String(3000 + i) })).statusCode;
    expect(last).toBe(429);
  });
});
