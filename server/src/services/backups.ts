import { sql, type Tx } from '../db.js';
import { conflict } from '../errors.js';

type Q = typeof sql | Tx;

/**
 * Tablas incluidas en la copia, en orden de inserción (respetando dependencias).
 * A diferencia de la versión anterior, la lista de espera, la ocupación de mesas, las reservas,
 * el almacén y la fidelización SÍ forman parte de la copia.
 * Los usuarios del panel y sus contraseñas no se copian ni se restauran.
 */
const TABLES: Array<{ name: string; where: string }> = [
  { name: 'waiters', where: 'establishment_id = $1' },
  { name: 'categories', where: 'establishment_id = $1' },
  { name: 'products', where: 'establishment_id = $1' },
  { name: 'tables', where: 'establishment_id = $1' },
  { name: 'waiter_tables', where: 'waiter_id in (select id from waiters where establishment_id = $1)' },
  { name: 'shifts', where: 'waiter_id in (select id from waiters where establishment_id = $1)' },
  { name: 'daily_menus', where: 'establishment_id = $1' },
  { name: 'customers', where: 'establishment_id = $1' },
  { name: 'coupons', where: 'establishment_id = $1' },
  { name: 'stock_items', where: 'establishment_id = $1' },
  { name: 'recipe_lines', where: 'product_id in (select id from products where establishment_id = $1)' },
  { name: 'reservations', where: 'establishment_id = $1' },
  { name: 'waitlist', where: 'establishment_id = $1' },
  { name: 'table_occupancy', where: 'table_id in (select id from tables where establishment_id = $1)' },
  { name: 'accounts', where: 'establishment_id = $1' },
  { name: 'account_discounts', where: 'account_id in (select id from accounts where establishment_id = $1)' },
  { name: 'orders', where: 'establishment_id = $1' },
  { name: 'order_items', where: 'order_id in (select id from orders where establishment_id = $1)' },
  { name: 'payments', where: 'establishment_id = $1' },
  { name: 'documents', where: 'establishment_id = $1' },
  { name: 'service_requests', where: 'establishment_id = $1' },
  { name: 'stock_movements', where: 'establishment_id = $1' },
  { name: 'audit_log', where: 'establishment_id = $1' },
];
const ESTABLISHMENT_FIELDS = ['name', 'legal_name', 'tax_id', 'phone', 'email', 'address', 'postal_code', 'city', 'province', 'settings'];

export interface BackupData {
  format: 'loryand-backup';
  version: number;
  establishmentId: string;
  createdAt: string;
  establishment: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportEstablishment(q: Q, establishmentId: string): Promise<BackupData> {
  const [est] = await q.unsafe(`select ${ESTABLISHMENT_FIELDS.join(', ')} from establishments where id = $1`, [establishmentId]);
  const tables: BackupData['tables'] = {};
  for (const t of TABLES) {
    tables[t.name] = await q.unsafe(`select * from ${t.name} where ${t.where}`, [establishmentId]) as unknown as Record<string, unknown>[];
  }
  return { format: 'loryand-backup', version: 3, establishmentId, createdAt: new Date().toISOString(), establishment: est, tables };
}

export function summarize(data: BackupData) {
  const counts = Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length]));
  const lastDocs: Record<string, number> = {};
  for (const d of data.tables.documents ?? []) {
    const s = d.series as string;
    lastDocs[s] = Math.max(lastDocs[s] ?? 0, d.number as number);
  }
  return { establishment: data.establishment.name, createdAt: data.createdAt, version: data.version, counts, lastDocuments: lastDocs };
}

export async function saveBackup(q: Q, establishmentId: string, kind: 'daily' | 'manual' | 'preventive') {
  const data = await exportEstablishment(q, establishmentId);
  const json = JSON.stringify(data);
  const [b] = await q`
    insert into backups (establishment_id, kind, size_bytes, summary, data)
    values (${establishmentId}, ${kind}, ${Buffer.byteLength(json)}, ${q.json(summarize(data) as never)}, ${q.json(data as never)})
    returning id, kind, size_bytes, summary, created_at`;
  // Se conservan las 14 últimas diarias y las 10 últimas manuales/preventivas.
  await q`delete from backups where establishment_id = ${establishmentId} and kind = 'daily'
          and id not in (select id from backups where establishment_id = ${establishmentId} and kind = 'daily' order by created_at desc limit 14)`;
  await q`delete from backups where establishment_id = ${establishmentId} and kind <> 'daily'
          and id not in (select id from backups where establishment_id = ${establishmentId} and kind <> 'daily' order by created_at desc limit 10)`;
  return b;
}

export function validateFormat(raw: unknown): BackupData {
  const d = raw as BackupData;
  if (!d || d.format !== 'loryand-backup' || typeof d.establishmentId !== 'string' || typeof d.tables !== 'object') {
    throw conflict('bad_backup', 'El archivo no es una copia de seguridad de Restaurante Loryand');
  }
  for (const k of Object.keys(d.tables)) {
    if (!TABLES.some((t) => t.name === k)) throw conflict('bad_backup', `La copia contiene una tabla desconocida: ${k}`);
  }
  return d;
}

/** Comprobaciones previas: mismo negocio, sin servicio activo y sin perder facturas emitidas. */
export async function checkRestore(q: Q, establishmentId: string, data: BackupData) {
  const problems: string[] = [];
  if (data.establishmentId !== establishmentId) problems.push('La copia pertenece a otro establecimiento');
  const [{ n: open }] = await q`
    select count(*)::int as n from accounts a where a.establishment_id = ${establishmentId} and a.status = 'open'
      and exists (select 1 from orders o join order_items i on i.order_id = o.id where o.account_id = a.id and i.status <> 'cancelled')`;
  if (open > 0) problems.push(`Hay ${open} cuenta(s) abiertas: no restaures durante el servicio`);
  const inBackup = new Set((data.tables.documents ?? []).map((d) => d.id as string));
  const current = await q`select id, series, number from documents where establishment_id = ${establishmentId} and type <> 'proforma'`;
  const lost = current.filter((d) => !inBackup.has(d.id));
  if (lost.length) {
    problems.push(`La copia no contiene ${lost.length} factura(s) emitidas después (p. ej. ${lost[0].series}-${lost[0].number}). Restaurarla las perdería y haría retroceder la numeración`);
  }
  return problems;
}

export async function restore(tx: Tx, establishmentId: string, data: BackupData) {
  const problems = await checkRestore(tx, establishmentId, data);
  if (problems.length) throw conflict('restore_blocked', problems.join('. '));
  const preventive = await saveBackup(tx, establishmentId, 'preventive');
  for (const t of [...TABLES].reverse()) await tx.unsafe(`delete from ${t.name} where ${t.where}`, [establishmentId]);
  const users = new Set((await tx`select id from users`).map((u) => u.id as string));
  for (const t of TABLES) {
    const rows = (data.tables[t.name] ?? []).map((r) => {
      // Usuarios del panel que ya no existen: se conserva la operación sin autor.
      if ('user_id' in r && r.user_id && !users.has(r.user_id as string)) return { ...r, user_id: null };
      return r;
    });
    if (!rows.length) continue;
    await tx.unsafe(`insert into ${t.name} select * from json_populate_recordset(null::${t.name}, $1::text::json)`, [JSON.stringify(rows)]);
  }
  for (const seq of ['audit_log', 'stock_movements', 'table_occupancy']) {
    await tx.unsafe(`select setval(pg_get_serial_sequence('${seq}', 'id'), greatest((select coalesce(max(id), 1) from ${seq}), 1))`);
  }
  const est = data.establishment;
  const plain = Object.fromEntries(ESTABLISHMENT_FIELDS.filter((f) => f in est && f !== 'settings').map((f) => [f, est[f]]));
  if (Object.keys(plain).length) await tx`update establishments set ${tx(plain as Record<string, string>)} where id = ${establishmentId}`;
  if (est.settings) await tx`update establishments set settings = ${tx.json(est.settings as never)} where id = ${establishmentId}`;
  return preventive;
}
