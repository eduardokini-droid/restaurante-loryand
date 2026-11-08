import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, can, establishmentOf, requireActor, requireModule } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { addMovement, closeSession, currentSession, openSession, summarize } from '../services/cash.js';
import { openDrawer, printZ } from '../services/printing.js';

/** Personal de caja: usuarios del panel con TPV o con Ventas y caja (los camareros de la PDA no). */
function requireTill(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind === 'user' && (can(a, 'tpv') || can(a, 'cash'))) return a;
  throw forbidden('Solo el personal de caja puede hacer esta operación');
}
const who = (a: { name: string }) => a.name;

/** Arqueo y cierre de caja (capítulo 16, ampliado). */
export default async function cashRoutes(app: FastifyInstance) {
  app.get('/api/cash/current', async (req) => {
    requireTill(req);
    const s = await currentSession(sql, establishmentOf(req));
    return s ? { session: s, summary: await summarize(sql, s) } : { session: null, summary: null };
  });

  app.post('/api/cash/open', async (req) => {
    const a = requireTill(req);
    const est = establishmentOf(req);
    const { floatCents } = parse(z.object({ floatCents: z.number().int().min(0).max(10_000_00) }), req.body);
    const s = await openSession(est, floatCents, who(a));
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'cash.open', { id: s.id, floatCents }));
    notify(est, ['payments']);
    return s;
  });

  /** Entradas y salidas de efectivo que no son ventas (cambio, pago a un proveedor en efectivo…). */
  app.post('/api/cash/movements', async (req) => {
    const a = requireTill(req);
    const est = establishmentOf(req);
    const b = parse(z.object({ kind: z.enum(['in', 'out']), amountCents: z.number().int().positive().max(10_000_00), reason: z.string().min(3, 'indica el motivo').max(200) }), req.body);
    const m = await addMovement(est, b.kind, b.amountCents, b.reason, who(a));
    await sql.begin((tx) => audit(tx, est, actorLabel(a), `cash.${b.kind}`, b));
    notify(est, ['payments']);
    return m;
  });

  /** Cierre: el recuento se introduce antes de ver lo esperado (arqueo ciego). */
  app.post('/api/cash/close', async (req) => {
    const a = requireModule(req, 'cash');
    const est = establishmentOf(req);
    const b = parse(z.object({
      countedCashCents: z.number().int().min(0).max(100_000_00),
      detail: z.record(z.string(), z.number().int().min(0)).nullable().default(null),
      notes: z.string().max(500).default(''),
    }), req.body);
    const c = await closeSession(est, b.countedCashCents, b.detail, b.notes, who(a));
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'cash.close', { id: c.id, number: c.number, difference: c.difference_cents }));
    await printZ(est, c.id).catch((err) => req.log.error({ err }, 'Error al imprimir el cierre'));
    notify(est, ['payments']);
    return c;
  });

  app.get('/api/cash/sessions', async (req) => {
    requireModule(req, 'cash');
    return sql`select id, number, opened_at, opened_by, closed_at, closed_by, opening_float_cents, expected_cash_cents, counted_cash_cents,
                      difference_cents, (report->>'totalCents')::int as total_cents
               from cash_sessions where establishment_id = ${establishmentOf(req)} and status = 'closed' order by closed_at desc limit 100`;
  });

  app.get('/api/cash/sessions/:id', async (req) => {
    requireModule(req, 'cash');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [s] = await sql`select * from cash_sessions where id = ${id} and establishment_id = ${establishmentOf(req)}`;
    if (!s) throw notFound('Cierre');
    return s;
  });

  app.post('/api/cash/sessions/:id/print', async (req) => {
    requireModule(req, 'cash');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    if (!(await printZ(establishmentOf(req), id))) throw conflict('no_printer', 'No hay impresora de tickets configurada o el cierre no existe');
    return { ok: true };
  });

  app.post('/api/cash/drawer', async (req) => {
    const a = requireTill(req);
    const est = establishmentOf(req);
    if (!(await openDrawer(est))) throw conflict('no_printer', 'Configura una impresora de tickets con el cajón conectado');
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'cash.drawer', {}));
    return { ok: true };
  });
}
