import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql } from '../db.js';
import { COOKIE, checkPassword, createSession, destroySession, pinLookup, requireActor, setSessionCookie, can, MODULES } from '../auth.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';
import { checkLimit, recordFailure } from '../ratelimit.js';

const fail = () => new AppError(401, 'bad_credentials', 'Usuario o contraseña incorrectos');

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    checkLimit(req, 'login');
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
    const [u] = await sql`
      select u.id, u.password_hash, u.active, coalesce(e.active, true) as est_active
      from users u left join establishments e on e.id = u.establishment_id
      where lower(u.username) = lower(${body.username})`;
    if (!u || !u.active || !u.est_active || !(await checkPassword(body.password, u.password_hash))) {
      recordFailure(req, 'login');
      throw fail();
    }
    setSessionCookie(reply, await createSession('user', u.id));
    return { ok: true };
  });

  /** Acceso de camarero: establecimiento + usuario "camarero-ID" + PIN, o su QR personal. */
  app.post('/api/auth/waiter', async (req, reply) => {
    checkLimit(req, 'waiter');
    const pin = z.string().regex(/^\d{4,6}$/, 'el PIN tiene de 4 a 6 cifras');
    const body = parse(z.union([
      z.object({ establishment: z.string().min(1), username: z.string().regex(/^camarero-\d+$/i), pin, clockIn: z.boolean().optional() }),
      // QR de acceso del TPV (un solo uso, 2 minutos) o QR personal: SIEMPRE con el PIN del camarero.
      z.object({ accessToken: z.string().min(20).max(100), pin, clockIn: z.boolean().optional() }),
      z.object({ qrToken: z.string().min(10), pin, clockIn: z.boolean().optional() }),
    ]), req.body);
    let waiterId: string | undefined;
    let accessHash: string | undefined;
    const pinOk = (w: Record<string, any>) => w.pin_lookup === pinLookup(w.establishment_id, body.pin);
    if ('accessToken' in body) {
      accessHash = createHash('sha256').update(body.accessToken).digest('hex');
      const [w] = await sql`select w.id, w.establishment_id, w.pin_lookup, t.used_at, t.expires_at > now() as valid
                            from waiter_access_tokens t join waiters w on w.id = t.waiter_id join establishments e on e.id = w.establishment_id
                            where t.token_hash = ${accessHash} and w.active and e.active`;
      if (!w || w.used_at || !w.valid) throw new AppError(410, 'access_expired', 'Este código ya se ha usado o ha caducado. Pide uno nuevo en el TPV.');
      if (pinOk(w)) waiterId = w.id;
    } else if ('qrToken' in body) {
      const [w] = await sql`select w.id, w.establishment_id, w.pin_lookup from waiters w join establishments e on e.id = w.establishment_id
                            where w.qr_token = ${body.qrToken} and w.active and e.active`;
      if (w && pinOk(w)) waiterId = w.id;
    } else {
      const code = Number(body.username.split('-')[1]);
      const [w] = await sql`select w.id, w.establishment_id, w.pin_lookup from waiters w join establishments e on e.id = w.establishment_id
                            where e.slug = ${body.establishment} and e.active and w.code = ${code} and w.active`;
      if (w && pinOk(w)) waiterId = w.id;
    }
    if (!waiterId) {
      recordFailure(req, 'waiter');
      throw new AppError(401, 'bad_credentials', 'Usuario o PIN incorrectos');
    }
    if (accessHash) {
      // Un solo uso: si dos teléfonos lo intentan a la vez, solo entra el primero.
      const [used] = await sql`update waiter_access_tokens set used_at = now() where token_hash = ${accessHash} and used_at is null returning waiter_id`;
      if (!used) throw new AppError(410, 'access_expired', 'Este código ya se ha usado. Pide uno nuevo en el TPV.');
    }
    if (body.clockIn) await sql`insert into shifts (waiter_id) values (${waiterId}) on conflict do nothing`;
    setSessionCookie(reply, await createSession('waiter', waiterId));
    return { ok: true };
  });

  /** Datos visibles del QR de acceso (sin secretos): para saludar al camarero por su nombre antes del PIN. */
  app.get('/api/auth/waiter-access/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const [t] = await sql`select w.name, e.name as establishment, (t.used_at is null and t.expires_at > now()) as valid, t.expires_at
                          from waiter_access_tokens t join waiters w on w.id = t.waiter_id join establishments e on e.id = w.establishment_id
                          where t.token_hash = ${createHash('sha256').update(token).digest('hex')}`;
    if (!t) throw new AppError(404, 'not_found', 'Código no válido');
    return { waiter: t.name, establishment: t.establishment, valid: t.valid, expiresAt: t.expires_at };
  });

  /** QR personal impreso: identifica al camarero (el PIN sigue siendo obligatorio). */
  app.get('/api/auth/waiter-qr/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(100) }), req.params);
    const [w] = await sql`select w.name, e.name as establishment from waiters w join establishments e on e.id = w.establishment_id
                          where w.qr_token = ${token} and w.active and e.active`;
    if (!w) throw new AppError(404, 'not_found', 'Código no válido');
    return { waiter: w.name, establishment: w.establishment, valid: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await destroySession(t);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const a = requireActor(req);
    let establishment = null;
    if (a.establishmentId) {
      const [e] = await sql`select id, slug, name, features, settings from establishments where id = ${a.establishmentId}`;
      establishment = e;
    }
    let shift = null;
    if (a.kind === 'waiter') {
      const [s] = await sql`select id, started_at from shifts where waiter_id = ${a.id} and ended_at is null`;
      shift = s ?? null;
    }
    let onlinePayment = false;
    if (a.establishmentId) {
      const [pay] = await sql`select 1 from integrations where establishment_id = ${a.establishmentId} and kind = 'redsys' and enabled and secret_enc is not null`;
      onlinePayment = !!pay;
    }
    return { actor: a, establishment, shift, modules: MODULES.filter((m) => can(a, m)), onlinePayment };
  });
}
