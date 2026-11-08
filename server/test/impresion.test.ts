import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword, pinLookup } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { encode, kitchenTicket, Ticket } from '../src/services/escpos.js';

let app: FastifyInstance;
let est: string;
let admin: string;
let waiter: string;
let tableId: string;
const P: Record<string, string> = {};
let seq = 0;
const rid = () => `pr-${Date.now()}-${++seq}`;
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
async function login(url: string, payload: object) {
  const r = await app.inject({ method: 'POST', url, payload });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0];
}
const latin = (b: Buffer) => b.toString('latin1');
/** Quita los códigos de control ESC/POS para medir solo el texto visible. */
const visible = (l: string) => l.replace(/\x1bB[\s\S]{2}|\x1dV[\s\S]{2}|\x1b[aEdt][\s\S]|\x1d![\s\S]|\x1b@/g, '').replace(/[\x00-\x1f]/g, '');

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
  for (const [k, name, dest, course] of [['croq', 'Croquetas', 'kitchen', 1], ['entrecot', 'Entrecot', 'kitchen', 2], ['cana', 'Caña', 'bar', 1]] as const) {
    const [p] = await sql`insert into products (establishment_id, name, price_cents, destination, course) values (${est}, ${name}, 900, ${dest}, ${course}) returning id`;
    P[k] = p.id;
  }
  const [t] = await sql`insert into tables (establishment_id, label) values (${est}, '4') returning id`;
  tableId = t.id;
  admin = await login('/api/auth/login', { username: 'admin', password: 'secreto123' });
  waiter = await login('/api/auth/waiter', { establishment: 'demo', username: 'camarero-1', pin: '1234' });
  await call(waiter, 'POST', '/api/service/shift/start');
});

async function addPrinter(name: string, roles: string[], address = '192.168.1.50') {
  const r = await call(admin, 'POST', '/api/printing/printers', { name, connection: 'tcp', address, roles });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}

describe('ESC/POS', () => {
  it('codifica ñ, tildes y € en PC858 e inicializa con la página 19', () => {
    expect(encode('Año €5 ¿Qué? ¡Olé! º')).toEqual([0x41, 0xa4, 0x6f, 0x20, 0xd5, 0x35, 0x20, 0xa8, 0x51, 0x75, 0x82, 0x3f, 0x20, 0xad, 0x4f, 0x6c, 0x82, 0x21, 0x20, 0xa7]);
    expect(encode('Œ')).toEqual([0x3f]);
    const b = new Ticket(48).line('x').cut().build();
    expect([...b.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);
    expect([...b.subarray(-4)]).toEqual([0x1d, 0x56, 66, 0]);
  });

  it('alinea importes a la derecha en 48 columnas y parte líneas largas', () => {
    const t = latin(new Ticket(48).pair('Croquetas caseras', '9,50 €').build());
    const line = t.split('\n')[0].slice(5);
    expect(line).toHaveLength(48);
    expect(line.endsWith('9,50 \xd5')).toBe(true);
    const k = latin(kitchenTicket({ station: 'kitchen', place: 'Mesa 4', orderNumber: 7, createdAt: new Date(), waiter: 'Ana', note: 'Sin sal',
      items: [{ qty: 2, name: 'Entrecot a la brasa con patatas panaderas y pimientos', option: 'Al punto', course: 1 }] }, 48));
    expect(k).toContain('COCINA');
    expect(k).toContain('Mesa 4');
    expect(k).toContain('> Al punto');
    expect(k).toContain('NOTA: Sin sal');
    expect(k.split('\n').every((l) => visible(l).length <= 48)).toBe(true);
  });
});

describe('cola de impresión', () => {
  it('una comanda genera una impresión por puesto, sin el pase retenido; al marchar se imprime ese pase', async () => {
    const cocina = await addPrinter('Cocina', ['kitchen']);
    await addPrinter('Barra', ['bar', 'ticket'], '192.168.1.51');
    const o = (await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId: P.croq, qty: 2 }, { productId: P.entrecot, qty: 1 }, { productId: P.cana, qty: 3 }] })).json();
    let jobs = await sql`select kind, printer_id, payload from print_jobs order by created_at`;
    expect(jobs.map((j) => j.kind).sort()).toEqual(['bar', 'kitchen']);
    const k = latin(jobs.find((j) => j.kind === 'kitchen')!.payload);
    expect(k).toContain('Croquetas');
    expect(k).not.toContain('Entrecot\n');
    expect(k).toContain('En espera: 2.\xa7 pase');
    await call(waiter, 'POST', `/api/service/accounts/${o.accountId}/fire`);
    jobs = await sql`select kind, printer_id, payload from print_jobs where kind = 'fire'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].printer_id).toBe(cocina);
    expect(latin(jobs[0].payload)).toContain('MARCHAR 2.\xa7 PASE');
    expect(latin(jobs[0].payload)).toContain('Entrecot');
  });

  it('sin impresoras no pasa nada y la comanda se registra igual; el ticket automático es opcional', async () => {
    const r = await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId: P.cana, qty: 1 }] });
    expect(r.statusCode).toBe(200);
    expect((await sql`select count(*)::int as n from print_jobs`)[0].n).toBe(0);
    await addPrinter('Tickets', ['ticket']);
    await call(admin, 'PUT', '/api/printing/settings', { kitchen: false, bar: false, ticket: true });
    const acc = (await call(waiter, 'GET', `/api/service/accounts/${r.json().accountId}`)).json();
    await call(waiter, 'PATCH', '/api/service/items', { itemIds: acc.items.map((i: { id: string }) => i.id), status: 'delivered' });
    await call(waiter, 'POST', `/api/service/accounts/${acc.id}/payments`, { idempotencyKey: rid(), method: 'cash', amountCents: 900 });
    const [j] = await sql`select kind, payload from print_jobs`;
    expect(j.kind).toBe('ticket');
    expect(latin(j.payload)).toContain('FACTURA SIMPLIFICADA');
    expect(latin(j.payload)).toContain('9,00 \xd5');
  });

  it('el agente recoge trabajos con su token; sin respuesta vuelven a la cola; resultado impreso o fallido', async () => {
    const pid = await addPrinter('Cocina', ['kitchen']);
    const ag = (await call(admin, 'POST', '/api/printing/agents', { name: 'PC de barra' })).json();
    expect(ag.token).toMatch(/^lpa_/);
    expect((await app.inject({ method: 'POST', url: '/api/agent/poll', headers: { authorization: 'Bearer malo' } })).statusCode).toBe(401);
    const test = (await call(admin, 'POST', `/api/printing/printers/${pid}/test`)).json();
    const auth = { authorization: `Bearer ${ag.token}` };
    const polled = (await app.inject({ method: 'POST', url: '/api/agent/poll', headers: auth, payload: { version: '1.0.0' } })).json();
    expect(polled.jobs).toHaveLength(1);
    expect(polled.jobs[0].printer).toMatchObject({ connection: 'tcp', address: '192.168.1.50' });
    expect(latin(Buffer.from(polled.jobs[0].data, 'base64'))).toContain('PRUEBA');
    expect((await app.inject({ method: 'POST', url: '/api/agent/poll', headers: auth })).json().jobs).toHaveLength(0);
    await sql`update print_jobs set sent_at = now() - interval '2 minutes' where id = ${test.jobId}`;
    expect((await app.inject({ method: 'POST', url: '/api/agent/poll', headers: auth })).json().jobs).toHaveLength(1);
    await app.inject({ method: 'POST', url: `/api/agent/jobs/${test.jobId}/result`, headers: auth, payload: { ok: false, error: 'Sin papel' } });
    const [j] = await sql`select status, error, attempts from print_jobs where id = ${test.jobId}`;
    expect(j).toMatchObject({ status: 'failed', error: 'Sin papel', attempts: 2 });
    const info = (await call(admin, 'GET', '/api/printing')).json();
    expect(info.agents[0].online).toBe(true);
    expect(info.agents[0].version).toBe('1.0.0');
  });

  it('agente real: envía los bytes a una impresora de red (simulada en el puerto TCP)', async () => {
    const received: Buffer[] = [];
    const printer: Server = createServer((sock) => { const parts: Buffer[] = []; sock.on('data', (d) => parts.push(d)); sock.on('end', () => received.push(Buffer.concat(parts))); });
    await new Promise<void>((r) => printer.listen(0, '127.0.0.1', () => r()));
    const port = (printer.address() as { port: number }).port;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const serverUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const pid = await addPrinter('Cocina', ['kitchen'], `127.0.0.1:${port}`);
    const ag = (await call(admin, 'POST', '/api/printing/agents', { name: 'PC' })).json();
    await call(waiter, 'POST', '/api/service/orders', { clientRequestId: rid(), target: { tableId }, items: [{ productId: P.croq, qty: 2 }] });
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../agent/agente.mjs')], { env: { ...process.env, LORYAND_SERVER: serverUrl, LORYAND_TOKEN: ag.token }, stdio: 'pipe' });
    try {
      for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(1);
      expect(latin(received[0])).toContain('COCINA');
      expect(latin(received[0])).toContain('2 Croquetas');
      for (let i = 0; i < 30; i++) {
        const [j] = await sql`select status from print_jobs where printer_id = ${pid}`;
        if (j.status === 'printed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const [j] = await sql`select status from print_jobs where printer_id = ${pid}`;
      expect(j.status).toBe('printed');
    } finally {
      child.kill();
      printer.close();
    }
  });
});
