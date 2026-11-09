import type { Tx } from '../db.js';
import { accountSummary } from './accounts.js';

export type DocType = 'proforma' | 'simplified' | 'full';
const PREFIX: Record<DocType, string> = { proforma: 'P', simplified: 'T', full: 'F' };

/** Desglose de IVA: los precios de la carta incluyen IVA. */
export function vatBreakdown(lines: Array<{ unitCents: number; qty: number; vatRate: number }>, discountCents = 0) {
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.unitCents * l.qty);
  const gross = [...byRate.values()].reduce((a, b) => a + b, 0);
  if (discountCents > 0 && gross > 0) {
    // El descuento se reparte entre los tipos de IVA en proporción a su importe; el redondeo va al mayor.
    const target = Math.max(0, gross - discountCents);
    const entries = [...byRate.entries()].sort((a, b) => b[1] - a[1]);
    let assigned = 0;
    entries.forEach(([rate, total], i) => {
      const v = i === entries.length - 1 ? target - assigned : Math.round((total * target) / gross);
      assigned += v;
      byRate.set(rate, v);
    });
    const largest = entries[0][0];
    byRate.set(largest, byRate.get(largest)! + (target - [...byRate.values()].reduce((a, b) => a + b, 0)));
  }
  return [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, total]) => {
    const base = Math.round(total / (1 + rate / 100));
    return { rate, baseCents: base, vatCents: total - base, totalCents: total };
  });
}

export type DocScope =
  | { kind: 'all' }                                                    // proforma: toda la cuenta
  | { kind: 'remaining' }                                              // ticket final: lo no pagado por productos
  | { kind: 'split'; paymentId: string; items: Array<{ itemId: string; qty: number }>; amountCents: number };

async function nextNumber(tx: Tx, establishmentId: string, type: DocType) {
  const series = `${PREFIX[type]}${new Date().getFullYear()}`;
  const [{ next }] = await tx`select coalesce(max(number), 0) + 1 as next from documents where establishment_id = ${establishmentId} and series = ${series}`;
  return { series, number: next as number };
}

/** Emite un documento con numeración correlativa por serie y año. Llamar dentro de una transacción
 *  que ya tenga bloqueada la fila del establecimiento. Devuelve null si no queda nada que facturar. */
export async function issueDocument(tx: Tx, establishmentId: string, accountId: string, type: DocType, customer?: Record<string, string>, scope: DocScope = { kind: type === 'proforma' ? 'all' : 'remaining' }) {
  const summary = await accountSummary(tx, accountId, establishmentId);
  const [est] = await tx`select name, legal_name, tax_id, address, postal_code, city, province, phone from establishments where id = ${establishmentId}`;
  const live = summary.items.filter((i) => i.status !== 'cancelled');
  const lineOf = (i: (typeof live)[number], qty: number) => ({ name: i.option ? `${i.name} (${i.option})` : i.name, qty, unitCents: i.unitCents, vatRate: i.vatRate });
  let lines: ReturnType<typeof lineOf>[];
  let total: number;
  let payments = summary.payments;
  if (scope.kind === 'all') {
    lines = live.map((i) => lineOf(i, i.qty));
    total = summary.totalCents;
  } else if (scope.kind === 'split') {
    lines = scope.items.map((s) => lineOf(live.find((i) => i.id === s.itemId)!, s.qty));
    total = scope.amountCents;
    payments = summary.payments.filter((p) => p.id === scope.paymentId);
  } else {
    const paidHeads = new Set(live.filter((i) => i.destination === 'none' && i.paidQty >= i.qty).map((i) => i.id));
    lines = live.filter((i) => i.qty - i.paidQty > 0 && !(i.parentItemId && paidHeads.has(i.parentItemId))).map((i) => lineOf(i, i.qty - i.paidQty));
    const [{ split }] = await tx`select coalesce(sum(pi.amount_cents), 0)::int as split from payment_items pi join payments p on p.id = pi.payment_id where p.account_id = ${accountId}`;
    total = summary.totalCents - split;
    const splitPayments = new Set((await tx`select distinct payment_id from payment_items pi join payments p on p.id = pi.payment_id where p.account_id = ${accountId}`).map((r) => r.payment_id));
    payments = summary.payments.filter((p) => !splitPayments.has(p.id));
    if (!lines.length || total <= 0) return null;
  }
  const gross = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  const { series, number } = await nextNumber(tx, establishmentId, type);
  const payload = {
    issuer: est,
    customer: customer ?? null,
    loyaltyCustomer: summary.customer?.name ?? null,
    place: summary.tableLabel ? `Mesa ${summary.tableLabel}` : `Barra · ${summary.barName}`,
    waiter: summary.waiterName,
    lines,
    // Se conservan los nombres de los descuentos (p. ej. el cupón) salvo en tickets de una cuenta dividida por productos,
    // donde a cada ticket le corresponde su parte proporcional.
    discounts: gross - total <= 0 ? []
      : gross - total === summary.discountCents ? summary.discounts.map((d) => ({ label: d.label, amountCents: d.amountCents }))
      : [{ label: `Parte proporcional del descuento (${summary.discounts.map((d) => d.label).join(', ')})`, amountCents: gross - total }],
    vat: vatBreakdown(lines, gross - total),
    payments,
    partial: scope.kind === 'split' ? true : undefined,
  };
  const [doc] = await tx`
    insert into documents (establishment_id, account_id, type, series, number, total_cents, payload, payment_id)
    values (${establishmentId}, ${accountId}, ${type}, ${series}, ${number}, ${total}, ${tx.json(payload as never)}, ${scope.kind === 'split' ? scope.paymentId : null})
    returning id, series, number, total_cents, created_at`;
  return doc;
}

/**
 * Convierte una factura simplificada (ticket) en factura completa con los datos fiscales del cliente.
 * Regla del programa: la conversión debe hacerse dentro del mismo trimestre natural y año de la operación.
 * El ticket queda marcado como sustituido para no duplicar importes en los resúmenes.
 */
export async function convertToFull(tx: Tx, establishmentId: string, documentId: string, customer: Record<string, string>) {
  const [d] = await tx`
    select id, type, status, account_id, created_at,
           (extract(year from created_at at time zone 'Europe/Madrid') = extract(year from now() at time zone 'Europe/Madrid')
            and extract(quarter from created_at at time zone 'Europe/Madrid') = extract(quarter from now() at time zone 'Europe/Madrid')) as same_quarter
    from documents where id = ${documentId} and establishment_id = ${establishmentId} for update`;
  if (!d) return { error: 'not_found' as const };
  if (d.type !== 'simplified') return { error: 'not_simplified' as const };
  if (d.status !== 'valid') return { error: 'already_replaced' as const };
  if (!d.same_quarter) return { error: 'other_quarter' as const };
  // La factura completa reproduce exactamente el ticket (sus líneas e importes) con los datos del cliente.
  const [src] = await tx`select payload, total_cents, account_id, payment_id from documents where id = ${d.id}`;
  const { series, number } = await nextNumber(tx, establishmentId, 'full');
  const [full] = await tx`
    insert into documents (establishment_id, account_id, type, series, number, total_cents, payload, payment_id, replaces_id)
    values (${establishmentId}, ${src.account_id}, 'full', ${series}, ${number}, ${src.total_cents}, ${tx.json({ ...src.payload, customer } as never)}, ${src.payment_id}, ${d.id})
    returning id, series, number, total_cents, created_at`;
  await tx`update documents set status = 'replaced' where id = ${d.id}`;
  return { document: full };
}
