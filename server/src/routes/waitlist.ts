import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { type Actor, actorLabel, can, establishmentOf, requireActor } from '../auth.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { setPhysicalState } from '../services/tables.js';
import { averageStay, loadUnits, propose, type WaitGroup } from '../services/waitlist.js';
import { sendMessage } from '../services/messaging.js';

/** La lista de espera se usa desde el plano, las reservas y la PDA. */
function requireWaitlist(req: FastifyRequest): Actor {
  const a = requireActor(req);
  if (a.kind === 'waiter' || can(a, 'tpv') || can(a, 'reservations')) return a;
  throw forbidden();
}

const id = z.object({ id: z.string().uuid() });

export default async function waitlistRoutes(app: FastifyInstance) {
  app.get('/api/waitlist', async (req) => {
    requireWaitlist(req);
    const est = establishmentOf(req);
    const groups = await sql<WaitGroup[]>`
      select id, name, party_size, phone, zone_pref, status, table_ids, created_at, notified_at
      from waitlist where establishment_id = ${est} and status in ('waiting','notified') order by created_at`;
    const units = await loadUnits(sql, est);
    const stay = await averageStay(sql, est);
    const proposals = propose(units, groups, stay.minutes);
    const labelOf = new Map(units.flatMap((u) => u.tableIds.map((t, i) => [t, u.labels[i]] as const)));
    return {
      averageStayMin: stay.minutes, averageFromSamples: stay.samples,
      units,
      groups: groups.map((g) => {
        const p = proposals.find((x) => x.groupId === g.id);
        return {
          ...g,
          table_labels: g.table_ids.map((t) => labelOf.get(t) ?? '?'),
          proposal: p?.unit ? { tableIds: p.unit.tableIds, labels: p.unit.labels, seats: p.unit.seats, zone: p.unit.zone } : null,
          estimateMin: p?.estimateMin ?? null,
        };
      }),
    };
  });

  app.post('/api/waitlist', async (req) => {
    const a = requireWaitlist(req);
    const est = establishmentOf(req);
    const b = parse(z.object({
      name: z.string().min(1).max(60), partySize: z.number().int().min(1).max(100),
      phone: z.string().max(30).default(''), zonePref: z.enum(['salon', 'terraza', 'barra', 'reservado']).nullable().default(null),
    }), req.body);
    const [g] = await sql`insert into waitlist (establishment_id, name, party_size, phone, zone_pref)
                          values (${est}, ${b.name}, ${b.partySize}, ${b.phone}, ${b.zonePref}) returning *`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'waitlist.add', { id: g.id }));
    notify(est, ['tables']);
    return g;
  });

  /** "Confirmar mesa… y marcar avisado": la mesa queda protegida frente a otro grupo. No envía mensajes. */
  app.post('/api/waitlist/:id/assign', async (req) => {
    const a = requireWaitlist(req);
    const est = establishmentOf(req);
    const { id: gid } = parse(id, req.params);
    const { tableIds } = parse(z.object({ tableIds: z.array(z.string().uuid()).min(1) }), req.body);
    const result = await sql.begin(async (tx) => {
      await tx`select id from establishments where id = ${est} for update`;
      const [g] = await tx`select status, party_size, name, phone from waitlist where id = ${gid} and establishment_id = ${est} for update`;
      if (!g) throw notFound('Grupo');
      if (g.status !== 'waiting') throw conflict('not_waiting', 'Este grupo ya no está esperando');
      const units = await loadUnits(tx, est);
      const unit = units.find((u) => u.tableIds.length === tableIds.length && u.tableIds.every((t) => tableIds.includes(t)));
      if (!unit) throw conflict('bad_tables', 'Elige una mesa o una unión de mesas completa');
      if (unit.state !== 'free') throw conflict('table_unavailable', unit.blockedReason ?? 'La mesa ya no está libre y limpia');
      if (unit.seats < g.party_size) throw conflict('too_small', `La mesa tiene ${unit.seats} plazas y el grupo es de ${g.party_size}`);
      await tx`update waitlist set status = 'notified', table_ids = ${tableIds}, notified_at = now() where id = ${gid}`;
      await audit(tx, est, actorLabel(a), 'waitlist.assign', { id: gid, tableIds });
      return { name: g.name as string, phone: g.phone as string, labels: unit.labels };
    }).then(async (x) => {
      notify(est, ['tables']);
      if (!x.phone) return { ok: true, message: null };
      const [e] = await sql`select name from establishments where id = ${est}`;
      const message = await sendMessage(est, 'waitlist_ready', x.phone, { name: x.name, establishment: e.name, table: x.labels.length > 1 ? `mesas ${x.labels.join('+')}` : `mesa ${x.labels[0]}` }, { waitlistId: gid });
      return { ok: true, message };
    });
    return result;
  });

  app.post('/api/waitlist/:id/seat', async (req) => {
    const a = requireWaitlist(req);
    const est = establishmentOf(req);
    const { id: gid } = parse(id, req.params);
    await sql.begin(async (tx) => {
      const [g] = await tx`select status, table_ids from waitlist where id = ${gid} and establishment_id = ${est} for update`;
      if (!g) throw notFound('Grupo');
      if (g.status !== 'notified') throw conflict('not_notified', 'Asigna primero una mesa al grupo');
      for (const t of g.table_ids) await setPhysicalState(tx, t, 'occupied');
      await tx`update waitlist set status = 'seated', seated_at = now(), closed_at = now() where id = ${gid}`;
      await audit(tx, est, actorLabel(a), 'waitlist.seat', { id: gid });
    });
    notify(est, ['tables']);
    return { ok: true };
  });

  /** Cancelar o "no presentado". Si estaba avisado, la mesa vuelve a estar disponible. */
  app.post('/api/waitlist/:id/close', async (req) => {
    const a = requireWaitlist(req);
    const est = establishmentOf(req);
    const { id: gid } = parse(id, req.params);
    const { reason } = parse(z.object({ reason: z.enum(['cancelled', 'no_show', 'release']) }), req.body);
    await sql.begin(async (tx) => {
      const [g] = await tx`select status from waitlist where id = ${gid} and establishment_id = ${est} for update`;
      if (!g) throw notFound('Grupo');
      if (reason === 'release') {
        // Devuelve el grupo a la cola conservando su antigüedad.
        await tx`update waitlist set status = 'waiting', table_ids = '{}', notified_at = null where id = ${gid}`;
      } else {
        await tx`update waitlist set status = ${reason}, closed_at = now() where id = ${gid}`;
      }
      await audit(tx, est, actorLabel(a), 'waitlist.close', { id: gid, reason });
    });
    notify(est, ['tables']);
    return { ok: true };
  });
}
