import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { establishmentOf, requireModule } from '../auth.js';
import { parse } from '../validate.js';

export default async function reportRoutes(app: FastifyInstance) {
  /** Resumen de caja de un periodo. "Cobrado" y "pendiente" son magnitudes distintas y se muestran por separado. */
  app.get('/api/reports/cash', async (req) => {
    requireModule(req, 'cash');
    const est = establishmentOf(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const from = `${q.from}T00:00:00`;
    const to = `${q.to}T23:59:59.999`;
    const byMethod = await sql`
      select method, count(*)::int as count, sum(amount_cents)::int as total_cents
      from payments where establishment_id = ${est} and created_at between ${from}::timestamp and ${to}::timestamp
      group by method order by method`;
    const byWaiter = await sql`
      select coalesce(w.name, u.name, 'Sin asignar') as name, count(*)::int as count, sum(p.amount_cents)::int as total_cents
      from payments p left join waiters w on w.id = p.waiter_id left join users u on u.id = p.user_id
      where p.establishment_id = ${est} and p.created_at between ${from}::timestamp and ${to}::timestamp
      group by 1 order by 3 desc`;
    const documents = await sql`
      select type, count(*)::int as count, sum(total_cents)::int as total_cents
      from documents where establishment_id = ${est} and status = 'valid' and created_at between ${from}::timestamp and ${to}::timestamp
      group by type`;
    const pending = await sql`
      select a.id, coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place, a.opened_at,
             (coalesce((select sum(i.unit_cents*i.qty) from orders o join order_items i on i.order_id = o.id where o.account_id = a.id and i.status <> 'cancelled'), 0)
              - coalesce((select sum(amount_cents) from payments where account_id = a.id), 0))::int as pending_cents
      from accounts a left join tables t on t.id = a.table_id
      where a.establishment_id = ${est} and a.status = 'open'
      order by a.opened_at`;
    const total = byMethod.reduce((s, r) => s + r.total_cents, 0);
    return {
      period: q, totalCents: total, byMethod, byWaiter, documents,
      pending: pending.filter((p) => p.pending_cents > 0),
      pendingCents: pending.reduce((s, p) => s + Math.max(0, p.pending_cents), 0),
    };
  });

  app.get('/api/reports/documents', async (req) => {
    requireModule(req, 'cash');
    const est = establishmentOf(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date(), type: z.enum(['proforma', 'simplified', 'full']).optional() }), req.query);
    return sql`
      select id, type, series, number, total_cents, status, created_at, payload->>'place' as place, payload->>'waiter' as waiter
      from documents
      where establishment_id = ${est} and created_at between ${q.from + 'T00:00:00'}::timestamp and ${q.to + 'T23:59:59.999'}::timestamp
        and (${q.type ?? null}::text is null or type = ${q.type ?? null})
      order by created_at desc limit 500`;
  });

  /** Informe de camareros: fichajes, comandas tomadas y cobros realizados (capítulo 24). */
  app.get('/api/reports/waiters', async (req) => {
    requireModule(req, 'cash');
    const est = establishmentOf(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    const from = `${q.from}T00:00:00`;
    const to = `${q.to}T23:59:59.999`;
    return sql`
      select w.id, w.name, 'camarero-' || w.code as username,
        coalesce((select json_agg(json_build_object('start', s.started_at, 'end', s.ended_at) order by s.started_at)
                  from shifts s where s.waiter_id = w.id and s.started_at between ${from}::timestamp and ${to}::timestamp), '[]') as shifts,
        coalesce((select sum(extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)) / 60)::int
                  from shifts s where s.waiter_id = w.id and s.started_at between ${from}::timestamp and ${to}::timestamp), 0) as worked_min,
        (select count(*)::int from orders o where o.waiter_id = w.id and o.created_at between ${from}::timestamp and ${to}::timestamp) as orders,
        coalesce((select sum(i.unit_cents * i.qty)::int from orders o join order_items i on i.order_id = o.id
                  where o.waiter_id = w.id and i.status <> 'cancelled' and o.created_at between ${from}::timestamp and ${to}::timestamp), 0) as ordered_cents,
        (select count(*)::int from payments p where p.waiter_id = w.id and p.created_at between ${from}::timestamp and ${to}::timestamp) as payments,
        coalesce((select sum(p.amount_cents)::int from payments p where p.waiter_id = w.id and p.created_at between ${from}::timestamp and ${to}::timestamp), 0) as collected_cents
      from waiters w where w.establishment_id = ${est}
      order by w.name`;
  });
}
