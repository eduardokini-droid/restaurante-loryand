import { sql, type Tx } from '../db.js';
import { documentTicket, drawerKick, kitchenTicket, zReport } from './escpos.js';

type Q = typeof sql | Tx;
export interface AutoPrint { kitchen: boolean; bar: boolean; ticket: boolean; drawer: boolean }
export const DEFAULT_AUTOPRINT: AutoPrint = { kitchen: true, bar: true, ticket: false, drawer: true };

async function autoPrintOf(q: Q, est: string): Promise<AutoPrint> {
  const [e] = await q`select settings from establishments where id = ${est}`;
  return { ...DEFAULT_AUTOPRINT, ...(e?.settings?.autoPrint ?? {}) };
}

export async function printersFor(q: Q, est: string, role: 'kitchen' | 'bar' | 'ticket') {
  return q`select id, name, width_chars from printers where establishment_id = ${est} and active and ${role} = any(roles) order by created_at`;
}

export async function enqueue(q: Q, est: string, printerId: string, kind: string, title: string, payload: Buffer) {
  const [j] = await q`insert into print_jobs (establishment_id, printer_id, kind, title, payload)
                      values (${est}, ${printerId}, ${kind}, ${title}, ${payload}) returning id`;
  return j.id as string;
}

/** Comandas de un pedido: una por puesto (cocina / barra), solo con lo que debe prepararse ya. */
export async function printOrder(est: string, orderId: string, opts: { force?: boolean; fire?: number } = {}): Promise<number> {
  const auto = await autoPrintOf(sql, est);
  const [o] = await sql`
    select o.number, o.created_at, o.note, coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place, w.name as waiter
    from orders o join accounts a on a.id = o.account_id left join tables t on t.id = a.table_id left join waiters w on w.id = o.waiter_id
    where o.id = ${orderId} and o.establishment_id = ${est}`;
  if (!o) return 0;
  const items = await sql`select name, option, qty, destination, course, status from order_items where order_id = ${orderId} and destination <> 'none'`;
  let n = 0;
  for (const station of ['kitchen', 'bar'] as const) {
    if (!opts.force && !auto[station]) continue;
    const now = items.filter((i) => i.destination === station && (opts.force ? i.status !== 'cancelled' && i.status !== 'held' : i.status === 'new'));
    if (!now.length) continue;
    const held = [...new Set(items.filter((i) => i.destination === station && i.status === 'held').map((i) => i.course as number))].sort();
    for (const p of await printersFor(sql, est, station)) {
      const payload = kitchenTicket({ station, place: o.place, orderNumber: o.number, createdAt: o.created_at, waiter: o.waiter, note: o.note,
        items: now.map((i) => ({ qty: i.qty, name: i.name, option: i.option, course: i.course })), heldCourses: held }, p.width_chars);
      await enqueue(sql, est, p.id, station, `${station === 'kitchen' ? 'Cocina' : 'Barra'} · ${o.place} · pedido ${o.number}`, payload);
      n++;
    }
  }
  return n;
}

/** "Marchar ahora": comanda con los platos del pase que se acaba de liberar. */
export async function printFire(est: string, accountId: string, course: number): Promise<number> {
  const auto = await autoPrintOf(sql, est);
  const rows = await sql`
    select i.name, i.option, i.qty, i.destination, i.course, o.number, o.created_at, o.note,
           coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place, w.name as waiter
    from order_items i join orders o on o.id = i.order_id join accounts a on a.id = o.account_id
    left join tables t on t.id = a.table_id left join waiters w on w.id = o.waiter_id
    where o.account_id = ${accountId} and o.establishment_id = ${est} and i.course = ${course} and i.status = 'new' and i.destination <> 'none'`;
  let n = 0;
  for (const station of ['kitchen', 'bar'] as const) {
    if (!auto[station]) continue;
    const its = rows.filter((r) => r.destination === station);
    if (!its.length) continue;
    for (const p of await printersFor(sql, est, station)) {
      await enqueue(sql, est, p.id, 'fire', `${station === 'kitchen' ? 'Cocina' : 'Barra'} · ${its[0].place} · marchar ${course}.º pase`,
        kitchenTicket({ station, place: its[0].place, orderNumber: its[0].number, createdAt: new Date(), waiter: its[0].waiter, note: '', fire: course,
          items: its.map((i) => ({ qty: i.qty, name: i.name, option: i.option, course: i.course })) }, p.width_chars));
      n++;
    }
  }
  return n;
}

/** Ticket, proforma o factura en la impresora de tickets. */
export async function printDocument(est: string, documentId: string, printerId?: string): Promise<number> {
  const [d] = await sql`select * from documents where id = ${documentId} and establishment_id = ${est}`;
  if (!d) return 0;
  const printers = printerId
    ? await sql`select id, name, width_chars from printers where id = ${printerId} and establishment_id = ${est} and active`
    : (await printersFor(sql, est, 'ticket')).slice(0, 1);
  for (const p of printers) {
    await enqueue(sql, est, p.id, d.type === 'proforma' ? 'proforma' : 'ticket', `${d.series}-${d.number} · ${d.payload.place}`, documentTicket(d as never, p.width_chars));
  }
  return printers.length;
}

export async function autoPrintTicket(est: string, documentId: string) {
  const auto = await autoPrintOf(sql, est);
  if (auto.ticket) await printDocument(est, documentId);
}

/** Abre el cajón portamonedas conectado a la impresora de tickets. */
export async function openDrawer(est: string): Promise<number> {
  const [p] = await printersFor(sql, est, 'ticket');
  if (!p) return 0;
  await enqueue(sql, est, p.id, 'drawer', 'Apertura de cajón', drawerKick());
  return 1;
}

/** Al cobrar en efectivo, abre el cajón si está activado. */
export async function autoOpenDrawer(est: string) {
  const auto = await autoPrintOf(sql, est);
  if (auto.drawer) await openDrawer(est);
}

export async function printZ(est: string, sessionId: string): Promise<number> {
  const [s] = await sql`select c.report, e.name from cash_sessions c join establishments e on e.id = c.establishment_id where c.id = ${sessionId} and c.establishment_id = ${est} and c.status = 'closed'`;
  const [p] = await printersFor(sql, est, 'ticket');
  if (!s || !p) return 0;
  await enqueue(sql, est, p.id, 'closing', `Cierre Z ${s.report.number}`, zReport(s.name, s.report, p.width_chars));
  return 1;
}
