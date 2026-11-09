import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sql } from '../db.js';
import { type Actor, actorLabel, can, establishmentOf, requireActor, requireService } from '../auth.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { accountSummary, mergeAccounts } from '../services/accounts.js';
import { createOrder, fireNextCourse, orderInput, setItemsStatus } from '../services/orders.js';
import { paymentInput, registerPayment } from '../services/payments.js';
import { convertToFull, issueDocument } from '../services/documents.js';
import { setPhysicalState } from '../services/tables.js';
import { endShift, startShift } from '../services/timesheet.js';
import { autoOpenDrawer, autoPrintTicket, printFire, printOrder } from '../services/printing.js';

const id = z.object({ id: z.string().uuid() });
const who = (a: Actor) => ({ waiterId: a.kind === 'waiter' ? a.id : null, userId: a.kind === 'user' ? a.id : null });

async function tableTokenOfAccount(accountId: string): Promise<string | undefined> {
  const [r] = await sql`select t.qr_token from accounts a join tables t on t.id = a.table_id where a.id = ${accountId}`;
  return r?.qr_token;
}

/** El camarero debe haber fichado la entrada para operar (capítulo 12 del manual). */
async function requireOnShift(a: Actor) {
  if (a.kind !== 'waiter') return;
  const [w] = await sql`select staff_role from waiters where id = ${a.id}`;
  if (w?.staff_role !== 'sala') throw forbidden('Tu usuario es solo para fichar. Las comandas y los cobros los hace el personal de sala.');
  const [s] = await sql`select 1 from shifts where waiter_id = ${a.id} and ended_at is null and status = 'valid'`;
  if (!s) throw new AppError(409, 'not_on_shift', 'Ficha la entrada para empezar a trabajar');
}

/** En modo exclusivo, el camarero solo opera en sus mesas asignadas. */
async function checkTableAccess(a: Actor, est: string, tableId: string | null) {
  if (a.kind !== 'waiter' || !tableId) return;
  const [{ settings }] = await sql`select settings from establishments where id = ${est}`;
  if (settings.sharedTables) return;
  const [ok] = await sql`select 1 from waiter_tables where waiter_id = ${a.id} and table_id = ${tableId}`;
  if (!ok) throw forbidden('Esta mesa no está asignada a ti');
}

function itemsActor(req: FastifyRequest, status: string): Actor {
  const a = requireActor(req);
  const kitchenSide = ['preparing', 'ready'].includes(status);
  if (kitchenSide && (can(a, 'kitchen') || can(a, 'bar'))) return a;
  if (!kitchenSide && (a.kind === 'waiter' || can(a, 'tpv'))) return a;
  if (status === 'new' && (can(a, 'kitchen') || can(a, 'bar'))) return a;
  throw forbidden();
}

export default async function serviceRoutes(app: FastifyInstance) {
  /** Plano de servicio: mesas con su estado físico y económico combinados. */
  app.get('/api/service/floor', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const [{ settings }] = await sql`select settings from establishments where id = ${est}`;
    const onlyMine = a.kind === 'waiter' && !settings.sharedTables;
    const tables = await sql`
      select t.id, t.label, t.zone, t.seats, t.physical_state, t.access_open, t.pos_x, t.pos_y, t.shape, t.join_group,
             a.id as account_id, a.opened_at,
             (coalesce(x.total, 0) - coalesce((select sum(d.amount_cents) from account_discounts d where d.account_id = a.id), 0))::int as total_cents, coalesce(p.paid, 0)::int as paid_cents,
             coalesce(x.undelivered, 0)::int as undelivered, coalesce(x.ready, 0)::int as ready, coalesce(x.held, 0)::int as held,
             coalesce(r.kinds, '{}') as requests
      from tables t
      left join accounts a on a.table_id = t.id and a.status = 'open'
      left join lateral (
        select sum(i.unit_cents * i.qty) filter (where i.status <> 'cancelled') as total,
               count(*) filter (where i.destination <> 'none' and i.status not in ('delivered','cancelled')) as undelivered,
               count(*) filter (where i.status = 'ready') as ready,
               count(*) filter (where i.status = 'held') as held
        from orders o join order_items i on i.order_id = o.id where o.account_id = a.id) x on true
      left join lateral (select sum(amount_cents) as paid from payments where account_id = a.id) p on true
      left join lateral (select array_agg(kind) as kinds from service_requests sr where sr.table_id = t.id and sr.status = 'open') r on true
      where t.establishment_id = ${est} and t.active
        and (${!onlyMine} or exists (select 1 from waiter_tables wt where wt.table_id = t.id and wt.waiter_id = ${a.id}))
      order by t.zone, length(t.label), t.label`;
    const bar = await sql`
      select a.id as account_id, a.bar_name, a.opened_at, w.name as waiter_name,
             coalesce((select sum(i.unit_cents * i.qty) from orders o join order_items i on i.order_id = o.id
                       where o.account_id = a.id and i.status <> 'cancelled'), 0)::int - coalesce((select sum(d.amount_cents) from account_discounts d where d.account_id = a.id), 0)::int as total_cents,
             coalesce((select sum(amount_cents) from payments where account_id = a.id), 0)::int as paid_cents
      from accounts a left join waiters w on w.id = a.waiter_id
      where a.establishment_id = ${est} and a.status = 'open' and a.bar_name is not null
      order by a.opened_at`;
    return { sharedTables: settings.sharedTables, tables, bar };
  });

  /** Carta para TPV y PDA: incluye productos ocultos al cliente, marcados como tales. */
  app.get('/api/service/menu', async (req) => {
    requireService(req);
    const est = establishmentOf(req);
    const categories = await sql`select id, parent_id, name, sort from categories where establishment_id = ${est} order by sort, name`;
    const products = await sql`
      select id, name, description, price_cents, destination, course, visible, options, allergens, category_id, subcategory_id, photo_url
      from products where establishment_id = ${est} and not archived order by name`;
    const best = await sql`
      select i.product_id, sum(i.qty)::int as n from order_items i join orders o on o.id = i.order_id
      where o.establishment_id = ${est} and o.created_at > now() - interval '30 days' and i.status <> 'cancelled'
      group by i.product_id order by n desc limit 12`;
    const [dailyMenu] = await sql`select name, price_cents, sections from daily_menus where establishment_id = ${est} and active`;
    return { categories, products, bestSellers: best.map((b) => b.product_id), dailyMenu: dailyMenu ?? null };
  });

  app.get('/api/service/waiters', async (req) => {
    requireService(req);
    // Por defecto, solo personal de sala (para asociar cuentas); con ?todos=1, todo el personal (acceso para fichar).
    const all = (req.query as { todos?: string }).todos === '1';
    return sql`select id, code, name, staff_role from waiters where establishment_id = ${establishmentOf(req)} and active
               and (${all} or staff_role = 'sala') order by name`;
  });

  /** "Acceso camareros" en el TPV: QR de un solo uso (2 minutos) para que el camarero entre en su teléfono con su PIN. */
  app.post('/api/service/waiter-access', async (req) => {
    const a = requireService(req);
    if (a.kind === 'waiter') throw forbidden('El acceso de camareros se genera desde el TPV');
    const est = establishmentOf(req);
    const { waiterId } = parse(z.object({ waiterId: z.string().uuid() }), req.body);
    const [w] = await sql`select id, name from waiters where id = ${waiterId} and establishment_id = ${est} and active`;
    if (!w) throw notFound('Camarero');
    const token = randomBytes(24).toString('base64url');
    const [t] = await sql`insert into waiter_access_tokens (token_hash, waiter_id, created_by, expires_at)
                          values (${createHash('sha256').update(token).digest('hex')}, ${w.id}, ${actorLabel(a)}, now() + interval '2 minutes')
                          returning expires_at`;
    // Limpieza de códigos antiguos.
    await sql`delete from waiter_access_tokens where created_at < now() - interval '1 day'`;
    return { token, path: `/personal?acceso=${token}`, waiter: w.name, expiresAt: t.expires_at };
  });

  // ---------- Fichaje ----------
  app.post('/api/service/shift/start', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'waiter') throw forbidden('Solo los camareros fichan');
    await startShift(a.id);
    notify(a.establishmentId, ['waiters']);
    return { ok: true };
  });

  app.post('/api/service/shift/end', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'waiter') throw forbidden('Solo los camareros fichan');
    await endShift(a.id);
    notify(a.establishmentId, ['waiters']);
    return { ok: true };
  });

  // ---------- Pedidos ----------
  app.post('/api/service/orders', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    await requireOnShift(a);
    const input = parse(orderInput, req.body);
    if ('tableId' in input.target) await checkTableAccess(a, est, input.target.tableId);
    if ('accountId' in input.target) {
      const [acc] = await sql`select table_id from accounts where id = ${input.target.accountId}`;
      await checkTableAccess(a, est, acc?.table_id ?? null);
    }
    let waiterId = a.kind === 'waiter' ? a.id : null;
    // Desde el TPV, la cuenta de barra indica el camarero asociado.
    const bodyWaiter = (req.body as { waiterId?: string })?.waiterId;
    if (a.kind === 'user' && bodyWaiter) {
      const [w] = await sql`select id from waiters where id = ${bodyWaiter} and establishment_id = ${est} and active`;
      if (!w) throw notFound('Camarero');
      waiterId = w.id;
    }
    const r = await createOrder(input, { establishmentId: est, source: a.kind === 'waiter' ? 'pda' : 'tpv', waiterId, userId: a.kind === 'user' ? a.id : null });
    if (!r.duplicate) {
      notify(est, ['orders', 'tables'], await tableTokenOfAccount(r.accountId));
      // La impresión nunca debe impedir registrar la comanda.
      await printOrder(est, r.orderId).catch((err) => req.log.error({ err }, 'Error al preparar la comanda impresa'));
    }
    return r;
  });

  app.get('/api/service/accounts/:id', async (req) => {
    requireService(req);
    const { id: aid } = parse(id, req.params);
    return accountSummary(sql, aid, establishmentOf(req));
  });

  app.post('/api/service/accounts/:id/payments', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    await requireOnShift(a);
    const { id: aid } = parse(id, req.params);
    const [acc] = await sql`select table_id from accounts where id = ${aid} and establishment_id = ${est}`;
    if (!acc) throw notFound('Cuenta');
    await checkTableAccess(a, est, acc.table_id);
    const r = await registerPayment(est, aid, parse(paymentInput, req.body), who(a));
    if (!r.duplicate) {
      notify(est, ['payments', 'tables', 'requests'], await tableTokenOfAccount(aid));
      for (const d of r.documentIds ?? (r.documentId ? [r.documentId] : [])) await autoPrintTicket(est, d).catch((err) => req.log.error({ err }, 'Error al preparar el ticket impreso'));
      if ((req.body as { method?: string }).method === 'cash') await autoOpenDrawer(est).catch((err) => req.log.error({ err }, 'Error al abrir el cajón'));
    }
    return r;
  });

  /** "Marchar ahora": envía a cocina/barra el siguiente pase retenido. */
  app.post('/api/service/accounts/:id/fire', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: aid } = parse(id, req.params);
    const course = await fireNextCourse(est, aid);
    if (course == null) throw conflict('nothing_held', 'No hay pases pendientes de marchar');
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'course.fire', { accountId: aid, course }));
    await printFire(est, aid, course).catch((err) => req.log.error({ err }, 'Error al imprimir la marcha'));
    notify(est, ['orders', 'tables']);
    return { course };
  });

  /**
   * Cambiar de mesa: la cuenta entera (comandas, pases, cobros parciales) pasa a otra mesa libre.
   * También sirve para sentar en una mesa a un cliente que estaba en la barra.
   */
  app.post('/api/service/accounts/:id/move', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: aid } = parse(id, req.params);
    const { tableId } = parse(z.object({ tableId: z.string().uuid() }), req.body);
    await checkTableAccess(a, est, tableId);
    const r = await sql.begin(async (tx) => {
      const [acc] = await tx`select id, status, table_id, bar_name from accounts where id = ${aid} and establishment_id = ${est} for update`;
      if (!acc) throw notFound('Cuenta');
      if (acc.status !== 'open') throw conflict('account_closed', 'Solo se puede cambiar de mesa una cuenta abierta');
      if (acc.table_id === tableId) throw conflict('same_table', 'La cuenta ya está en esa mesa');
      const [t] = await tx`select id, label, active from tables where id = ${tableId} and establishment_id = ${est} for update`;
      if (!t || !t.active) throw notFound('Mesa');
      const [busy] = await tx`select id from accounts where table_id = ${tableId} and status = 'open'
                              and exists (select 1 from orders o where o.account_id = accounts.id)`;
      if (busy) throw conflict('table_busy', `La mesa ${t.label} ya tiene una cuenta abierta. Si quieres juntarlas, usa «Unir cuentas».`);
      // Una cuenta vacía en la mesa de destino (sin comandas) se descarta.
      await tx`update accounts set status = 'cancelled', closed_at = now() where table_id = ${tableId} and status = 'open'`;
      await tx`update accounts set table_id = ${tableId}, bar_name = null where id = ${aid}`;
      await setPhysicalState(tx, tableId, 'occupied');
      if (acc.table_id) {
        const [src] = await tx`select physical_state from tables where id = ${acc.table_id}`;
        if (src && src.physical_state !== 'free') await setPhysicalState(tx, acc.table_id, 'dirty');
      }
      await audit(tx, est, actorLabel(a), 'account.move', { accountId: aid, from: acc.table_id ?? `barra:${acc.bar_name}`, to: tableId });
      return { label: t.label };
    });
    notify(est, ['orders', 'tables']);
    return { ok: true, table: r.label, account: await accountSummary(sql, aid, est) };
  });

  app.post('/api/service/accounts/merge', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const b = parse(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }), req.body);
    await sql.begin(async (tx) => {
      await mergeAccounts(tx, est, b.sourceId, b.targetId);
      await audit(tx, est, actorLabel(a), 'account.merge', b);
    });
    notify(est, ['orders', 'tables']);
    return accountSummary(sql, b.targetId, est);
  });

  /** Proforma: cuenta informativa. No acredita el cobro. */
  app.post('/api/service/accounts/:id/proforma', async (req) => {
    requireService(req);
    const est = establishmentOf(req);
    const { id: aid } = parse(id, req.params);
    return sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${est} for update`;
      const [acc] = await tx`select status from accounts where id = ${aid} and establishment_id = ${est}`;
      if (!acc) throw notFound('Cuenta');
      return issueDocument(tx, est, aid, 'proforma');
    });
  });

  app.get('/api/service/documents/:id', async (req) => {
    requireService(req);
    const { id: did } = parse(id, req.params);
    const [d] = await sql`select * from documents where id = ${did} and establishment_id = ${establishmentOf(req)}`;
    if (!d) throw notFound('Documento');
    return d;
  });

  /** Factura completa a partir de un ticket (capítulo 18). */
  app.post('/api/service/documents/:id/full', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: did } = parse(id, req.params);
    const customer = parse(z.object({
      name: z.string().min(2, 'indica el nombre o la razón social').max(160),
      taxId: z.string().regex(/^[A-Za-z0-9]{8,12}$/, 'NIF/CIF no válido'),
      address: z.string().min(3, 'indica la dirección').max(200),
      postalCode: z.string().max(10).default(''),
      city: z.string().max(80).default(''),
      email: z.string().max(120).default(''),
    }), req.body);
    const r = await sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${est} for update`;
      const out = await convertToFull(tx, est, did, { ...customer, taxId: customer.taxId.toUpperCase() });
      if ('error' in out) {
        const msg = {
          not_found: 'Documento no encontrado', not_simplified: 'Solo se puede convertir una factura simplificada (ticket)',
          already_replaced: 'Este ticket ya se convirtió en factura completa', other_quarter: 'La conversión solo se permite dentro del mismo trimestre de la operación',
        }[out.error!];
        throw conflict(out.error!, msg);
      }
      await audit(tx, est, actorLabel(a), 'document.full', { from: did, to: out.document.id });
      return out.document;
    });
    return r;
  });

  app.get('/api/service/accounts/:id/documents', async (req) => {
    requireService(req);
    const { id: aid } = parse(id, req.params);
    return sql`select id, type, series, number, total_cents, status, created_at from documents
               where account_id = ${aid} and establishment_id = ${establishmentOf(req)} order by created_at`;
  });

  // ---------- Estado de los productos ----------
  app.patch('/api/service/items', async (req) => {
    const b = parse(z.object({
      itemIds: z.array(z.string().uuid()).min(1).max(200),
      status: z.enum(['new', 'preparing', 'ready', 'received', 'delivered', 'cancelled']),
    }), req.body);
    const a = itemsActor(req, b.status);
    const est = establishmentOf(req);
    const touched = await setItemsStatus(est, b.itemIds, b.status);
    if (b.status === 'cancelled') await sql.begin((tx) => audit(tx, est, actorLabel(a), 'items.cancel', { itemIds: b.itemIds }));
    notify(est, ['orders', 'tables']);
    for (const t of touched) if (t.tableToken) notify(est, [], t.tableToken);
    return { ok: true };
  });

  // ---------- Estado físico de la mesa ----------
  app.post('/api/service/tables/:id/state', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: tid } = parse(id, req.params);
    const { state } = parse(z.object({ state: z.enum(['free', 'occupied', 'paid_occupied', 'dirty']) }), req.body);
    await checkTableAccess(a, est, tid);
    await sql.begin(async (tx) => {
      const [t] = await tx`select physical_state from tables where id = ${tid} and establishment_id = ${est} for update`;
      if (!t) throw notFound('Mesa');
      if (state === 'free' || state === 'dirty') {
        const [open] = await tx`
          select a.id from accounts a where a.table_id = ${tid} and a.status = 'open'
            and exists (select 1 from orders o join order_items i on i.order_id = o.id where o.account_id = a.id and i.status <> 'cancelled')`;
        if (open) throw conflict('pending_account', 'La mesa tiene una cuenta pendiente de cobro');
      }
      await setPhysicalState(tx, tid, state);
      await audit(tx, est, actorLabel(a), 'table.state', { tableId: tid, from: t.physical_state, to: state });
    });
    notify(est, ['tables']);
    return { ok: true };
  });

  /** Clave de acceso de la mesa para la carta del cliente. */
  app.post('/api/service/tables/:id/access', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: tid } = parse(id, req.params);
    const { action } = parse(z.object({ action: z.enum(['view', 'regenerate', 'close', 'open']) }), req.body);
    await checkTableAccess(a, est, tid);
    if (action === 'regenerate') await sql`update tables set access_code = lpad((floor(random()*10000))::int::text, 4, '0'), access_open = true where id = ${tid} and establishment_id = ${est}`;
    if (action === 'close') await sql`update tables set access_open = false where id = ${tid} and establishment_id = ${est}`;
    if (action === 'open') await sql`update tables set access_open = true where id = ${tid} and establishment_id = ${est}`;
    const [t] = await sql`select access_code, access_open from tables where id = ${tid} and establishment_id = ${est}`;
    if (!t) throw notFound('Mesa');
    return t;
  });

  // ---------- Avisos del cliente ----------
  app.get('/api/service/requests', async (req) => {
    requireService(req);
    return sql`
      select r.id, r.kind, r.note, r.created_at, t.id as table_id, t.label as table_label
      from service_requests r join tables t on t.id = r.table_id
      where r.establishment_id = ${establishmentOf(req)} and r.status = 'open' order by r.created_at`;
  });

  app.post('/api/service/requests/:id/attend', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id: rid } = parse(id, req.params);
    await sql`update service_requests set status = 'attended', attended_at = now(), attended_by = ${a.kind === 'waiter' ? a.id : null}
              where id = ${rid} and establishment_id = ${est} and status = 'open'`;
    notify(est, ['requests', 'tables']);
    return { ok: true };
  });

  // ---------- Pantallas de cocina y barra ----------
  app.get('/api/kds/:destination', async (req) => {
    const a = requireActor(req);
    const { destination } = parse(z.object({ destination: z.enum(['kitchen', 'bar']) }), req.params);
    if (!can(a, destination)) throw forbidden();
    const est = establishmentOf(req);
    return sql`
      select o.id as order_id, o.number, o.created_at, o.note, o.source,
             coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place, w.name as waiter_name,
             json_agg(json_build_object('id', i.id, 'name', i.name, 'option', i.option, 'qty', i.qty, 'status', i.status, 'course', i.course)
                      order by i.course, i.name) as items
      from orders o
      join accounts a on a.id = o.account_id
      left join tables t on t.id = a.table_id
      left join waiters w on w.id = o.waiter_id
      join order_items i on i.order_id = o.id
      where o.establishment_id = ${est} and i.destination = ${destination} and i.status in ('new','preparing','ready')
      group by o.id, t.label, a.bar_name, w.name
      order by o.created_at`;
  });
}
