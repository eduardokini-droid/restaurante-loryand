import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireActor, requireModule } from '../auth.js';
import { forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { createShift, listShifts, timesheetCsv, toggleBreak, updateShift, voidShift } from '../services/timesheet.js';

const period = z.object({ from: z.string().date(), to: z.string().date(), waiterId: z.string().uuid().optional() });
const reason = z.string().trim().min(5, 'indica el motivo de la corrección (mínimo 5 caracteres)').max(300);
const ts = z.string().datetime({ offset: true }).transform((v) => new Date(v));

/** Registro de jornada: pausas del trabajador, consulta propia y gestión por el encargado. */
export default async function timesheetRoutes(app: FastifyInstance) {
  // ---------- Trabajador ----------
  app.post('/api/service/shift/break/start', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'waiter') throw forbidden('Solo el personal ficha');
    await toggleBreak(a.id, true);
    notify(a.establishmentId, ['waiters']);
    return { ok: true };
  });
  app.post('/api/service/shift/break/end', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'waiter') throw forbidden('Solo el personal ficha');
    await toggleBreak(a.id, false);
    notify(a.establishmentId, ['waiters']);
    return { ok: true };
  });
  /** Cada trabajador puede consultar sus propios fichajes. */
  app.get('/api/service/my-shifts', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'waiter') throw forbidden();
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const rows = await listShifts(sql, a.establishmentId, q.from, q.to, a.id);
    const [open] = await sql`select s.id, s.started_at, (select started_at from shift_breaks b where b.shift_id = s.id and b.ended_at is null) as break_since
                             from shifts s where s.waiter_id = ${a.id} and s.status = 'valid' and s.ended_at is null`;
    return { shifts: rows, current: open ?? null };
  });

  // ---------- Encargado ----------
  app.get('/api/staff/shifts', async (req) => {
    requireModule(req, 'waiters');
    const q = parse(period, req.query);
    return listShifts(sql, establishmentOf(req), q.from, q.to, q.waiterId);
  });

  app.get('/api/staff/shifts/:id/history', async (req) => {
    requireModule(req, 'waiters');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [s] = await sql`select s.id from shifts s join waiters w on w.id = s.waiter_id where s.id = ${id} and w.establishment_id = ${establishmentOf(req)}`;
    if (!s) throw notFound('Turno');
    return sql`select action, actor, before, after, reason, created_at from shift_edits where shift_id = ${id} order by created_at`;
  });

  app.post('/api/staff/shifts', async (req) => {
    const a = requireModule(req, 'waiters');
    const b = parse(z.object({ waiterId: z.string().uuid(), startedAt: ts, endedAt: ts.nullable(), reason }), req.body);
    const s = await createShift(establishmentOf(req), b.waiterId, b.startedAt, b.endedAt, b.reason, `${a.name} (${actorLabel(a)})`);
    notify(establishmentOf(req), ['waiters']);
    return s;
  });

  app.patch('/api/staff/shifts/:id', async (req) => {
    const a = requireModule(req, 'waiters');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ startedAt: ts.optional(), endedAt: ts.nullable().optional(), reason }), req.body);
    const s = await updateShift(establishmentOf(req), id, b.startedAt, b.endedAt, b.reason, `${a.name} (${actorLabel(a)})`);
    notify(establishmentOf(req), ['waiters']);
    return s;
  });

  app.post('/api/staff/shifts/:id/void', async (req) => {
    const a = requireModule(req, 'waiters');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ reason }), req.body);
    const s = await voidShift(establishmentOf(req), id, b.reason, `${a.name} (${actorLabel(a)})`);
    notify(establishmentOf(req), ['waiters']);
    return s;
  });

  /** Exportación para la gestoría o la Inspección de Trabajo (Excel). */
  app.get('/api/staff/timesheet.csv', async (req, reply) => {
    requireModule(req, 'waiters');
    const est = establishmentOf(req);
    const q = parse(period, req.query);
    const [e] = await sql`select name from establishments where id = ${est}`;
    const rows = await listShifts(sql, est, q.from, q.to, q.waiterId);
    reply.header('content-disposition', `attachment; filename="registro-jornada-${q.from}_${q.to}.csv"`).type('text/csv; charset=utf-8');
    return timesheetCsv(e.name, q.from, q.to, rows as never);
  });
}
