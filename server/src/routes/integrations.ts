import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { config } from '../config.js';
import { actorLabel, establishmentOf, requireActor, requireService } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { notify } from '../realtime.js';
import { audit } from '../services/audit.js';
import { decryptSecret, encryptSecret, maskSecret } from '../services/secrets.js';
import { createOnlinePayment, getRedsys, handleNotification, startOnlinePayment } from '../services/online.js';
import { DEFAULT_WHATSAPP, sendMessage } from '../services/messaging.js';
import { checkLimit, recordFailure } from '../ratelimit.js';

function requireAdmin(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user' || a.role === 'staff') throw forbidden('Solo el administrador puede configurar las integraciones');
  return a;
}

async function saveIntegration(est: string, kind: 'redsys' | 'whatsapp', enabled: boolean, cfg: object, secret: string | undefined) {
  await sql`
    insert into integrations (establishment_id, kind, enabled, config, secret_enc, updated_at)
    values (${est}, ${kind}, ${enabled}, ${sql.json(cfg as never)}, ${secret ? encryptSecret(secret) : null}, now())
    on conflict (establishment_id, kind) do update set enabled = excluded.enabled, config = excluded.config,
      secret_enc = coalesce(excluded.secret_enc, integrations.secret_enc), updated_at = now()`;
}

export default async function integrationRoutes(app: FastifyInstance) {
  // Redsys notifica con un formulario (application/x-www-form-urlencoded).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // ---------- Configuración (administrador) ----------
  app.get('/api/integrations', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const rows = await sql`select kind, enabled, config, secret_enc from integrations where establishment_id = ${est}`;
    const view = (kind: string, defaults: object) => {
      const r = rows.find((x) => x.kind === kind);
      let masked: string | null = null;
      try { masked = r?.secret_enc ? maskSecret(decryptSecret(r.secret_enc)) : null; } catch { masked = 'no se puede leer: vuelve a introducirla'; }
      return { enabled: r?.enabled ?? false, config: { ...defaults, ...(r?.config ?? {}) }, secret: masked };
    };
    return {
      redsys: view('redsys', { merchantCode: '', terminal: '001', environment: 'test', card: true, bizum: false }),
      whatsapp: view('whatsapp', DEFAULT_WHATSAPP),
      notifyUrl: `${config.publicUrl}/api/redsys/notify`,
    };
  });

  app.put('/api/integrations/redsys', async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const b = parse(z.object({
      enabled: z.boolean(),
      merchantCode: z.string().regex(/^\d{6,12}$/, 'el código de comercio son solo números'),
      terminal: z.string().regex(/^\d{1,3}$/, 'el terminal son 1 a 3 cifras').transform((v) => v.padStart(3, '0')),
      environment: z.enum(['test', 'live']),
      card: z.boolean(), bizum: z.boolean(),
      secret: z.string().trim().regex(/^[A-Za-z0-9+/]{32}$/, 'la clave de firma tiene 32 caracteres').optional(),
    }), req.body);
    const current = await getRedsys(sql, est);
    if (b.enabled && !b.secret && !current?.secret) throw badRequest('Introduce la clave de firma (SHA-256) del TPV virtual');
    if (b.enabled && !b.card && !b.bizum) throw badRequest('Activa al menos un método de pago');
    const { secret, enabled, ...cfg } = b;
    await saveIntegration(est, 'redsys', enabled, cfg, secret);
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'integration.redsys', { enabled, environment: cfg.environment, card: cfg.card, bizum: cfg.bizum, secretChanged: !!secret }));
    return { ok: true };
  });

  app.put('/api/integrations/whatsapp', async (req) => {
    const a = requireAdmin(req);
    const est = establishmentOf(req);
    const b = parse(z.object({
      enabled: z.boolean(),
      provider: z.enum(['link', 'meta']),
      phoneNumberId: z.string().max(40).default(''),
      language: z.string().max(10).default('es'),
      countryCode: z.string().regex(/^\d{1,3}$/).default('34'),
      templates: z.object({ reservation_confirmed: z.string().max(80), reservation_reminder: z.string().max(80), waitlist_ready: z.string().max(80) }),
      events: z.object({ reservationConfirmed: z.boolean(), reservationReminder: z.boolean(), reminderHours: z.number().int().min(1).max(48), waitlistReady: z.boolean() }),
      token: z.string().trim().min(20).max(1000).optional(),
    }), req.body);
    const [cur] = await sql`select secret_enc from integrations where establishment_id = ${est} and kind = 'whatsapp'`;
    if (b.enabled && b.provider === 'meta' && (!b.phoneNumberId || (!b.token && !cur?.secret_enc))) {
      throw badRequest('Para el envío automático indica el identificador del número y el token de acceso de WhatsApp Business');
    }
    const { token, enabled, ...cfg } = b;
    await saveIntegration(est, 'whatsapp', enabled, cfg, token);
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'integration.whatsapp', { enabled, provider: cfg.provider, tokenChanged: !!token }));
    return { ok: true };
  });

  app.post('/api/integrations/whatsapp/test', async (req) => {
    requireAdmin(req);
    const est = establishmentOf(req);
    const { phone } = parse(z.object({ phone: z.string().min(6).max(30) }), req.body);
    const [e] = await sql`select name from establishments where id = ${est}`;
    return sendMessage(est, 'test', phone, { name: '', establishment: e.name }, {}, { force: true });
  });

  app.get('/api/messages', async (req) => {
    const a = requireActor(req);
    if (a.kind !== 'user') throw forbidden();
    return sql`select m.*, coalesce(r.name, w.name) as customer from message_log m
               left join reservations r on r.id = m.reservation_id left join waitlist w on w.id = m.waitlist_id
               where m.establishment_id = ${establishmentOf(req)} order by m.created_at desc limit 100`;
  });

  // ---------- Cobro online desde TPV / PDA ----------
  app.post('/api/service/accounts/:id/online-payment', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const p = await createOnlinePayment(est, id, actorLabel(a));
    notify(est, ['payments']);
    return { id: p.id, token: p.token, url: `${config.publicUrl}/pagar/${p.token}`, amountCents: p.amount_cents, environment: p.environment, status: p.status };
  });

  app.get('/api/service/accounts/:id/online-payments', async (req) => {
    requireService(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return sql`select id, token, order_code, amount_cents, method, environment, status, error, created_at, updated_at
               from online_payments where account_id = ${id} and establishment_id = ${establishmentOf(req)} order by created_at desc`;
  });

  /** Retirar un QR de pago preparado. */
  app.post('/api/service/online-payments/:id/cancel', async (req) => {
    const a = requireService(req);
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [p] = await sql`update online_payments set status = 'cancelled', updated_at = now()
                          where id = ${id} and establishment_id = ${est} and status = 'pending' returning id`;
    if (!p) throw conflict('not_pending', 'Ese pago ya no está pendiente. Consulta su referencia en Redsys antes de volver a cobrar.');
    await sql.begin((tx) => audit(tx, est, actorLabel(a), 'online.cancel', { id }));
    notify(est, ['payments']);
    return { ok: true };
  });

  app.get('/api/service/online-payments/conflicts', async (req) => {
    requireService(req);
    return sql`select op.id, op.order_code, op.amount_cents, op.method, op.error, op.updated_at, coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place
               from online_payments op join accounts a on a.id = op.account_id left join tables t on t.id = a.table_id
               where op.establishment_id = ${establishmentOf(req)} and op.status = 'conflict' order by op.updated_at desc`;
  });

  // ---------- Página pública de pago ----------
  app.get('/api/public/pay/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[a-f0-9]{32}$/) }), req.params);
    const [p] = await sql`
      select op.status, op.amount_cents, op.environment, op.method, op.created_at, op.establishment_id, e.name as establishment,
             coalesce('Mesa ' || t.label, 'Barra · ' || a.bar_name) as place, (op.created_at < now() - interval '20 minutes') as expired
      from online_payments op join establishments e on e.id = op.establishment_id
      join accounts a on a.id = op.account_id left join tables t on t.id = a.table_id
      where op.token = ${token}`;
    if (!p) throw notFound('Pago');
    const r = await getRedsys(sql, p.establishment_id);
    return {
      establishment: p.establishment, place: p.place, amountCents: p.amount_cents, environment: p.environment,
      status: p.status === 'pending' && p.expired ? 'expired' : p.status, method: p.method,
      methods: { card: !!r?.config.card, bizum: !!r?.config.bizum },
    };
  });

  app.post('/api/public/pay/:token/start', async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[a-f0-9]{32}$/) }), req.params);
    const { method } = parse(z.object({ method: z.enum(['card', 'bizum']) }), req.body);
    const [p] = await sql`select created_at < now() - interval '20 minutes' as expired from online_payments where token = ${token}`;
    if (p?.expired) throw conflict('expired', 'Este código de pago ha caducado. Pide uno nuevo al personal.');
    return startOnlinePayment(token, method);
  });

  /** "Pagar mi cuenta" desde la carta del cliente (con la clave de la mesa). */
  app.post('/api/public/table/:token/pay', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(64) }), req.params);
    const { accessCode } = parse(z.object({ accessCode: z.string().max(10) }), req.body);
    const [t] = await sql`select t.id, t.establishment_id, t.access_code, t.access_open, t.qr_token from tables t where t.qr_token = ${token} and t.active`;
    if (!t) throw notFound('Mesa');
    checkLimit(req, `table:${t.qr_token}`);
    if (!t.access_open || accessCode !== t.access_code) { recordFailure(req, `table:${t.qr_token}`); throw conflict('bad_code', 'La clave de la mesa no es correcta'); }
    const [acc] = await sql`select id from accounts where table_id = ${t.id} and status = 'open'`;
    if (!acc) throw conflict('nothing_pending', 'La mesa no tiene ninguna cuenta pendiente');
    const p = await createOnlinePayment(t.establishment_id, acc.id, 'client');
    notify(t.establishment_id, ['payments']);
    return { token: p.token };
  });

  // ---------- Notificación de Redsys ----------
  app.post('/api/redsys/notify', async (req, reply) => {
    const r = await handleNotification((req.body ?? {}) as Record<string, string>);
    if (r.establishmentId) {
      const [t] = await sql`select t.qr_token from accounts a join tables t on t.id = a.table_id where a.id = ${r.accountId ?? null}`;
      notify(r.establishmentId, ['payments', 'tables', 'orders'], t?.qr_token);
    }
    reply.type('text/plain');
    return r.ok ? 'OK' : 'KO';
  });
}
