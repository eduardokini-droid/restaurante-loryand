import type { Tx } from '../db.js';
import { accountSummary } from './accounts.js';

export type DocType = 'proforma' | 'simplified' | 'full';
const PREFIX: Record<DocType, string> = { proforma: 'P', simplified: 'T', full: 'F' };

/** Desglose de IVA: los precios de la carta incluyen IVA. */
export function vatBreakdown(lines: Array<{ unitCents: number; qty: number; vatRate: number }>) {
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.unitCents * l.qty);
  return [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, total]) => {
    const base = Math.round(total / (1 + rate / 100));
    return { rate, baseCents: base, vatCents: total - base, totalCents: total };
  });
}

/** Emite un documento con numeración correlativa por serie y año. Llamar dentro de una transacción
 *  que ya tenga bloqueada la fila del establecimiento. */
export async function issueDocument(tx: Tx, establishmentId: string, accountId: string, type: DocType, customer?: Record<string, string>) {
  const summary = await accountSummary(tx, accountId, establishmentId);
  const [est] = await tx`select name, legal_name, tax_id, address, postal_code, city, province, phone from establishments where id = ${establishmentId}`;
  const series = `${PREFIX[type]}${new Date().getFullYear()}`;
  const [{ next }] = await tx`
    select coalesce(max(number), 0) + 1 as next from documents where establishment_id = ${establishmentId} and series = ${series}`;
  const lines = summary.items.filter((i) => i.status !== 'cancelled')
    .map((i) => ({ name: i.option ? `${i.name} (${i.option})` : i.name, qty: i.qty, unitCents: i.unitCents, vatRate: i.vatRate }));
  const payload = {
    issuer: est,
    customer: customer ?? null,
    place: summary.tableLabel ? `Mesa ${summary.tableLabel}` : `Barra · ${summary.barName}`,
    waiter: summary.waiterName,
    lines,
    vat: vatBreakdown(lines),
    payments: summary.payments,
  };
  const [doc] = await tx`
    insert into documents (establishment_id, account_id, type, series, number, total_cents, payload)
    values (${establishmentId}, ${accountId}, ${type}, ${series}, ${next}, ${summary.totalCents}, ${tx.json(payload as never)})
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
  const full = await issueDocument(tx, establishmentId, d.account_id, 'full', customer);
  await tx`update documents set replaces_id = ${d.id} where id = ${full.id}`;
  await tx`update documents set status = 'replaced' where id = ${d.id}`;
  return { document: full };
}
