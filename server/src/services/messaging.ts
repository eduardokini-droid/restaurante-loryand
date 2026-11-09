import { sql, type Tx } from '../db.js';
import { decryptSecret } from './secrets.js';

type Q = typeof sql | Tx;
export type MessageEvent = 'reservation_confirmed' | 'reservation_reminder' | 'waitlist_ready' | 'test';

/**
 * Avisos por WhatsApp. Dos modos:
 *  - "link": el programa prepara el mensaje y abre WhatsApp en el teléfono del personal (wa.me). Gratis, sin alta.
 *  - "meta": envío automático con la API oficial de WhatsApp Business (Cloud API) usando plantillas aprobadas.
 */
export interface WhatsAppConfig {
  provider: 'link' | 'meta';
  phoneNumberId: string;
  language: string;
  countryCode: string;
  templates: Record<Exclude<MessageEvent, 'test'>, string>;
  events: { reservationConfirmed: boolean; reservationReminder: boolean; reminderHours: number; waitlistReady: boolean };
}
export const DEFAULT_WHATSAPP: WhatsAppConfig = {
  provider: 'link', phoneNumberId: '', language: 'es', countryCode: '34',
  templates: { reservation_confirmed: 'reserva_confirmada', reservation_reminder: 'recordatorio_reserva', waitlist_ready: 'mesa_lista' },
  events: { reservationConfirmed: true, reservationReminder: true, reminderHours: 3, waitlistReady: true },
};

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Solo para pruebas: sustituye la llamada HTTP a Meta. */
export const setMessagingFetch = (f: typeof fetch) => { fetchImpl = f; };

export async function getWhatsApp(q: Q, establishmentId: string) {
  // Los avisos por WhatsApp solo funcionan si el plan del local los incluye.
  const [r] = await q`select (i.enabled and 'online' = any(e.features)) as enabled, i.config, i.secret_enc from integrations i join establishments e on e.id = i.establishment_id where i.establishment_id = ${establishmentId} and i.kind = 'whatsapp'`;
  if (!r) return null;
  const config: WhatsAppConfig = { ...DEFAULT_WHATSAPP, ...r.config, templates: { ...DEFAULT_WHATSAPP.templates, ...r.config.templates }, events: { ...DEFAULT_WHATSAPP.events, ...r.config.events } };
  return { enabled: r.enabled as boolean, config, token: r.secret_enc ? decryptSecret(r.secret_enc) : null };
}

/** Normaliza un teléfono a formato internacional sin "+" (34600123123). Devuelve null si no parece válido. */
export function normalizePhone(phone: string, countryCode = '34'): string | null {
  let p = phone.trim();
  const plus = p.startsWith('+');
  p = p.replace(/\D/g, '');
  if (!plus && p.startsWith('00')) p = p.slice(2);
  else if (!plus && p.length <= 10) p = countryCode + p.replace(/^0+/, '');
  return p.length >= 10 && p.length <= 15 ? p : null;
}

export const waLink = (phone: string, body: string) => `https://wa.me/${phone}?text=${encodeURIComponent(body)}`;

export interface MessageVars { name: string; establishment: string; party?: number; date?: string; time?: string; table?: string }

/** Texto del mensaje y parámetros de plantilla (mismo orden que las variables {{1}}, {{2}}… de Meta). */
export function compose(event: MessageEvent, v: MessageVars): { body: string; params: string[] } {
  switch (event) {
    case 'reservation_confirmed':
      return { body: `Hola ${v.name}, tu reserva en ${v.establishment} para ${v.party} personas el ${v.date} a las ${v.time} está confirmada. ¡Te esperamos!`,
        params: [v.name, v.establishment, String(v.party), v.date!, v.time!] };
    case 'reservation_reminder':
      return { body: `Hola ${v.name}, te recordamos tu reserva en ${v.establishment} el ${v.date} a las ${v.time} para ${v.party} personas. Si no puedes venir, avísanos.`,
        params: [v.name, v.establishment, v.date!, v.time!, String(v.party)] };
    case 'waitlist_ready':
      return { body: `Hola ${v.name}, tu mesa en ${v.establishment} ya está lista (${v.table}). Acércate al personal, por favor.`,
        params: [v.name, v.establishment, v.table!] };
    default:
      return { body: `Mensaje de prueba de ${v.establishment}: los avisos por WhatsApp funcionan.`, params: [v.establishment] };
  }
}

export interface SendResult { status: 'sent' | 'failed' | 'manual'; link?: string; error?: string }

/** Envía (o prepara) un aviso y lo registra. Devuelve null si los avisos están desactivados. */
export async function sendMessage(
  establishmentId: string, event: MessageEvent, phoneRaw: string, vars: MessageVars,
  refs: { reservationId?: string; waitlistId?: string } = {}, opts: { force?: boolean } = {},
): Promise<SendResult | null> {
  const wa = await getWhatsApp(sql, establishmentId);
  if (!wa?.enabled && !opts.force) return null;
  const cfg = wa?.config ?? DEFAULT_WHATSAPP;
  const flag = { reservation_confirmed: cfg.events.reservationConfirmed, reservation_reminder: cfg.events.reservationReminder, waitlist_ready: cfg.events.waitlistReady, test: true }[event];
  if (!flag && !opts.force) return null;
  const { body, params } = compose(event, vars);
  const phone = normalizePhone(phoneRaw, cfg.countryCode);
  const log = (status: SendResult['status'], provider: 'link' | 'meta', error: string | null) => sql`
    insert into message_log (establishment_id, event, to_phone, body, provider, status, error, reservation_id, waitlist_id)
    values (${establishmentId}, ${event}, ${phone ?? phoneRaw}, ${body}, ${provider}, ${status}, ${error}, ${refs.reservationId ?? null}, ${refs.waitlistId ?? null})`;
  if (!phone) {
    await log('failed', cfg.provider, 'Teléfono no válido');
    return { status: 'failed', error: 'El teléfono no es válido' };
  }
  if (cfg.provider === 'link' || !wa?.token) {
    await log('manual', 'link', null);
    return { status: 'manual', link: waLink(phone, body) };
  }
  try {
    const res = await fetchImpl(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${wa.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event === 'test'
        ? { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body } }
        : { messaging_product: 'whatsapp', to: phone, type: 'template',
            template: { name: cfg.templates[event], language: { code: cfg.language }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `WhatsApp respondió ${res.status}`);
    }
    await log('sent', 'meta', null);
    return { status: 'sent' };
  } catch (e) {
    await log('failed', 'meta', (e as Error).message);
    // Si el envío automático falla, el personal aún puede avisar a mano con el enlace.
    return { status: 'failed', error: (e as Error).message, link: waLink(phone, body) };
  }
}

/** Recordatorios automáticos (solo modo "meta"): reservas confirmadas que empiezan en las próximas N horas. */
export async function sendDueReminders(): Promise<number> {
  const rows = await sql`
    select r.id, r.establishment_id, r.name, r.phone, r.party_size, e.name as est_name,
           to_char(r.starts_at at time zone 'Europe/Madrid', 'DD/MM') as date, to_char(r.starts_at at time zone 'Europe/Madrid', 'HH24:MI') as time,
           (i.config->'events'->>'reminderHours')::int as hours, i.config->'events'->>'reservationReminder' as on, i.config->>'provider' as provider
    from reservations r
    join establishments e on e.id = r.establishment_id and e.active and 'online' = any(e.features)
    join integrations i on i.establishment_id = r.establishment_id and i.kind = 'whatsapp' and i.enabled
    where r.status = 'confirmed' and r.reminder_sent_at is null and r.phone <> '' and r.whatsapp_consent
      and r.starts_at > now() + interval '30 minutes'
      and r.starts_at <= now() + make_interval(hours => coalesce((i.config->'events'->>'reminderHours')::int, 3))`;
  let sent = 0;
  for (const r of rows) {
    if (r.provider !== 'meta' || r.on === 'false') continue;
    // Se marca antes de enviar: nunca se manda dos veces el mismo recordatorio.
    const [claimed] = await sql`update reservations set reminder_sent_at = now() where id = ${r.id} and reminder_sent_at is null returning id`;
    if (!claimed) continue;
    const res = await sendMessage(r.establishment_id, 'reservation_reminder', r.phone,
      { name: r.name, establishment: r.est_name, party: r.party_size, date: r.date, time: r.time }, { reservationId: r.id });
    if (res?.status === 'sent') sent++;
  }
  return sent;
}
