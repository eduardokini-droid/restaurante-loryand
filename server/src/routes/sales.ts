import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { establishmentOf, requireModule } from '../auth.js';
import { parse } from '../validate.js';

const TZ = 'Europe/Madrid';
const period = z.object({ from: z.string().date(), to: z.string().date() });

/**
 * Informe de ventas de un periodo. Se cuentan las cuentas COBRADAS en el periodo (fecha de cierre),
 * para que cuadre con la caja. Importes con IVA; también se da la base sin IVA por producto.
 */
async function salesReport(est: string, from: string, to: string) {
  const accounts = sql`select id from accounts where establishment_id = ${est} and status = 'paid'
                       and (closed_at at time zone ${TZ})::date between ${from}::date and ${to}::date`;
  const [kpi] = await sql<{ tickets: number; total_cents: number; discounts_cents: number }[]>`
    select count(*)::int as tickets,
           coalesce(sum((select sum(amount_cents) from payments p where p.account_id = a.id)), 0)::int as total_cents,
           coalesce(sum((select sum(amount_cents) from account_discounts d where d.account_id = a.id)), 0)::int as discounts_cents
    from accounts a where a.id in (${accounts})`;
  const byProduct = await sql`
    select i.name, coalesce(c.name, 'Sin categoría') as category, sum(i.qty)::int as qty,
           sum(i.unit_cents * i.qty)::int as gross_cents,
           sum(round(i.unit_cents * i.qty / (1 + i.vat_rate / 100)))::int as net_cents
    from order_items i join orders o on o.id = i.order_id
    left join products p on p.id = i.product_id left join categories c on c.id = p.category_id
    where o.account_id in (${accounts}) and i.status <> 'cancelled' and i.unit_cents > 0
    group by i.name, c.name order by gross_cents desc`;
  const byHour = await sql`
    select extract(hour from p.created_at at time zone ${TZ})::int as hour, count(distinct p.account_id)::int as tickets, sum(p.amount_cents)::int as cents
    from payments p where p.account_id in (${accounts}) group by 1 order by 1`;
  const byDay = await sql`
    select to_char(a.closed_at at time zone ${TZ}, 'YYYY-MM-DD') as day, count(*)::int as tickets,
           sum((select sum(amount_cents) from payments p where p.account_id = a.id))::int as cents
    from accounts a where a.id in (${accounts}) group by 1 order by 1`;
  const byWaiter = await sql`
    with taken as (
      select coalesce(w.name, case when o.source = 'client' then 'Carta del cliente' else 'TPV' end) as name, sum(i.unit_cents * i.qty)::int as cents
      from orders o join order_items i on i.order_id = o.id left join waiters w on w.id = o.waiter_id
      where o.account_id in (${accounts}) and i.status <> 'cancelled' group by 1),
    collected as (
      select coalesce(w.name, u.name, 'Cobro online') as name, count(*)::int as payments, sum(p.amount_cents)::int as cents
      from payments p left join waiters w on w.id = p.waiter_id left join users u on u.id = p.user_id
      where p.account_id in (${accounts}) group by 1)
    select coalesce(t.name, c.name) as name, coalesce(t.cents, 0) as taken_cents, coalesce(c.payments, 0) as payments, coalesce(c.cents, 0) as collected_cents
    from taken t full join collected c on c.name = t.name order by 2 desc, 4 desc`;
  const byCategory = Object.values(byProduct.reduce<Record<string, { category: string; qty: number; gross_cents: number }>>((m, r) => {
    m[r.category] ??= { category: r.category, qty: 0, gross_cents: 0 };
    m[r.category].qty += r.qty; m[r.category].gross_cents += r.gross_cents;
    return m;
  }, {})).sort((a, b) => b.gross_cents - a.gross_cents);
  const byMethod = await sql`select method, count(*)::int as count, sum(amount_cents)::int as cents from payments where account_id in (${accounts}) group by 1 order by 3 desc`;
  return {
    period: { from, to },
    kpi: { ...kpi, averageTicketCents: kpi.tickets ? Math.round(kpi.total_cents / kpi.tickets) : 0 },
    byProduct, byCategory, byHour, byDay, byWaiter, byMethod,
  };
}

const eur = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const cell = (v: string | number) => { const s = String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const METHOD: Record<string, string> = { cash: 'Efectivo', card: 'Tarjeta', bizum: 'Bizum' };

export default async function salesRoutes(app: FastifyInstance) {
  app.get('/api/reports/sales', async (req) => {
    requireModule(req, 'cash');
    const q = parse(period, req.query);
    return salesReport(establishmentOf(req), q.from, q.to);
  });

  /** Exportación para Excel (separador «;», decimales con coma, UTF-8 con BOM). */
  app.get('/api/reports/sales.csv', async (req, reply) => {
    requireModule(req, 'cash');
    const est = establishmentOf(req);
    const q = parse(period, req.query);
    const r = await salesReport(est, q.from, q.to);
    const [e] = await sql`select name from establishments where id = ${est}`;
    const rows: (string | number)[][] = [
      [`Informe de ventas · ${e.name}`], [`Periodo: ${q.from} a ${q.to}`], [],
      ['RESUMEN'], ['Tickets', r.kpi.tickets], ['Total cobrado (€)', eur(r.kpi.total_cents)], ['Ticket medio (€)', eur(r.kpi.averageTicketCents)], ['Descuentos (€)', eur(r.kpi.discounts_cents)], [],
      ['POR FORMA DE PAGO'], ['Forma de pago', 'Cobros', 'Importe (€)'], ...r.byMethod.map((m) => [METHOD[m.method] ?? m.method, m.count, eur(m.cents)]), [],
      ['POR PRODUCTO'], ['Producto', 'Categoría', 'Unidades', 'Importe con IVA (€)', 'Base sin IVA (€)'], ...r.byProduct.map((p) => [p.name, p.category, p.qty, eur(p.gross_cents), eur(p.net_cents)]), [],
      ['POR CATEGORÍA'], ['Categoría', 'Unidades', 'Importe con IVA (€)'], ...r.byCategory.map((c) => [c.category, c.qty, eur(c.gross_cents)]), [],
      ['POR DÍA'], ['Día', 'Tickets', 'Importe (€)'], ...r.byDay.map((d) => [d.day, d.tickets, eur(d.cents)]), [],
      ['POR HORA'], ['Hora', 'Tickets', 'Importe (€)'], ...r.byHour.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.tickets, eur(h.cents)]), [],
      ['POR CAMARERO'], ['Camarero', 'Comandas tomadas (€)', 'Cobros', 'Cobrado (€)'], ...r.byWaiter.map((w) => [w.name, eur(w.taken_cents), w.payments, eur(w.collected_cents)]),
    ];
    reply.header('content-disposition', `attachment; filename="ventas-${q.from}_${q.to}.csv"`).type('text/csv; charset=utf-8');
    return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
  });
}
