import { sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

type Q = typeof sql | Tx;

export interface AccountSummary {
  id: string;
  establishmentId: string;
  tableId: string | null;
  tableLabel: string | null;
  barName: string | null;
  waiterId: string | null;
  waiterName: string | null;
  status: 'open' | 'paid' | 'cancelled';
  openedAt: string;
  closedAt: string | null;
  items: Array<{
    id: string; orderId: string; orderNumber: number; name: string; option: string | null;
    unitCents: number; vatRate: number; qty: number; destination: 'kitchen' | 'bar' | 'none'; course: number; status: string;
    parentItemId: string | null;
    createdAt: string;
  }>;
  payments: Array<{ id: string; method: string; amountCents: number; createdAt: string }>;
  discounts: Array<{ id: string; label: string; amountCents: number; couponId: string | null }>;
  customer: { id: string; name: string; points: number } | null;
  itemsTotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  pendingCents: number;
  undeliveredCount: number;
  heldCourses: number[];
}

export async function accountSummary(q: Q, accountId: string, establishmentId?: string): Promise<AccountSummary> {
  const [a] = await q`
    select a.*, t.label as table_label, w.name as waiter_name
    from accounts a
    left join tables t on t.id = a.table_id
    left join waiters w on w.id = a.waiter_id
    where a.id = ${accountId}`;
  if (!a || (establishmentId && a.establishment_id !== establishmentId)) throw notFound('Cuenta');
  const items = await q`
    select i.*, o.number as order_number, o.created_at as order_created_at
    from order_items i join orders o on o.id = i.order_id
    where o.account_id = ${accountId}
    order by o.number, coalesce(i.parent_item_id, i.id), i.parent_item_id nulls first, i.course, i.name`;
  const payments = await q`select id, method, amount_cents, created_at from payments where account_id = ${accountId} order by created_at`;
  const discounts = await q`select id, label, amount_cents, coupon_id from account_discounts where account_id = ${accountId} order by created_at`;
  const [customer] = a.customer_id ? await q`select id, name, points from customers where id = ${a.customer_id}` : [];
  const live = items.filter((i) => i.status !== 'cancelled');
  const itemsTotalCents = live.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const discountCents = discounts.reduce((s, d) => s + d.amount_cents, 0);
  // Un descuento reduce el total; nunca lo deja por debajo de cero.
  const totalCents = Math.max(0, itemsTotalCents - discountCents);
  const paidCents = payments.reduce((s, p) => s + p.amount_cents, 0);
  return {
    id: a.id,
    establishmentId: a.establishment_id,
    tableId: a.table_id,
    tableLabel: a.table_label,
    barName: a.bar_name,
    waiterId: a.waiter_id,
    waiterName: a.waiter_name,
    status: a.status,
    openedAt: a.opened_at,
    closedAt: a.closed_at,
    items: items.map((i) => ({
      id: i.id, orderId: i.order_id, orderNumber: i.order_number, name: i.name, option: i.option,
      unitCents: i.unit_cents, vatRate: Number(i.vat_rate), qty: i.qty, destination: i.destination,
      course: i.course, status: i.status, createdAt: i.order_created_at, parentItemId: i.parent_item_id,
    })),
    payments: payments.map((p) => ({ id: p.id, method: p.method, amountCents: p.amount_cents, createdAt: p.created_at })),
    discounts: discounts.map((d) => ({ id: d.id, label: d.label, amountCents: d.amount_cents, couponId: d.coupon_id })),
    customer: customer ? { id: customer.id, name: customer.name, points: customer.points } : null,
    itemsTotalCents,
    discountCents,
    totalCents,
    paidCents,
    pendingCents: totalCents - paidCents,
    undeliveredCount: live.filter((i) => i.destination !== 'none' && i.status !== 'delivered').length,
    heldCourses: [...new Set(live.filter((i) => i.status === 'held').map((i) => i.course as number))].sort(),
  };
}

/** Busca la cuenta abierta de la mesa o la crea. El índice único garantiza una sola cuenta abierta por mesa. */
export async function openTableAccount(tx: Tx, establishmentId: string, tableId: string, waiterId: string | null): Promise<string> {
  const [t] = await tx`select id, active from tables where id = ${tableId} and establishment_id = ${establishmentId}`;
  if (!t) throw notFound('Mesa');
  if (!t.active) throw conflict('table_inactive', 'La mesa no está activa');
  const [existing] = await tx`select id from accounts where table_id = ${tableId} and status = 'open' for update`;
  if (existing) return existing.id;
  const [created] = await tx`
    insert into accounts (establishment_id, table_id, waiter_id) values (${establishmentId}, ${tableId}, ${waiterId})
    returning id`;
  return created.id;
}

/** Cuenta de barra: identificada por nombre o número y siempre con un camarero asociado. */
export async function openBarAccount(tx: Tx, establishmentId: string, barName: string, waiterId: string | null): Promise<string> {
  const name = barName.trim();
  if (!name) throw badRequest('Escribe un nombre o número para identificar al cliente de barra');
  if (!waiterId) throw badRequest('La cuenta de barra necesita un camarero asociado');
  const [existing] = await tx`
    select id from accounts where establishment_id = ${establishmentId} and lower(bar_name) = lower(${name}) and status = 'open' for update`;
  if (existing) return existing.id;
  const [created] = await tx`
    insert into accounts (establishment_id, bar_name, waiter_id) values (${establishmentId}, ${name}, ${waiterId})
    returning id`;
  return created.id;
}

/** Traslada los consumos de la cuenta origen a la cuenta destino. La dirección importa: el origen se anula. */
export async function mergeAccounts(tx: Tx, establishmentId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw badRequest('Origen y destino son la misma cuenta');
  const rows = await tx`
    select id, status, table_id from accounts
    where id in (${sourceId}, ${targetId}) and establishment_id = ${establishmentId}
    order by id for update`;
  const src = rows.find((r) => r.id === sourceId);
  const dst = rows.find((r) => r.id === targetId);
  if (!src || !dst) throw notFound('Cuenta');
  if (src.status !== 'open' || dst.status !== 'open') throw conflict('account_closed', 'Solo se pueden unir cuentas abiertas');
  const [{ n }] = await tx`select count(*)::int as n from payments where account_id = ${sourceId}`;
  if (n > 0) throw conflict('source_has_payments', 'La cuenta de origen ya tiene cobros; no se puede unir');
  await tx`update orders set account_id = ${targetId} where account_id = ${sourceId}`;
  await tx`update accounts set status = 'cancelled', closed_at = now() where id = ${sourceId}`;
  // El estado físico de la mesa de origen no se toca: lo actualiza el personal (los clientes pueden seguir sentados).
}
