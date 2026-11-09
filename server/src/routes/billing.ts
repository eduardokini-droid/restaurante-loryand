import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { actorLabel, establishmentOf, requireActor } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { audit } from '../services/audit.js';
import { DEFAULT_ISSUER, generateMonthly, getIssuer, invoiceNumber, issueInvoice, totals, type Line } from '../services/billing.js';

function requireSuper(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || a.role !== 'superadmin') throw forbidden();
  return a;
}
/** Administrador del local (o el gestor dentro de un local): ve su contrato, sus facturas y sus incidencias. */
function requireClientAdmin(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || (a.role !== 'admin' && a.role !== 'superadmin')) throw forbidden('Solo el administrador del local');
  return { a, est: establishmentOf(req) };
}

const uuid = z.object({ id: z.string().uuid() });
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes no válido (AAAA-MM)');
const date = z.string().date();
const line = z.object({
  description: z.string().trim().min(1).max(200),
  qty: z.number().positive().max(10000),
  unitCents: z.number().int().min(-10_000_000).max(10_000_000),
  vatRate: z.number().min(0).max(30).default(21),
});
const STATUS_ES: Record<string, string> = { issued: 'Pendiente', paid: 'Cobrada', rectified: 'Rectificada' };
const euros = (c: number) => (c / 100).toFixed(2).replace('.', ',');

/** Datos de una factura para el listado y la impresión. */
// Las columnas date llegan como Date a medianoche UTC: se devuelven como 'AAAA-MM-DD'.
const ds = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
const todayMadrid = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const shape = (i: Record<string, any>) => {
  const due = ds(i.due_date)!;
  return {
    ...i, issue_date: ds(i.issue_date), due_date: due, paid_at: ds(i.paid_at),
    code: invoiceNumber(i as never), overdue: i.status === 'issued' && i.kind === 'invoice' && due < todayMadrid(),
    vatBreakdown: totals(i.lines as Line[]).byRate,
  };
};

export default async function billingRoutes(app: FastifyInstance) {
  // ---------- Emisor ----------
  app.get('/api/platform/billing-settings', async (req) => { requireSuper(req); return getIssuer(sql); });
  app.put('/api/platform/billing-settings', async (req) => {
    const a = requireSuper(req);
    const s = z.string().trim();
    const b = parse(z.object({
      name: s.max(160), taxId: s.max(20), address: s.max(200), postalCode: s.max(10), city: s.max(80), province: s.max(80),
      email: s.max(120), phone: s.max(30), iban: s.max(40).transform((v) => v.replace(/\s/g, '').toUpperCase()),
      series: s.min(1).max(10).regex(/^[A-Z0-9]+$/i, 'Serie: solo letras y números').transform((v) => v.toUpperCase()),
      rectifyingSeries: s.min(1).max(10).regex(/^[A-Z0-9]+$/i, 'Serie: solo letras y números').transform((v) => v.toUpperCase()),
      paymentDays: z.number().int().min(0).max(120), footer: s.max(500),
    }).partial(), req.body);
    const cur = await getIssuer(sql);
    const next = { ...cur, ...b };
    if (next.series === next.rectifyingSeries) throw conflict('same_series', 'La serie de rectificativas debe ser distinta');
    await sql.begin(async (tx) => {
      await tx`update platform_settings set data = ${tx.json(next as never)} where id`;
      await audit(tx, null, actorLabel(a), 'billing.settings', b);
    });
    return next;
  });

  // ---------- Clientes y contratos ----------
  app.get('/api/platform/clients', async (req) => {
    requireSuper(req);
    return sql`
      select e.id, e.slug, e.name, e.legal_name, e.tax_id, e.email, e.phone, e.features, e.active, e.created_at,
             (select count(*)::int from tables t where t.establishment_id = e.id and t.active) as active_tables,
             c.plan_name, c.monthly_cents, c.vat_rate, to_char(c.start_date, 'YYYY-MM-DD') as start_date, c.status as contract_status, c.payment_method,
             c.billing_name, c.billing_tax_id, c.billing_address, c.billing_email, c.notes,
             (select coalesce(sum(i.total_cents), 0)::int from platform_invoices i where i.establishment_id = e.id and i.status = 'issued') as pending_cents,
             (select count(*)::int from platform_invoices i where i.establishment_id = e.id and i.status = 'issued' and i.kind = 'invoice' and i.due_date < current_date) as overdue,
             (select count(*)::int from support_tickets s where s.establishment_id = e.id and s.status <> 'resolved') as open_tickets
      from establishments e left join contracts c on c.establishment_id = e.id order by e.name`;
  });

  app.put('/api/platform/clients/:id/contract', async (req) => {
    const a = requireSuper(req);
    const { id } = parse(uuid, req.params);
    const s = z.string().trim();
    const b = parse(z.object({
      planName: s.min(1).max(80), monthlyCents: z.number().int().min(0).max(10_000_000), vatRate: z.number().min(0).max(30),
      startDate: date, status: z.enum(['active', 'paused', 'cancelled']), paymentMethod: z.enum(['transfer', 'direct_debit', 'card', 'other']),
      billingName: s.max(160), billingTaxId: s.max(20), billingAddress: s.max(200), billingEmail: s.max(120), notes: s.max(1000),
    }).partial(), req.body);
    const [e] = await sql`select 1 from establishments where id = ${id}`;
    if (!e) throw notFound('Establecimiento');
    const map: Record<string, string> = { planName: 'plan_name', monthlyCents: 'monthly_cents', vatRate: 'vat_rate', startDate: 'start_date', status: 'status',
      paymentMethod: 'payment_method', billingName: 'billing_name', billingTaxId: 'billing_tax_id', billingAddress: 'billing_address', billingEmail: 'billing_email', notes: 'notes' };
    const cols: Record<string, unknown> = { updated_at: new Date() };
    for (const [k, c] of Object.entries(map)) if (b[k as keyof typeof b] !== undefined) cols[c] = b[k as keyof typeof b];
    return sql.begin(async (tx) => {
      await tx`insert into contracts (establishment_id) values (${id}) on conflict do nothing`;
      const [c] = await tx`update contracts set ${tx(cols)} where establishment_id = ${id} returning *`;
      await audit(tx, id, actorLabel(a), 'contract.update', b);
      return c;
    });
  });

  // ---------- Facturas ----------
  app.get('/api/platform/invoices', async (req) => {
    requireSuper(req);
    const f = parse(z.object({ establishmentId: z.string().uuid().optional(), status: z.enum(['issued', 'paid', 'rectified', 'overdue']).optional(), year: z.coerce.number().int().optional() }), req.query);
    const rows = await sql`
      select i.*, e.name as establishment from platform_invoices i join establishments e on e.id = i.establishment_id
      where (${f.establishmentId ?? null}::uuid is null or i.establishment_id = ${f.establishmentId ?? null})
        and (${f.year ?? null}::int is null or i.year = ${f.year ?? null})
        and (${f.status ?? null}::text is null or (${f.status ?? ''} = 'overdue' and i.status = 'issued' and i.kind = 'invoice' and i.due_date < current_date) or i.status = ${f.status ?? ''})
      order by i.issue_date desc, i.series, i.number desc limit 500`;
    return rows.map(shape);
  });

  app.post('/api/platform/invoices', async (req) => {
    const a = requireSuper(req);
    const b = parse(z.object({ establishmentId: z.string().uuid(), lines: z.array(line).min(1).max(50), issueDate: date.optional() }), req.body);
    const inv = await sql.begin(async (tx) => {
      const i = await issueInvoice(tx, { establishmentId: b.establishmentId, lines: b.lines, actor: actorLabel(a), issueDate: b.issueDate });
      if (i.total_cents <= 0) throw conflict('non_positive', 'El total debe ser positivo. Para devolver importes, rectifica la factura original.');
      await audit(tx, b.establishmentId, actorLabel(a), 'invoice.issue', { id: i.id, number: invoiceNumber(i as never) });
      return i;
    });
    return shape(inv);
  });

  app.post('/api/platform/invoices/generate', async (req) => {
    const a = requireSuper(req);
    const b = parse(z.object({ period, issueDate: date.optional() }), req.body);
    const r = await generateMonthly(b.period, actorLabel(a), b.issueDate);
    await sql.begin((tx) => audit(tx, null, actorLabel(a), 'invoice.generate', { period: b.period, created: r.created }));
    return r;
  });

  app.post('/api/platform/invoices/:id/pay', async (req) => {
    const a = requireSuper(req);
    const { id } = parse(uuid, req.params);
    const b = parse(z.object({ paid: z.boolean(), paidAt: date.optional(), method: z.string().trim().max(40).optional() }), req.body);
    return sql.begin(async (tx) => {
      const [i] = await tx`select status, establishment_id from platform_invoices where id = ${id} for update`;
      if (!i) throw notFound('Factura');
      if (i.status === 'rectified') throw conflict('rectified', 'La factura está rectificada');
      const [u] = b.paid
        ? await tx`update platform_invoices set status = 'paid', paid_at = coalesce(${b.paidAt ?? null}::date, current_date), paid_method = ${b.method ?? null} where id = ${id} returning *`
        : await tx`update platform_invoices set status = 'issued', paid_at = null, paid_method = null where id = ${id} returning *`;
      await audit(tx, i.establishment_id, actorLabel(a), b.paid ? 'invoice.paid' : 'invoice.unpaid', { id });
      return shape(u);
    });
  });

  /** Factura rectificativa por diferencias (art. 15 del Reglamento de facturación). Anula total o parcialmente la original. */
  app.post('/api/platform/invoices/:id/rectify', async (req) => {
    const a = requireSuper(req);
    const { id } = parse(uuid, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(5, 'Indica el motivo').max(300), lines: z.array(line).min(1).max(50).optional() }), req.body);
    const inv = await sql.begin(async (tx) => {
      const [o] = await tx`select * from platform_invoices where id = ${id} for update`;
      if (!o) throw notFound('Factura');
      if (o.kind !== 'invoice') throw conflict('not_invoice', 'Solo se rectifican facturas ordinarias');
      if (o.status === 'rectified') throw conflict('rectified', 'Esta factura ya está rectificada');
      // Por defecto, anulación total: las mismas líneas en negativo.
      const lines: Line[] = b.lines ?? (o.lines as Line[]).map((l) => ({ ...l, unitCents: -l.unitCents }));
      const r = await issueInvoice(tx, { establishmentId: o.establishment_id, lines, actor: actorLabel(a), kind: 'rectifying', rectifiesId: id, reason: b.reason, customer: o.customer });
      if (r.total_cents >= 0) throw conflict('not_negative', 'La rectificativa debe restar importe');
      if (-r.total_cents > o.total_cents) throw conflict('too_much', 'La rectificativa no puede superar el importe de la factura');
      await tx`update platform_invoices set status = 'rectified' where id = ${id}`;
      await audit(tx, o.establishment_id, actorLabel(a), 'invoice.rectify', { id, rectifying: r.id, reason: b.reason });
      return r;
    });
    return shape(inv);
  });

  /** Una factura: el gestor, o el administrador del local al que va dirigida. */
  app.get('/api/platform/invoices/:id', async (req) => {
    const a = requireActor(req);
    const { id } = parse(uuid, req.params);
    const [i] = await sql`select i.*, r.series as r_series, r.year as r_year, r.number as r_number, r.issue_date as r_date
                          from platform_invoices i left join platform_invoices r on r.id = i.rectifies_id where i.id = ${id}`;
    if (!i) throw notFound('Factura');
    const isSuper = a.kind === 'user' && a.role === 'superadmin';
    const isOwner = a.kind === 'user' && a.role === 'admin' && a.establishmentId === i.establishment_id;
    if (!isSuper && !isOwner) throw notFound('Factura');
    return { ...shape(i), rectifies: i.rectifies_id ? { code: invoiceNumber({ series: i.r_series, year: i.r_year, number: i.r_number }), issueDate: ds(i.r_date) } : null };
  });

  /** Libro de facturas emitidas para la gestoría (Excel). */
  app.get('/api/platform/invoices.csv', async (req, reply) => {
    requireSuper(req);
    const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100) }), req.query);
    const rows = await sql`select * from platform_invoices where year = ${year} order by series, number`;
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const out = [['Número', 'Fecha', 'Tipo', 'Rectifica a', 'Cliente', 'NIF cliente', 'Base', 'Tipo IVA', 'Cuota IVA', 'Total', 'Estado', 'Cobrada el'].map(q).join(';')];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      const rect = r.rectifies_id && byId.get(r.rectifies_id);
      for (const v of totals(r.lines as Line[]).byRate) {
        out.push([invoiceNumber(r as never), ds(r.issue_date), r.kind === 'invoice' ? 'Ordinaria' : 'Rectificativa',
          rect ? invoiceNumber(rect as never) : '', r.customer.name, r.customer.taxId, euros(v.baseCents), `${v.rate}`.replace('.', ','), euros(v.vatCents),
          euros(v.baseCents + v.vatCents), STATUS_ES[r.status], ds(r.paid_at) ?? ''].map(q).join(';'));
      }
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="facturas-loryand-${year}.csv"`);
    return '﻿' + out.join('\r\n') + '\r\n';
  });

  // ---------- Vista del cliente: su suscripción ----------
  app.get('/api/subscription', async (req) => {
    const { est } = requireClientAdmin(req);
    const [c] = await sql`select c.plan_name, c.monthly_cents, c.vat_rate, to_char(c.start_date, 'YYYY-MM-DD') as start_date, c.status, c.payment_method, e.features
                          from establishments e left join contracts c on c.establishment_id = e.id where e.id = ${est}`;
    const invoices = await sql`select * from platform_invoices where establishment_id = ${est} order by issue_date desc, number desc limit 100`;
    const issuer = await getIssuer(sql);
    return {
      contract: c?.plan_name ? c : null, features: c?.features ?? [],
      invoices: invoices.map(shape),
      payTo: { name: issuer.name || DEFAULT_ISSUER.name, iban: issuer.iban, email: issuer.email, phone: issuer.phone },
    };
  });

  // ---------- Incidencias ----------
  const ticketBody = z.object({
    title: z.string().trim().min(3, 'Escribe un título').max(120),
    body: z.string().trim().min(3, 'Describe la incidencia').max(4000),
    category: z.enum(['bug', 'question', 'hardware', 'billing', 'request', 'other']).default('other'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  });

  app.get('/api/support/tickets', async (req) => {
    const { est } = requireClientAdmin(req);
    return sql`select id, number, title, category, priority, status, created_at, updated_at, unread_client from support_tickets where establishment_id = ${est} order by updated_at desc limit 200`;
  });

  app.post('/api/support/tickets', async (req) => {
    const { a, est } = requireClientAdmin(req);
    const b = parse(ticketBody, req.body);
    return sql.begin(async (tx) => {
      const [t] = await tx`insert into support_tickets (establishment_id, title, category, priority, created_by) values (${est}, ${b.title}, ${b.category}, ${b.priority}, ${a.name}) returning *`;
      await tx`insert into support_messages (ticket_id, author_kind, author_name, body) values (${t.id}, 'client', ${a.name}, ${b.body})`;
      await audit(tx, est, actorLabel(a), 'ticket.open', { id: t.id });
      return t;
    });
  });

  const loadTicket = async (id: string): Promise<Record<string, any>> => {
    const [t] = await sql`select t.*, e.name as establishment from support_tickets t join establishments e on e.id = t.establishment_id where t.id = ${id}`;
    if (!t) throw notFound('Incidencia');
    const messages = await sql`select id, author_kind, author_name, body, created_at from support_messages where ticket_id = ${id} order by created_at, id`;
    return { ...t, messages };
  };

  app.get('/api/support/tickets/:id', async (req) => {
    const { est } = requireClientAdmin(req);
    const { id } = parse(uuid, req.params);
    const t = await loadTicket(id);
    if (t.establishment_id !== est) throw notFound('Incidencia');
    await sql`update support_tickets set unread_client = false where id = ${id}`;
    return t;
  });

  app.post('/api/support/tickets/:id/messages', async (req) => {
    const { a, est } = requireClientAdmin(req);
    const { id } = parse(uuid, req.params);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
    const [t] = await sql`select establishment_id, status from support_tickets where id = ${id}`;
    if (!t || t.establishment_id !== est) throw notFound('Incidencia');
    await sql.begin(async (tx) => {
      await tx`insert into support_messages (ticket_id, author_kind, author_name, body) values (${id}, 'client', ${a.name}, ${body})`;
      // Si el cliente escribe en una incidencia resuelta, se reabre.
      await tx`update support_tickets set updated_at = now(), unread_gestor = true, status = case when status in ('resolved', 'waiting') then 'open' else status end, resolved_at = null where id = ${id}`;
    });
    return loadTicket(id);
  });

  app.get('/api/platform/tickets', async (req) => {
    requireSuper(req);
    const { status } = parse(z.object({ status: z.enum(['open', 'in_progress', 'waiting', 'resolved', 'active']).default('active') }), req.query);
    return sql`select t.id, t.number, t.title, t.category, t.priority, t.status, t.created_at, t.updated_at, t.unread_gestor, t.created_by, e.name as establishment
               from support_tickets t join establishments e on e.id = t.establishment_id
               where (${status} = 'active' and t.status <> 'resolved') or t.status = ${status}
               order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.updated_at desc limit 300`;
  });

  app.get('/api/platform/tickets/:id', async (req) => {
    requireSuper(req);
    const { id } = parse(uuid, req.params);
    const t = await loadTicket(id);
    await sql`update support_tickets set unread_gestor = false where id = ${id}`;
    return t;
  });

  app.post('/api/platform/tickets/:id/messages', async (req) => {
    const a = requireSuper(req);
    const { id } = parse(uuid, req.params);
    const b = parse(z.object({ body: z.string().trim().min(1).max(4000), status: z.enum(['open', 'in_progress', 'waiting', 'resolved']).optional() }), req.body);
    const [t] = await sql`select 1 from support_tickets where id = ${id}`;
    if (!t) throw notFound('Incidencia');
    await sql.begin(async (tx) => {
      await tx`insert into support_messages (ticket_id, author_kind, author_name, body) values (${id}, 'gestor', 'Soporte Loryand', ${b.body})`;
      const st = b.status ?? 'waiting';
      await tx`update support_tickets set updated_at = now(), unread_client = true, status = ${st}, resolved_at = ${st === 'resolved' ? new Date() : null} where id = ${id}`;
      await audit(tx, null, actorLabel(a), 'ticket.reply', { id, status: st });
    });
    return loadTicket(id);
  });

  app.patch('/api/platform/tickets/:id', async (req) => {
    requireSuper(req);
    const { id } = parse(uuid, req.params);
    const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'waiting', 'resolved']), priority: z.enum(['low', 'normal', 'high', 'urgent']) }).partial(), req.body);
    const [t] = await sql`select status, priority from support_tickets where id = ${id}`;
    if (!t) throw notFound('Incidencia');
    const status = b.status ?? t.status;
    await sql`update support_tickets set status = ${status}, priority = ${b.priority ?? t.priority}, updated_at = now(),
              resolved_at = case when ${status} = 'resolved' then coalesce(resolved_at, now()) else null end where id = ${id}`;
    return loadTicket(id);
  });

  /** Resumen para la portada del gestor. */
  app.get('/api/platform/summary', async (req) => {
    requireSuper(req);
    const [s] = await sql`
      select (select coalesce(sum(round(monthly_cents * (1 + vat_rate / 100))), 0)::int from contracts c join establishments e on e.id = c.establishment_id where c.status = 'active' and e.active) as monthly_total_cents,
             (select count(*)::int from contracts where status = 'active') as active_contracts,
             (select coalesce(sum(total_cents), 0)::int from platform_invoices where status = 'issued') as pending_cents,
             (select count(*)::int from platform_invoices where status = 'issued' and kind = 'invoice' and due_date < current_date) as overdue,
             (select count(*)::int from support_tickets where status <> 'resolved') as open_tickets,
             (select count(*)::int from support_tickets where unread_gestor and status <> 'resolved') as unread_tickets`;
    return s;
  });
}
