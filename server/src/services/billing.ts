import { sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

type Q = typeof sql | Tx;
const TZ = 'Europe/Madrid';

/** Datos de Loryand como emisor de las facturas. */
export interface Issuer {
  name: string; taxId: string; address: string; postalCode: string; city: string; province: string;
  email: string; phone: string; iban: string; bic: string;
  /** Identificador de acreedor SEPA (si se deja vacío se calcula con el NIF y el sufijo 000). */
  creditorId: string;
  series: string; rectifyingSeries: string; paymentDays: number; footer: string;
}
export const DEFAULT_ISSUER: Issuer = {
  name: '', taxId: '', address: '', postalCode: '', city: '', province: '', email: '', phone: '', iban: '', bic: '', creditorId: '',
  series: 'LR', rectifyingSeries: 'LRR', paymentDays: 15, footer: '',
};

export async function getIssuer(q: Q): Promise<Issuer> {
  const [r] = await q`select data from platform_settings where id`;
  return { ...DEFAULT_ISSUER, ...(r?.data ?? {}) };
}

export interface Line { description: string; qty: number; unitCents: number; vatRate: number }
export interface Customer { name: string; taxId: string; address: string; email: string; establishment: string }

export function totals(lines: Line[]) {
  const base = lines.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0);
  // IVA por tipo, redondeado una vez por tipo (como se desglosa en la factura).
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + Math.round(l.qty * l.unitCents));
  const vat = [...byRate].reduce((s, [rate, b]) => s + Math.round((b * rate) / 100), 0);
  return { base, vat, total: base + vat, byRate: [...byRate].map(([rate, b]) => ({ rate, baseCents: b, vatCents: Math.round((b * rate) / 100) })) };
}

/** Datos fiscales del cliente: los del contrato si están, si no los del establecimiento. */
export async function customerOf(q: Q, establishmentId: string): Promise<Customer> {
  const [e] = await q`
    select e.name, e.legal_name, e.tax_id, e.address, e.postal_code, e.city, e.province, e.email,
           c.billing_name, c.billing_tax_id, c.billing_address, c.billing_email
    from establishments e left join contracts c on c.establishment_id = e.id where e.id = ${establishmentId}`;
  if (!e) throw notFound('Establecimiento');
  const addr = [e.address, [e.postal_code, e.city].filter(Boolean).join(' '), e.province].map((x: string) => x?.trim()).filter(Boolean).join(', ');
  return {
    establishment: e.name,
    name: e.billing_name?.trim() || e.legal_name?.trim() || e.name,
    taxId: e.billing_tax_id?.trim() || e.tax_id?.trim() || '',
    address: e.billing_address?.trim() || addr,
    email: e.billing_email?.trim() || e.email?.trim() || '',
  };
}

const today = async (q: Q): Promise<string> => (await q`select to_char(now() at time zone ${TZ}, 'YYYY-MM-DD') as d`)[0].d;

/**
 * Emite una factura con el siguiente número de su serie y año. El bloqueo de la fila de ajustes
 * garantiza números correlativos sin huecos aunque se emitan dos a la vez.
 */
export async function issueInvoice(tx: Tx, o: {
  establishmentId: string; lines: Line[]; actor: string; issueDate?: string; period?: string | null;
  kind?: 'invoice' | 'rectifying'; rectifiesId?: string; reason?: string; customer?: Customer; maxTables?: number | null;
}) {
  if (!o.lines.length) throw badRequest('La factura necesita al menos una línea');
  await tx`select id from platform_settings where id for update`;
  const issuer = await getIssuer(tx);
  if (!issuer.name.trim() || !issuer.taxId.trim() || !issuer.address.trim()) {
    throw conflict('issuer_incomplete', 'Completa primero los datos de Loryand como emisor (nombre, NIF y dirección)');
  }
  // La rectificativa usa los datos del cliente tal como figuraban en la factura original.
  const customer = o.customer ?? await customerOf(tx, o.establishmentId);
  if (!customer.taxId) throw conflict('customer_incomplete', `Faltan el NIF/CIF de «${customer.establishment}» para facturarle`);
  const kind = o.kind ?? 'invoice';
  const series = kind === 'rectifying' ? issuer.rectifyingSeries : issuer.series;
  const issueDate = o.issueDate ?? (await today(tx));
  const year = Number(issueDate.slice(0, 4));
  // No se puede emitir con fecha anterior a la última factura de la serie (orden correlativo).
  const [last] = await tx`select max(issue_date)::text as d, coalesce(max(number), 0)::int as n from platform_invoices where series = ${series} and year = ${year}`;
  if (last.d && issueDate < last.d) throw conflict('date_order', `La fecha no puede ser anterior a la última factura de la serie (${last.d})`);
  const t = totals(o.lines);
  const [due] = await tx`select (${issueDate}::date + ${issuer.paymentDays}::int)::text as d`;
  const [inv] = await tx`
    insert into platform_invoices (establishment_id, kind, series, year, number, issue_date, due_date, period, rectifies_id, reason,
                                   issuer, customer, lines, base_cents, vat_cents, total_cents, created_by, max_tables)
    values (${o.establishmentId}, ${kind}, ${series}, ${year}, ${last.n + 1}, ${issueDate}, ${due.d}, ${o.period ?? null}, ${o.rectifiesId ?? null}, ${o.reason ?? null},
            ${tx.json(issuer as never)}, ${tx.json(customer as never)}, ${tx.json(o.lines as never)}, ${t.base}, ${t.vat}, ${t.total}, ${o.actor}, ${o.maxTables ?? null})
    returning *`;
  return inv;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const periodLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} de ${p.slice(0, 4)}`;

/** Máximo de mesas activas de un local en un mes (si el mes está en curso, cuenta también las de ahora). */
export async function maxTables(q: Q, establishmentId: string, period: string): Promise<number> {
  const [r] = await q`
    select greatest(
      coalesce((select max(active_tables) from table_usage where establishment_id = ${establishmentId}
                and day between ${period + '-01'}::date and (${period + '-01'}::date + interval '1 month - 1 day')::date), 0),
      case when to_char(now() at time zone ${TZ}, 'YYYY-MM') = ${period}
           then (select count(*)::int from tables where establishment_id = ${establishmentId} and active) else 0 end) as n`;
  return Number(r.n);
}

/** Cuotas del mes para todos los contratos activos con cuota. Repetible: no duplica las ya emitidas. */
export async function generateMonthly(period: string, actor: string, issueDate?: string) {
  const created: string[] = [];
  const skipped: { establishment: string; reason: string }[] = [];
  const rows = await sql`
    select c.*, e.name from contracts c join establishments e on e.id = c.establishment_id
    where c.status = 'active' and (c.monthly_cents > 0 or c.price_per_table_cents > 0) and e.active
      and c.start_date <= (${period + '-01'}::date + interval '1 month - 1 day')
      and not exists (select 1 from platform_invoices i where i.establishment_id = c.establishment_id and i.period = ${period} and i.kind = 'invoice')
    order by e.name`;
  for (const c of rows) {
    try {
      const tables = c.price_per_table_cents > 0 ? await maxTables(sql, c.establishment_id, period) : 0;
      const vatRate = Number(c.vat_rate);
      const lines: Line[] = [];
      if (c.monthly_cents > 0) lines.push({ description: `${c.plan_name} · cuota de ${periodLabel(period)}`, qty: 1, unitCents: c.monthly_cents, vatRate });
      if (c.price_per_table_cents > 0 && tables > 0) {
        lines.push({ description: `${c.monthly_cents > 0 ? 'Mesas' : c.plan_name + ' · mesas'} activas en ${periodLabel(period)} (máximo del mes)`, qty: tables, unitCents: c.price_per_table_cents, vatRate });
      }
      if (!lines.length) { skipped.push({ establishment: c.name, reason: 'Sin mesas activas ese mes' }); continue; }
      const inv = await sql.begin((tx) => issueInvoice(tx, { establishmentId: c.establishment_id, actor, period, issueDate, lines, maxTables: c.price_per_table_cents > 0 ? tables : null }));
      created.push(inv.id);
    } catch (e) {
      const msg = (e as Error).message;
      // Si faltan los datos del emisor no tiene sentido seguir con los demás.
      if ((e as { code?: string }).code === 'issuer_incomplete') throw e;
      skipped.push({ establishment: c.name, reason: msg });
    }
  }
  return { created: created.length, skipped };
}

export const invoiceNumber = (i: { series: string; year: number; number: number }) => `${i.series}-${i.year}-${String(i.number).padStart(4, '0')}`;
