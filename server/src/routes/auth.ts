import type { FastifyInstance } from 'fastify';
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
    const body = parse(z.union([
      z.object({ establishment: z.string().min(1), username: z.string().regex(/^camarero-\d+$/i), pin: z.string().regex(/^\d{4,6}$/) }),
      z.object({ qrToken: z.string().min(10) }),
    ]), req.body);
    let waiterId: string | undefined;
    if ('qrToken' in body) {
      const [w] = await sql`select w.id from waiters w join establishments e on e.id = w.establishment_id
                            where w.qr_token = ${body.qrToken} and w.active and e.active`;
      waiterId = w?.id;
    } else {
      const code = Number(body.username.split('-')[1]);
      const [w] = await sql`select w.id, w.establishment_id, w.pin_lookup from waiters w join establishments e on e.id = w.establishment_id
                            where e.slug = ${body.establishment} and e.active and w.code = ${code} and w.active`;
      if (w && w.pin_lookup === pinLookup(w.establishment_id, body.pin)) waiterId = w.id;
    }
    if (!waiterId) {
      recordFailure(req, 'waiter');
      throw new AppError(401, 'bad_credentials', 'Usuario o PIN incorrectos');
    }
    setSessionCookie(reply, await createSession('waiter', waiterId));
    return { ok: true };
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
