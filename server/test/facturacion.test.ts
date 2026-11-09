import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { totals } from '../src/services/billing.js';

let app: FastifyInstance;
let gestor: string;
let adminA: string;
let A: string;
let B: string;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const call = (cookie: string, method: string, url: string, payload?: object, est?: string) =>
  app.inject({ method: method as 'POST', url, payload, headers: { cookie, ...(est ? { 'x-establishment-id': est } : {}) } });
const login = async (username: string, password: string) => cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } }));
const ISSUER = { name: 'Loryand Soluciones S.L.', taxId: 'B99999999', address: 'C/ Tecnología 1', postalCode: '45001', city: 'Toledo', province: 'Toledo', email: 'facturas@loryand.es', iban: 'ES91 2100 0418 4502 0005 1332' };

beforeAll(async () => {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  app = await buildApp();
});
afterAll(async () => { await app.close(); await sql.end(); });

beforeEach(async () => {
  resetRateLimits();
  await sql.unsafe('truncate establishments, users, platform_invoices cascade');
  await sql`update platform_settings set data = '{}'::jsonb`;
  const [a] = await sql`insert into establishments (slug, name, legal_name, tax_id, address, city) values ('laurel', 'El Laurel', 'Laurel Hostelería S.L.', 'B11111111', 'C/ Mayor 1', 'Toledo') returning id`;
  const [b] = await sql`insert into establishments (slug, name) values ('sinnif', 'Bar Sin NIF') returning id`;
  A = a.id; B = b.id;
  await sql`insert into users (username, name, password_hash, role) values ('gestor', 'Gestor', ${await hashPassword('gestor-1234')}, 'superadmin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${A}, 'admina', 'Admin A', ${await hashPassword('secreto123')}, 'admin')`;
  await sql`insert into users (establishment_id, username, name, password_hash, role) values (${B}, 'adminb', 'Admin B', ${await hashPassword('secreto123')}, 'admin')`;
  gestor = await login('gestor', 'gestor-1234');
  adminA = await login('admina', 'secreto123');
});

describe('facturación de Loryand', () => {
  it('cálculo de base, IVA por tipo y total', () => {
    expect(totals([{ description: 'a', qty: 1, unitCents: 4900, vatRate: 21 }, { description: 'b', qty: 2, unitCents: 1000, vatRate: 21 }]))
      .toMatchObject({ base: 6900, vat: 1449, total: 8349 });
  });

  it('cuotas del mes: exige emisor completo, numera correlativo, no duplica y salta clientes sin NIF', async () => {
    await call(gestor, 'PUT', `/api/platform/clients/${A}/contract`, { planName: 'Plan TPV completo', monthlyCents: 4900, startDate: '2026-01-01' });
    await call(gestor, 'PUT', `/api/platform/clients/${B}/contract`, { planName: 'Plan básico', monthlyCents: 2900, startDate: '2026-01-01' });
    const noIssuer = await call(gestor, 'POST', '/api/platform/invoices/generate', { period: '2026-10' });
    expect(noIssuer.json().error).toBe('issuer_incomplete');
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    const r = (await call(gestor, 'POST', '/api/platform/invoices/generate', { period: '2026-10', issueDate: '2026-11-01' })).json();
    expect(r.created).toBe(1);
    expect(r.skipped).toEqual([{ establishment: 'Bar Sin NIF', reason: 'Faltan el NIF/CIF de «Bar Sin NIF» para facturarle' }]);
    expect((await call(gestor, 'POST', '/api/platform/invoices/generate', { period: '2026-10', issueDate: '2026-11-01' })).json().created).toBe(0);
    await call(gestor, 'PUT', `/api/platform/clients/${B}/contract`, { billingName: 'Pedro Gómez', billingTaxId: '12345678Z', billingAddress: 'C/ Ancha 3, Toledo' });
    expect((await call(gestor, 'POST', '/api/platform/invoices/generate', { period: '2026-10', issueDate: '2026-11-01' })).json().created).toBe(1);
    const list = (await call(gestor, 'GET', '/api/platform/invoices')).json();
    expect(list.map((i: { code: string }) => i.code).sort()).toEqual(['LR-2026-0001', 'LR-2026-0002']);
    const ia = list.find((i: { establishment_id: string }) => i.establishment_id === A);
    expect(ia).toMatchObject({ base_cents: 4900, vat_cents: 1029, total_cents: 5929, issue_date: '2026-11-01', due_date: '2026-11-16', period: '2026-10' });
    expect(ia.customer).toMatchObject({ name: 'Laurel Hostelería S.L.', taxId: 'B11111111' });
    expect(ia.issuer).toMatchObject({ name: 'Loryand Soluciones S.L.', iban: 'ES9121000418450200051332' });
    expect(ia.lines[0].description).toBe('Plan TPV completo · cuota de octubre de 2026');
    const ib = list.find((i: { establishment_id: string }) => i.establishment_id === B);
    expect(ib.customer).toMatchObject({ name: 'Pedro Gómez', taxId: '12345678Z' });
    // No se puede emitir con fecha anterior a la última de la serie.
    const back = await call(gestor, 'POST', '/api/platform/invoices', { establishmentId: A, issueDate: '2026-10-15', lines: [{ description: 'Impresora', qty: 1, unitCents: 18000 }] });
    expect(back.json().error).toBe('date_order');
  });

  it('cobro, rectificativa (anula sin borrar), vencidas y libro CSV', async () => {
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    const inv = (await call(gestor, 'POST', '/api/platform/invoices', { establishmentId: A, issueDate: '2026-09-01', lines: [{ description: 'Instalación y formación', qty: 1, unitCents: 15000 }, { description: 'Lector QR', qty: 2, unitCents: 2500 }] })).json();
    expect(inv).toMatchObject({ code: 'LR-2026-0001', base_cents: 20000, vat_cents: 4200, total_cents: 24200, overdue: true });
    expect((await call(gestor, 'GET', '/api/platform/invoices?status=overdue')).json()).toHaveLength(1);
    expect((await call(gestor, 'GET', '/api/platform/summary')).json()).toMatchObject({ pending_cents: 24200, overdue: 1 });
    const paid = (await call(gestor, 'POST', `/api/platform/invoices/${inv.id}/pay`, { paid: true, paidAt: '2026-09-10', method: 'Transferencia' })).json();
    expect(paid).toMatchObject({ status: 'paid', paid_at: '2026-09-10', overdue: false });
    expect((await call(gestor, 'POST', `/api/platform/invoices/${inv.id}/rectify`, { reason: 'x' })).statusCode).toBe(400);
    // Rectificación parcial: un lector se devuelve.
    const rect = (await call(gestor, 'POST', `/api/platform/invoices/${inv.id}/rectify`, { reason: 'Devolución de un lector QR', lines: [{ description: 'Devolución lector QR', qty: 1, unitCents: -2500 }] })).json();
    expect(rect).toMatchObject({ code: 'LRR-2026-0001', kind: 'rectifying', total_cents: -3025, reason: 'Devolución de un lector QR' });
    expect((await call(gestor, 'POST', `/api/platform/invoices/${inv.id}/rectify`, { reason: 'Otra vez' })).json().error).toBe('rectified');
    const detail = (await call(adminA, 'GET', `/api/platform/invoices/${rect.id}`)).json();
    expect(detail.rectifies).toEqual({ code: 'LR-2026-0001', issueDate: '2026-09-01' });
    const csv = (await call(gestor, 'GET', '/api/platform/invoices.csv?year=2026')).body;
    expect(csv).toContain('"LR-2026-0001";"2026-09-01";"Ordinaria";"";"Laurel Hostelería S.L.";"B11111111";"200,00";"21";"42,00";"242,00";"Rectificada";"2026-09-10"');
    expect(csv).toContain('"LRR-2026-0001";');
    expect(csv).toContain('"Rectificativa";"LR-2026-0001"');
    // Una factura con total negativo no se emite como ordinaria.
    expect((await call(gestor, 'POST', '/api/platform/invoices', { establishmentId: A, lines: [{ description: 'Abono', qty: 1, unitCents: -100 }] })).json().error).toBe('non_positive');
  });

  it('el cliente solo ve su contrato y sus facturas', async () => {
    await call(gestor, 'PUT', '/api/platform/billing-settings', ISSUER);
    await call(gestor, 'PUT', `/api/platform/clients/${A}/contract`, { planName: 'Plan TPV', monthlyCents: 3900 });
    const inv = (await call(gestor, 'POST', '/api/platform/invoices', { establishmentId: A, lines: [{ description: 'Cuota', qty: 1, unitCents: 3900 }] })).json();
    const sub = (await call(adminA, 'GET', '/api/subscription')).json();
    expect(sub.contract).toMatchObject({ plan_name: 'Plan TPV', monthly_cents: 3900 });
    expect(sub.invoices).toHaveLength(1);
    expect(sub.payTo.iban).toBe('ES9121000418450200051332');
    const adminB = await login('adminb', 'secreto123');
    expect((await call(adminB, 'GET', `/api/platform/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await call(adminB, 'GET', '/api/subscription')).json().invoices).toHaveLength(0);
    expect((await call(adminA, 'GET', '/api/platform/invoices')).statusCode).toBe(403);
    expect((await call(adminA, 'PUT', `/api/platform/clients/${A}/contract`, { monthlyCents: 0 })).statusCode).toBe(403);
  });
});

describe('incidencias', () => {
  it('el local abre, el gestor responde y resuelve; si el local vuelve a escribir, se reabre', async () => {
    const t = (await call(adminA, 'POST', '/api/support/tickets', { title: 'No imprime la cocina', body: 'Desde esta mañana no sale nada por la impresora de cocina.', category: 'hardware', priority: 'high' })).json();
    expect(t).toMatchObject({ status: 'open', number: expect.any(Number) });
    const list = (await call(gestor, 'GET', '/api/platform/tickets')).json();
    expect(list[0]).toMatchObject({ title: 'No imprime la cocina', establishment: 'El Laurel', unread_gestor: true });
    const r = (await call(gestor, 'POST', `/api/platform/tickets/${t.id}/messages`, { body: 'Reinicia el agente de impresión, por favor.' })).json();
    expect(r.status).toBe('waiting');
    expect((await call(adminA, 'GET', '/api/support/tickets')).json()[0].unread_client).toBe(true);
    const seen = (await call(adminA, 'GET', `/api/support/tickets/${t.id}`)).json();
    expect(seen.messages.map((m: { author_kind: string }) => m.author_kind)).toEqual(['client', 'gestor']);
    await call(gestor, 'PATCH', `/api/platform/tickets/${t.id}`, { status: 'resolved' });
    expect((await call(gestor, 'GET', '/api/platform/tickets')).json()).toHaveLength(0);
    const again = (await call(adminA, 'POST', `/api/support/tickets/${t.id}/messages`, { body: 'Ha vuelto a pasar.' })).json();
    expect(again.status).toBe('open');
    // Otro local no ve la incidencia.
    const adminB = await login('adminb', 'secreto123');
    expect((await call(adminB, 'GET', `/api/support/tickets/${t.id}`)).statusCode).toBe(404);
  });
});
