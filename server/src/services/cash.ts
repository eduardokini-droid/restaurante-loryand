import { sql, type Tx } from '../db.js';
import { conflict } from '../errors.js';

type Q = typeof sql | Tx;

export interface CashSummary {
  openedAt: string; openingFloatCents: number;
  byMethod: Record<'cash' | 'card' | 'bizum', { count: number; cents: number }>;
  totalCents: number;
  movements: Array<{ kind: 'in' | 'out'; amountCents: number; reason: string; actor: string; createdAt: string }>;
  movementsInCents: number; movementsOutCents: number;
  expectedCashCents: number;
  documents: { simplified: number; full: number; first: string | null; last: string | null };
  vat: Array<{ rate: number; baseCents: number; vatCents: number; totalCents: number }>;
  discountsCents: number;
  cancelledItems: number;
  byWaiter: Array<{ name: string; count: number; cents: number }>;
  pendingAccounts: Array<{ place: string; pendingCents: number }>;
  onlineConflicts: number;
}

export async function currentSession(q: Q, est: string) {
  const [s] = await q`select * from cash_sessions where establishment_id = ${est} and status = 'open'`;
  return s ?? null;
}

/** Apertura con fondo de caja. Los cobros hechos con la caja cerrada desde el último cierre pasan a esta caja. */
export async function openSession(est: string, floatCents: number, actor: string) {
  return sql.begin(async (tx) => {
    await tx`select id from establishments where id = ${est} for update`;
    if (await currentSession(tx, est)) throw conflict('cash_open', 'La caja ya está abierta');
    const [last] = await tx`select closed_at from cash_sessions where establishment_id = ${est} and status = 'closed' order by closed_at desc limit 1`;
    const [s] = await tx`insert into cash_sessions (establishment_id, opened_by, opening_float_cents) values (${est}, ${actor}, ${floatCents}) returning *`;
    await tx`update payments set cash_session_id = ${s.id}
             where establishment_id = ${est} and cash_session_id is null
               and created_at > coalesce(${last?.closed_at ?? null}::timestamptz, date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid')`;
    return s;
  });
}

export async function addMovement(est: string, kind: 'in' | 'out', amountCents: number, reason: string, actor: string) {
  return sql.begin(async (tx) => {
    const s = await currentSession(tx, est);
    if (!s) throw conflict('cash_closed', 'Abre la caja antes de registrar entradas o salidas de efectivo');
    if (kind === 'out') {
      const sum = await summarize(tx, s);
      if (amountCents > sum.expectedCashCents) throw conflict('not_enough_cash', 'La salida supera el efectivo que debería haber en caja');
    }
    const [m] = await tx`insert into cash_movements (session_id, kind, amount_cents, reason, actor) values (${s.id}, ${kind}, ${amountCents}, ${reason}, ${actor}) returning *`;
    return m;
  });
}

/** Resumen de la caja: lo que debería haber en efectivo y el informe Z. */
export async function summarize(q: Q, s: Record<string, any>): Promise<CashSummary> {
  const to = s.closed_at ?? new Date();
  const methods = await q`select method, count(*)::int as count, coalesce(sum(amount_cents), 0)::int as cents from payments where cash_session_id = ${s.id} group by method`;
  const byMethod = { cash: { count: 0, cents: 0 }, card: { count: 0, cents: 0 }, bizum: { count: 0, cents: 0 } };
  for (const m of methods) byMethod[m.method as keyof typeof byMethod] = { count: m.count, cents: m.cents };
  const movements = await q`select kind, amount_cents, reason, actor, created_at from cash_movements where session_id = ${s.id} order by created_at`;
  const inC = movements.filter((m) => m.kind === 'in').reduce((a, m) => a + m.amount_cents, 0);
  const outC = movements.filter((m) => m.kind === 'out').reduce((a, m) => a + m.amount_cents, 0);
  // Documentos de las cuentas cobradas en esta caja (sin contar los tickets sustituidos por factura).
  const docs = await q`
    select d.type, d.series, d.number, d.payload->'vat' as vat from documents d
    where d.establishment_id = ${s.establishment_id} and d.status = 'valid' and d.type in ('simplified','full')
      and d.account_id in (select distinct account_id from payments where cash_session_id = ${s.id})
    order by d.series, d.number`;
  const vatMap = new Map<number, { baseCents: number; vatCents: number; totalCents: number }>();
  for (const d of docs) for (const v of d.vat ?? []) {
    const cur = vatMap.get(v.rate) ?? { baseCents: 0, vatCents: 0, totalCents: 0 };
    cur.baseCents += v.baseCents; cur.vatCents += v.vatCents; cur.totalCents += v.totalCents;
    vatMap.set(v.rate, cur);
  }
  const simplified = docs.filter((d) => d.type === 'simplified');
  const label = (d: Record<string, any>) => `${d.series}-${String(d.number).padStart(5, '0')}`;
  const [{ disc }] = await q`select coalesce(sum(ad.amount_cents), 0)::int as disc from account_discounts ad
                             where ad.account_id in (select distinct account_id from payments where cash_session_id = ${s.id})`;
  const [{ cancelled }] = await q`select count(*)::int as cancelled from audit_log where establishment_id = ${s.establishment_id}
                                  and action = 'items.cancel' and created_at between ${s.opened_at} and ${to}`;
  const byWaiter = await q`select coalesce(w.name, u.name, 'Cobro online') as name, count(*)::int as count, sum(p.amount_cents)::int as cents
                           from payments p left join waiters w on w.id = p.waiter_id left join users u on u.id = p.user_id
                           where p.cash_session_id = ${s.id} group by 1 order by 3 desc`;
  const pending = await q`
    select coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place,
      (coalesce((select sum(i.unit_cents*i.qty) from orders o join order_items i on i.order_id = o.id where o.account_id = a.id and i.status <> 'cancelled'), 0)
       - coalesce((select sum(amount_cents) from payments where account_id = a.id), 0)
       - coalesce((select sum(amount_cents) from account_discounts where account_id = a.id), 0))::int as pending
    from accounts a left join tables t on t.id = a.table_id where a.establishment_id = ${s.establishment_id} and a.status = 'open'`;
  const [{ conflicts }] = await q`select count(*)::int as conflicts from online_payments where establishment_id = ${s.establishment_id} and status = 'conflict'`;
  return {
    openedAt: s.opened_at, openingFloatCents: s.opening_float_cents,
    byMethod, totalCents: byMethod.cash.cents + byMethod.card.cents + byMethod.bizum.cents,
    movements: movements.map((m) => ({ kind: m.kind, amountCents: m.amount_cents, reason: m.reason, actor: m.actor, createdAt: m.created_at })),
    movementsInCents: inC, movementsOutCents: outC,
    expectedCashCents: s.opening_float_cents + byMethod.cash.cents + inC - outC,
    documents: { simplified: simplified.length, full: docs.length - simplified.length, first: simplified[0] ? label(simplified[0]) : null, last: simplified.length ? label(simplified[simplified.length - 1]) : null },
    vat: [...vatMap.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) => ({ rate, ...v })),
    discountsCents: disc, cancelledItems: cancelled,
    byWaiter: byWaiter.map((w) => ({ name: w.name, count: w.count, cents: w.cents })),
    pendingAccounts: pending.filter((p) => p.pending > 0).map((p) => ({ place: p.place, pendingCents: p.pending })),
    onlineConflicts: conflicts,
  };
}

/** Cierre Z: recuento del efectivo, descuadre e informe congelado con número correlativo. */
export async function closeSession(est: string, countedCashCents: number, detail: Record<string, number> | null, notes: string, actor: string) {
  return sql.begin(async (tx) => {
    await tx`select id from establishments where id = ${est} for update`;
    const s = await currentSession(tx, est);
    if (!s) throw conflict('cash_closed', 'No hay ninguna caja abierta');
    const closedAt = new Date();
    const summary = await summarize(tx, { ...s, closed_at: closedAt });
    const difference = countedCashCents - summary.expectedCashCents;
    const [{ next }] = await tx`select coalesce(max(number), 0) + 1 as next from cash_sessions where establishment_id = ${est}`;
    const report = { ...summary, number: next, closedAt, closedBy: actor, countedCashCents, differenceCents: difference, countedDetail: detail, notes };
    const [c] = await tx`
      update cash_sessions set status = 'closed', number = ${next}, closed_at = ${closedAt}, closed_by = ${actor},
        expected_cash_cents = ${summary.expectedCashCents}, counted_cash_cents = ${countedCashCents}, difference_cents = ${difference},
        counted_detail = ${detail ? tx.json(detail) : null}, notes = ${notes}, report = ${tx.json(report as never)}
      where id = ${s.id} returning *`;
    return c;
  });
}
