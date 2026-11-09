import { sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';

type Q = typeof sql | Tx;
export const TZ = 'Europe/Madrid';
/** Un turno abierto más de este tiempo se considera una salida olvidada. */
export const FORGOTTEN_HOURS = 16;

const snapshot = (s: Record<string, any>) => ({ startedAt: s.started_at, endedAt: s.ended_at, status: s.status });

export async function logEdit(q: Q, shiftId: string, action: string, actor: string, before: object | null, after: object | null, reason: string) {
  await q`insert into shift_edits (shift_id, action, actor, before, after, reason)
          values (${shiftId}, ${action}, ${actor}, ${before ? q.json(before as never) : null}, ${after ? q.json(after as never) : null}, ${reason})`;
}

/**
 * Salidas olvidadas: el turno se cierra con la última actividad del trabajador en ese turno
 * (comandas o cobros) —nunca con una hora inventada— y queda «pendiente de revisar».
 */
export async function autoCloseForgotten(waiterId?: string): Promise<number> {
  const rows = await sql`
    select s.id, s.started_at, s.waiter_id from shifts s
    where s.status = 'valid' and s.ended_at is null and s.started_at < now() - make_interval(hours => ${FORGOTTEN_HOURS})
      and (${waiterId ?? null}::uuid is null or s.waiter_id = ${waiterId ?? null})`;
  for (const s of rows) {
    await sql.begin(async (tx) => {
      const [{ last }] = await tx`
        select greatest(
          (select max(o.created_at) from orders o where o.waiter_id = ${s.waiter_id} and o.created_at >= ${s.started_at}),
          (select max(p.created_at) from payments p where p.waiter_id = ${s.waiter_id} and p.created_at >= ${s.started_at}),
          (select max(b.ended_at) from shift_breaks b where b.shift_id = ${s.id})
        ) as last`;
      const end = last && new Date(last) > new Date(s.started_at) ? last : new Date(new Date(s.started_at).getTime() + 60_000);
      const [u] = await tx`update shifts set ended_at = ${end}, needs_review = true where id = ${s.id} and ended_at is null returning *`;
      if (!u) return;
      await tx`update shift_breaks set ended_at = ${end} where shift_id = ${s.id} and ended_at is null`;
      await logEdit(tx, s.id, 'auto_close', 'sistema', { endedAt: null }, { endedAt: end },
        `Salida no fichada. Cerrado con la última actividad registrada (${last ? 'comandas/cobros' : 'sin actividad: revisar'}). Pendiente de revisar por el encargado.`);
    });
  }
  return rows.length;
}

export async function startShift(waiterId: string) {
  await autoCloseForgotten(waiterId);
  const [s] = await sql`insert into shifts (waiter_id) values (${waiterId}) on conflict do nothing returning *`;
  return s ?? null;
}

export async function endShift(waiterId: string) {
  return sql.begin(async (tx) => {
    const [s] = await tx`select id from shifts where waiter_id = ${waiterId} and status = 'valid' and ended_at is null for update`;
    if (!s) throw conflict('not_on_shift', 'No tienes ningún turno abierto');
    await tx`update shift_breaks set ended_at = now() where shift_id = ${s.id} and ended_at is null`;
    await tx`update shifts set ended_at = now() where id = ${s.id}`;
  });
}

export async function toggleBreak(waiterId: string, start: boolean) {
  return sql.begin(async (tx) => {
    const [s] = await tx`select id from shifts where waiter_id = ${waiterId} and status = 'valid' and ended_at is null for update`;
    if (!s) throw conflict('not_on_shift', 'Ficha la entrada antes de iniciar una pausa');
    const [open] = await tx`select id from shift_breaks where shift_id = ${s.id} and ended_at is null`;
    if (start) {
      if (open) throw conflict('break_open', 'Ya estás en pausa');
      await tx`insert into shift_breaks (shift_id) values (${s.id})`;
    } else {
      if (!open) throw conflict('no_break', 'No estás en pausa');
      await tx`update shift_breaks set ended_at = now() where id = ${open.id}`;
    }
  });
}

/** Turnos de un periodo con pausas, minutos trabajados e incidencias. */
export async function listShifts(q: Q, est: string, from: string, to: string, waiterId?: string | null) {
  return q`
    select s.id, s.waiter_id, w.name, w.code, w.staff_role, w.document_id, s.started_at, s.ended_at, s.status, s.needs_review, s.origin,
           to_char(s.started_at at time zone ${TZ}, 'YYYY-MM-DD') as day,
           coalesce((select json_agg(json_build_object('start', b.started_at, 'end', b.ended_at) order by b.started_at) from shift_breaks b where b.shift_id = s.id), '[]') as breaks,
           coalesce((select sum(extract(epoch from (coalesce(b.ended_at, now()) - b.started_at)) / 60) from shift_breaks b where b.shift_id = s.id), 0)::int as break_min,
           case when s.status = 'voided' then 0 else
             greatest(0, (extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)) / 60
               - coalesce((select sum(extract(epoch from (coalesce(b.ended_at, now()) - b.started_at)) / 60) from shift_breaks b where b.shift_id = s.id), 0)))::int end as worked_min,
           (select count(*)::int from shift_edits e where e.shift_id = s.id and e.action <> 'auto_close') as corrections,
           (select string_agg(e.actor || ' (' || to_char(e.created_at at time zone ${TZ}, 'DD/MM HH24:MI') || '): ' || e.reason, ' | ' order by e.created_at)
              from shift_edits e where e.shift_id = s.id) as history
    from shifts s join waiters w on w.id = s.waiter_id
    where w.establishment_id = ${est}
      and (s.started_at at time zone ${TZ})::date between ${from}::date and ${to}::date
      and (${waiterId ?? null}::uuid is null or s.waiter_id = ${waiterId ?? null})
    order by w.name, s.started_at`;
}

async function checkRange(tx: Tx, waiterId: string, start: Date, end: Date | null, excludeId: string | null) {
  if (end && end <= start) throw badRequest('La salida debe ser posterior a la entrada');
  if (start > new Date(Date.now() + 60_000) || (end && end > new Date(Date.now() + 60_000))) throw badRequest('No se pueden registrar horas futuras');
  if (end && end.getTime() - start.getTime() > 24 * 3600_000) throw badRequest('Un turno no puede superar 24 horas');
  const [overlap] = await tx`
    select to_char(started_at at time zone ${TZ}, 'DD/MM HH24:MI') as at from shifts
    where waiter_id = ${waiterId} and status = 'valid' and (${excludeId}::uuid is null or id <> ${excludeId})
      and tstzrange(started_at, coalesce(ended_at, 'infinity')) && tstzrange(${start}, coalesce(${end}::timestamptz, 'infinity'))`;
  if (overlap) throw conflict('overlap', `Se solapa con otro turno de esta persona (entrada ${overlap.at})`);
}

/** Alta manual de un turno olvidado por el encargado. */
export async function createShift(est: string, waiterId: string, start: Date, end: Date | null, reason: string, actor: string) {
  return sql.begin(async (tx) => {
    const [w] = await tx`select id from waiters where id = ${waiterId} and establishment_id = ${est}`;
    if (!w) throw notFound('Trabajador');
    await checkRange(tx, waiterId, start, end, null);
    const [s] = await tx`insert into shifts (waiter_id, started_at, ended_at, origin) values (${waiterId}, ${start}, ${end}, 'manager') returning *`;
    await logEdit(tx, s.id, 'create', actor, null, snapshot(s), reason);
    return s;
  });
}

/** Corrección de un turno: se guarda lo anterior, lo nuevo, quién y por qué. */
export async function updateShift(est: string, shiftId: string, start: Date | undefined, end: Date | null | undefined, reason: string, actor: string) {
  return sql.begin(async (tx) => {
    const [s] = await tx`select s.* from shifts s join waiters w on w.id = s.waiter_id where s.id = ${shiftId} and w.establishment_id = ${est} for update of s`;
    if (!s) throw notFound('Turno');
    if (s.status !== 'valid') throw conflict('voided', 'Este turno está anulado');
    const newStart = start ?? new Date(s.started_at);
    const newEnd = end === undefined ? (s.ended_at ? new Date(s.ended_at) : null) : end;
    await checkRange(tx, s.waiter_id, newStart, newEnd, s.id);
    const [u] = await tx`update shifts set started_at = ${newStart}, ended_at = ${newEnd}, needs_review = false where id = ${s.id} returning *`;
    await logEdit(tx, s.id, 'update', actor, snapshot(s), snapshot(u), reason);
    return u;
  });
}

export async function voidShift(est: string, shiftId: string, reason: string, actor: string) {
  return sql.begin(async (tx) => {
    const [s] = await tx`select s.* from shifts s join waiters w on w.id = s.waiter_id where s.id = ${shiftId} and w.establishment_id = ${est} for update of s`;
    if (!s) throw notFound('Turno');
    if (s.status === 'voided') return s;
    const [u] = await tx`update shifts set status = 'voided', needs_review = false, ended_at = coalesce(ended_at, now()) where id = ${s.id} returning *`;
    await logEdit(tx, s.id, 'void', actor, snapshot(s), snapshot(u), reason);
    return u;
  });
}

const ROLE: Record<string, string> = { sala: 'Sala', cocina: 'Cocina', barra: 'Barra', otros: 'Otros' };
const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const clock = (d: string | Date | null) => (d ? new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '');
const date = (d: string | Date) => new Date(d).toLocaleDateString('es-ES', { timeZone: TZ });
const cell = (v: string | number) => {
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV para Excel (separador «;», UTF-8 con BOM): una fila por turno y totales por trabajador. */
export function timesheetCsv(establishment: string, from: string, to: string, rows: any[]): string {
  const out: string[][] = [
    [`Registro de jornada · ${establishment}`], [`Periodo: ${date(from)} - ${date(to)}`], [],
    ['Fecha', 'Trabajador', 'DNI/NIE', 'Puesto', 'Entrada', 'Salida', 'Pausas (min)', 'Tiempo trabajado (h:mm)', 'Estado', 'Correcciones e incidencias'],
  ];
  const totals = new Map<string, number>();
  for (const r of rows) {
    const endDiff = r.ended_at && date(r.ended_at) !== date(r.started_at) ? ` (${date(r.ended_at)})` : '';
    const state = r.status === 'voided' ? 'Anulado' : r.needs_review ? 'Pendiente de revisar' : !r.ended_at ? 'En curso' : r.corrections ? 'Corregido' : 'Correcto';
    out.push([date(r.started_at), r.name, r.document_id, ROLE[r.staff_role] ?? r.staff_role, clock(r.started_at), clock(r.ended_at) + endDiff,
      String(r.break_min), hm(r.worked_min), state, r.history ?? '']);
    if (r.status !== 'voided') totals.set(r.name, (totals.get(r.name) ?? 0) + r.worked_min);
  }
  out.push([], ['Totales del periodo']);
  for (const [name, min] of totals) out.push([name, '', '', '', '', '', '', hm(min)]);
  return '﻿' + out.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
