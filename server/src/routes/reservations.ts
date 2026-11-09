import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, type Tx } from '../db.js';
import { actorLabel, establishmentOf, requireModule } from '../auth.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { checkLimit, recordFailure } from '../ratelimit.js';
import { audit } from '../services/audit.js';
import { setPhysicalState } from '../services/tables.js';
import { sendMessage, type SendResult } from '../services/messaging.js';
import { legalTexts, logConsent } from '../services/legal.js';

async function confirmationMessage(est: string, r: Record<string, any>): Promise<SendResult | null> {
  // Solo por WhatsApp si el cliente lo ha aceptado; si no, el personal avisa por teléfono.
  if (!r.phone || !r.whatsapp_consent) return null;
  const [x] = await sql`select e.name, to_char(${r.starts_at}::timestamptz at time zone ${TZ}, 'DD/MM') as date, to_char(${r.starts_at}::timestamptz at time zone ${TZ}, 'HH24:MI') as time from establishments e where e.id = ${est}`;
  return sendMessage(est, 'reservation_confirmed', r.phone, { name: r.name, establishment: x.name, party: r.party_size, date: x.date, time: x.time }, { reservationId: r.id });
}

export const TZ = 'Europe/Madrid';

export interface ReservationSettings {
  lunch: { start: string; end: string } | null;
  dinner: { start: string; end: string } | null;
  durationMin: number;
  graceMin: number;
  /** Fianza por persona en céntimos; se exige a partir de depositFromParty comensales (0 = nunca). */
  depositPerPersonCents: number;
  depositFromParty: number;
  publicEnabled: boolean;
  cancellationPolicy: string;
  maxPartyOnline: number;
}
export const DEFAULT_RESERVATION_SETTINGS: ReservationSettings = {
  lunch: { start: '13:00', end: '15:30' }, dinner: { start: '20:00', end: '22:30' },
  durationMin: 90, graceMin: 15, depositPerPersonCents: 0, depositFromParty: 0,
  publicEnabled: true, cancellationPolicy: 'Avísanos con al menos 2 horas de antelación si no puedes venir.', maxPartyOnline: 10,
};

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
export const reservationSettingsSchema = z.object({
  lunch: z.object({ start: hhmm, end: hhmm }).nullable(),
  dinner: z.object({ start: hhmm, end: hhmm }).nullable(),
  durationMin: z.number().int().min(15).max(600),
  graceMin: z.number().int().min(0).max(120),
  depositPerPersonCents: z.number().int().min(0).max(100_000),
  depositFromParty: z.number().int().min(0).max(100),
  publicEnabled: z.boolean(),
  cancellationPolicy: z.string().max(600),
  maxPartyOnline: z.number().int().min(1).max(100),
}).partial();

async function settingsOf(q: typeof sql | Tx, est: string): Promise<ReservationSettings> {
  const [e] = await q`select settings from establishments where id = ${est}`;
  return { ...DEFAULT_RESERVATION_SETTINGS, ...(e?.settings?.reservations ?? {}) };
}

const inWindow = (time: string, w: { start: string; end: string } | null) => !!w && time >= w.start && time <= w.end;

export function depositFor(s: ReservationSettings, party: number) {
  return s.depositFromParty > 0 && party >= s.depositFromParty ? s.depositPerPersonCents * party : 0;
}

/** Comprueba que las mesas no estén comprometidas por otra reserva en el mismo horario. */
async function checkConflicts(tx: Tx, est: string, tableIds: string[], startsAt: Date, durationMin: number, excludeId: string | null) {
  if (!tableIds.length) return;
  const valid = await tx`select id from tables where establishment_id = ${est} and id in ${tx(tableIds)}`;
  if (valid.length !== tableIds.length) throw notFound('Mesa');
  const clash = await tx`
    select r.name, to_char(r.starts_at at time zone ${TZ}, 'HH24:MI') as at from reservations r
    where r.establishment_id = ${est} and r.status in ('confirmed','seated')
      and (${excludeId}::uuid is null or r.id <> ${excludeId})
      and r.table_ids && ${tableIds}::uuid[]
      and tstzrange(r.starts_at, r.starts_at + make_interval(mins => r.duration_min)) &&
          tstzrange(${startsAt}, ${startsAt}::timestamptz + make_interval(mins => ${durationMin}))
    limit 1`;
  if (clash[0]) throw conflict('table_conflict', `Esa mesa ya está reservada para ${clash[0].name} a las ${clash[0].at}`);
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(30).default(''),
  email: z.string().max(120).default(''),
  partySize: z.number().int().min(1).max(100),
  date: z.string().date(),
  time: hhmm,
  durationMin: z.number().int().min(15).max(600).optional(),
  notes: z.string().max(500).default(''),
  zonePref: z.enum(['salon', 'terraza', 'barra', 'reservado']).nullable().default(null),
  tableIds: z.array(z.string().uuid()).default([]),
  status: z.enum(['requested', 'confirmed']).default('confirmed'),
  whatsappConsent: z.boolean().default(false),
});

const toStart = async (q: typeof sql | Tx, date: string, time: string) => {
  const [{ ts }] = await q`select (${`${date} ${time}`}::timestamp at time zone ${TZ}) as ts`;
  return ts as Date;
};

export default async function reservationRoutes(app: FastifyInstance) {
  app.get('/api/reservations/settings', async (req) => {
    requireModule(req, 'reservations');
    return settingsOf(sql, establishmentOf(req));
  });

  app.put('/api/reservations/settings', async (req) => {
    const a = requireModule(req, 'reservations');
    const est = establishmentOf(req);
    const b = parse(reservationSettingsSchema, req.body);
    await sql`update establishments set settings = jsonb_set(settings, '{reservations}', coalesce(settings->'reservations', '{}'::jsonb) || ${sql.json(b)}) where id = ${est}`;
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'reservations.settings', b));
    return settingsOf(sql, est);
  });

  app.get('/api/reservations', async (req) => {
    requireModule(req, 'reservations');
    const est = establishmentOf(req);
    const { date } = parse(z.object({ date: z.string().date() }), req.query);
    const s = await settingsOf(sql, est);
    const rows = await sql`
      select r.*, to_char(r.starts_at at time zone ${TZ}, 'HH24:MI') as time,
             coalesce((select array_agg(t.label order by t.label) from tables t where t.id = any(r.table_ids)), '{}') as table_labels,
             (r.status = 'confirmed' and now() > r.starts_at + make_interval(mins => ${s.graceMin})) as overdue
      from reservations r
      where r.establishment_id = ${est} and (r.starts_at at time zone ${TZ})::date = ${date}::date
      order by r.starts_at, r.created_at`;
    return { settings: s, reservations: rows };
  });

  app.post('/api/reservations', async (req) => {
    const a = requireModule(req, 'reservations');
    const est = establishmentOf(req);
    const b = parse(createSchema, req.body);
    const r = await sql.begin(async (tx) => {
      const s = await settingsOf(tx, est);
      const startsAt = await toStart(tx, b.date, b.time);
      const duration = b.durationMin ?? s.durationMin;
      const deposit = depositFor(s, b.partySize);
      let status = b.status;
      if (status === 'confirmed' && deposit > 0) status = 'requested';
      if (status === 'confirmed') await checkConflicts(tx, est, b.tableIds, startsAt, duration, null);
      const [row] = await tx`
        insert into reservations (establishment_id, name, phone, email, party_size, starts_at, duration_min, notes, zone_pref, table_ids,
                                  status, deposit_cents, deposit_status, source, whatsapp_consent)
        values (${est}, ${b.name}, ${b.phone}, ${b.email}, ${b.partySize}, ${startsAt}, ${duration}, ${b.notes}, ${b.zonePref}, ${b.tableIds},
                ${status}, ${deposit}, ${deposit > 0 ? 'pending' : 'none'}, 'staff', ${b.whatsappConsent && !!b.phone})
        returning *`;
      if (row.whatsapp_consent) await logConsent(tx, { establishmentId: est, kind: 'reservation', subjectId: row.id, purpose: 'whatsapp', granted: true, source: 'staff', actor: actorLabel(a) });
      await audit(tx, est, actorLabel(a), 'reservation.create', { id: row.id });
      return row;
    });
    notify(est, ['tables']);
    const message = r.status === 'confirmed' ? await confirmationMessage(est, r) : null;
    return { ...r, message };
  });

  app.patch('/api/reservations/:id', async (req) => {
    const a = requireModule(req, 'reservations');
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({
      status: z.enum(['requested', 'confirmed', 'seated', 'finished', 'cancelled', 'no_show']),
      tableIds: z.array(z.string().uuid()),
      depositStatus: z.enum(['none', 'pending', 'paid', 'refunded']),
      partySize: z.number().int().min(1).max(100),
      date: z.string().date(), time: hhmm,
      notes: z.string().max(500), name: z.string().min(1).max(80), phone: z.string().max(30),
      whatsappConsent: z.boolean(),
    }).partial(), req.body);
    const r = await sql.begin(async (tx) => {
      const [cur] = await tx`select * from reservations where id = ${id} and establishment_id = ${est} for update`;
      if (!cur) throw notFound('Reserva');
      let startsAt: Date = cur.starts_at;
      if (b.date || b.time) {
        const [{ d, t }] = await tx`select to_char(${cur.starts_at}::timestamptz at time zone ${TZ}, 'YYYY-MM-DD') as d, to_char(${cur.starts_at}::timestamptz at time zone ${TZ}, 'HH24:MI') as t`;
        startsAt = await toStart(tx, b.date ?? d, b.time ?? t);
      }
      const tableIds = b.tableIds ?? cur.table_ids;
      const status = b.status ?? cur.status;
      const depositStatus = b.depositStatus ?? cur.deposit_status;
      if (status === 'confirmed' && cur.deposit_cents > 0 && depositStatus !== 'paid') {
        throw conflict('deposit_required', 'La reserva exige fianza: márcala como pagada antes de confirmar');
      }
      if (['confirmed', 'seated'].includes(status)) await checkConflicts(tx, est, tableIds, startsAt, cur.duration_min, id);
      if (status === 'seated' && !tableIds.length) throw badRequest('Asigna una mesa antes de sentar al grupo');
      const [row] = await tx`
        update reservations set status = ${status}, table_ids = ${tableIds}, deposit_status = ${depositStatus}, starts_at = ${startsAt},
          party_size = ${b.partySize ?? cur.party_size}, notes = ${b.notes ?? cur.notes}, name = ${b.name ?? cur.name}, phone = ${b.phone ?? cur.phone},
          whatsapp_consent = ${b.whatsappConsent ?? cur.whatsapp_consent}, updated_at = now()
        where id = ${id} returning *`;
      if (b.whatsappConsent !== undefined && b.whatsappConsent !== cur.whatsapp_consent) {
        await logConsent(tx, { establishmentId: est, kind: 'reservation', subjectId: id, purpose: 'whatsapp', granted: b.whatsappConsent, source: 'staff', actor: actorLabel(a) });
      }
      if (status === 'seated' && cur.status !== 'seated') {
        for (const t of tableIds) await setPhysicalState(tx, t, 'occupied');
      }
      await audit(tx, est, actorLabel(a), 'reservation.update', { id, ...b });
      return { row, wasConfirmed: cur.status === 'confirmed' };
    });
    notify(est, ['tables']);
    const message = r.row.status === 'confirmed' && !r.wasConfirmed ? await confirmationMessage(est, r.row) : null;
    return { ...r.row, message };
  });

  // ---------- Formulario público ----------
  app.get('/api/public/booking/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(40) }), req.params);
    const [e] = await sql`select id, name, address, city, phone from establishments where slug = ${slug} and active`;
    if (!e) throw notFound('Establecimiento');
    const s = await settingsOf(sql, e.id);
    if (!s.publicEnabled) throw new AppError(403, 'booking_closed', 'Este establecimiento no acepta reservas en línea');
    const legal = await legalTexts(sql, e.id);
    const [wa] = await sql`select 1 from integrations where establishment_id = ${e.id} and kind = 'whatsapp' and enabled`;
    return {
      privacyNotice: legal.layers.reservation, whatsappNotice: wa ? legal.layers.whatsapp : null,
      establishment: { name: e.name, address: e.address, city: e.city, phone: e.phone },
      lunch: s.lunch, dinner: s.dinner, cancellationPolicy: s.cancellationPolicy, maxParty: s.maxPartyOnline,
      depositPerPersonCents: s.depositPerPersonCents, depositFromParty: s.depositFromParty,
    };
  });

  app.post('/api/public/booking/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(40) }), req.params);
    checkLimit(req, 'booking');
    const b = parse(z.object({
      name: z.string().min(2).max(80), phone: z.string().min(6).max(30), email: z.string().email().or(z.literal('')).default(''),
      partySize: z.number().int().min(1).max(100), date: z.string().date(), time: hhmm,
      notes: z.string().max(500).default(''), zonePref: z.enum(['salon', 'terraza']).nullable().default(null),
      acceptPrivacy: z.literal(true, { error: 'Para reservar, acepta la política de privacidad' }),
      whatsappConsent: z.boolean().default(false),
    }), req.body);
    const [e] = await sql`select id from establishments where slug = ${slug} and active`;
    if (!e) throw notFound('Establecimiento');
    const s = await settingsOf(sql, e.id);
    if (!s.publicEnabled) throw new AppError(403, 'booking_closed', 'Este establecimiento no acepta reservas en línea');
    if (b.partySize > s.maxPartyOnline) throw badRequest(`Para más de ${s.maxPartyOnline} personas, llama al establecimiento`);
    if (!inWindow(b.time, s.lunch) && !inWindow(b.time, s.dinner)) throw badRequest('La hora elegida está fuera de los turnos de comida y cena');
    const startsAt = await toStart(sql, b.date, b.time);
    if (startsAt.getTime() < Date.now() + 30 * 60_000) throw badRequest('Elige una hora con al menos 30 minutos de antelación');
    recordFailure(req, 'booking'); // cuenta cada envío para frenar abusos del formulario
    const deposit = depositFor(s, b.partySize);
    const r = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into reservations (establishment_id, name, phone, email, party_size, starts_at, duration_min, notes, zone_pref, status, deposit_cents, deposit_status, source,
                                  privacy_accepted_at, whatsapp_consent)
        values (${e.id}, ${b.name}, ${b.phone}, ${b.email}, ${b.partySize}, ${startsAt}, ${s.durationMin}, ${b.notes}, ${b.zonePref}, 'requested',
                ${deposit}, ${deposit > 0 ? 'pending' : 'none'}, 'public', now(), ${b.whatsappConsent})
        returning id`;
      const base = { establishmentId: e.id, kind: 'reservation' as const, subjectId: row.id, source: 'public' as const, ip: req.ip };
      await logConsent(tx, { ...base, purpose: 'privacy', granted: true });
      if (b.whatsappConsent) await logConsent(tx, { ...base, purpose: 'whatsapp', granted: true });
      return row;
    });
    notify(e.id, ['tables']);
    // Una solicitud no es una reserva confirmada: el local la revisa y la confirma.
    return { id: r.id, status: 'requested', depositCents: deposit };
  });
}
