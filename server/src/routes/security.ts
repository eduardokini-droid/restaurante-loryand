import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, type Tx } from '../db.js';
import { config } from '../config.js';
import { COOKIE, actorLabel, checkPassword, createSession, hashPassword, requireActor, requireModule, establishmentOf, setSessionCookie } from '../auth.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../validate.js';
import { checkLimit, recordFailure } from '../ratelimit.js';
import { audit } from '../services/audit.js';
import { encryptSecret, decryptSecret } from '../services/secrets.js';
import { mailConfigured, sendMail } from '../services/mail.js';
import { newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../services/totp.js';
import { checkSecondFactor, createResetLink, recoveryHash, sha } from '../services/security.js';

const password = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(100);
const code = z.string().trim().min(6).max(12);

function requireUser(req: FastifyRequest) {
  const a = requireActor(req);
  if (a.kind !== 'user') throw forbidden();
  return a;
}

async function verifyOwnPassword(userId: string, pw: string, req: FastifyRequest) {
  const [u] = await sql`select password_hash from users where id = ${userId}`;
  if (!u || !(await checkPassword(pw, u.password_hash))) {
    recordFailure(req, 'login');
    throw new AppError(401, 'bad_credentials', 'La contraseña actual no es correcta');
  }
}

/** Recuperación de contraseña, segundo paso del acceso y seguridad de la propia cuenta. */
export default async function securityRoutes(app: FastifyInstance) {
  // ---------- Segundo paso del inicio de sesión ----------
  app.post('/api/auth/login/2fa', async (req, reply) => {
    checkLimit(req, 'login');
    const b = parse(z.object({ challenge: z.string().min(20).max(100), code }), req.body);
    const result = await sql.begin(async (tx) => {
      const [c] = await tx`select user_id, attempts, expires_at > now() as valid from login_challenges where token_hash = ${sha(b.challenge)} for update`;
      if (!c || !c.valid) throw new AppError(410, 'challenge_expired', 'Ha pasado demasiado tiempo. Vuelve a escribir usuario y contraseña.');
      const ok = await checkSecondFactor(tx, c.user_id, b.code);
      if (!ok) {
        if (c.attempts + 1 >= 5) await tx`delete from login_challenges where token_hash = ${sha(b.challenge)}`;
        else await tx`update login_challenges set attempts = attempts + 1 where token_hash = ${sha(b.challenge)}`;
        return null;
      }
      await tx`delete from login_challenges where token_hash = ${sha(b.challenge)}`;
      if (ok === 'recovery') await audit(tx, null, `user:${c.user_id}`, 'auth.recovery_code_used');
      return { userId: c.user_id as string, method: ok };
    });
    if (!result) {
      recordFailure(req, 'login');
      throw new AppError(401, 'bad_code', 'Código incorrecto');
    }
    setSessionCookie(reply, await createSession('user', result.userId));
    return { ok: true, usedRecoveryCode: result.method === 'recovery' };
  });

  // ---------- Recuperar la contraseña ----------
  /** Siempre responde igual, exista o no el usuario, para no revelar quién tiene cuenta. */
  app.post('/api/auth/forgot', async (req) => {
    checkLimit(req, 'forgot');
    recordFailure(req, 'forgot'); // cuenta todas las peticiones: como mucho 20 cada 10 minutos por conexión
    const { login } = parse(z.object({ login: z.string().trim().min(3).max(120) }), req.body);
    if (mailConfigured()) {
      const [u] = await sql`select u.id, u.name, u.email from users u left join establishments e on e.id = u.establishment_id
                            where (lower(u.username) = lower(${login}) or lower(u.email) = lower(${login}))
                              and u.active and coalesce(e.active, true) and u.email is not null`;
      if (u) {
        const link = await createResetLink(sql, u.id, 'email', null);
        try {
          await sendMail(u.email, 'Recuperar tu contraseña de Loryand',
            `Hola, ${u.name}:\n\nPara poner una contraseña nueva en el panel de Loryand, abre este enlace (vale 60 minutos y un solo uso):\n\n${link.url}\n\nSi no lo has pedido tú, ignora este correo: tu contraseña no cambia.\n`);
        } catch (e) { req.log.error(e); }
      }
    }
    return { ok: true, mail: mailConfigured() };
  });

  app.get('/api/auth/reset/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const [r] = await sql`select u.name, u.username, u.totp_enabled, (r.used_at is null and r.expires_at > now() and u.active) as valid
                          from password_resets r join users u on u.id = r.user_id where r.token_hash = ${sha(token)}`;
    if (!r || !r.valid) throw new AppError(410, 'reset_expired', 'Este enlace ya se ha usado o ha caducado. Pide uno nuevo.');
    return { name: r.name, username: r.username, totpEnabled: r.totp_enabled };
  });

  app.post('/api/auth/reset', async (req) => {
    checkLimit(req, 'forgot');
    const b = parse(z.object({ token: z.string().min(20).max(100), password }), req.body);
    const hash = await hashPassword(b.password);
    await sql.begin(async (tx) => {
      const [r] = await tx`select r.user_id, r.origin, r.created_by, u.establishment_id, (r.used_at is null and r.expires_at > now() and u.active) as valid
                           from password_resets r join users u on u.id = r.user_id where r.token_hash = ${sha(b.token)} for update of r`;
      if (!r || !r.valid) throw new AppError(410, 'reset_expired', 'Este enlace ya se ha usado o ha caducado. Pide uno nuevo.');
      await tx`update password_resets set used_at = now() where token_hash = ${sha(b.token)}`;
      await tx`delete from password_resets where user_id = ${r.user_id} and used_at is null`;
      await tx`update users set password_hash = ${hash} where id = ${r.user_id}`;
      // Se cierran todas sus sesiones abiertas: si alguien la conocía, deja de tener acceso.
      await tx`delete from sessions where user_id = ${r.user_id}`;
      await audit(tx, r.establishment_id, `user:${r.user_id}`, 'auth.password_reset', { origin: r.origin, createdBy: r.created_by });
    });
    return { ok: true };
  });

  /** Enlace de recuperación generado por el administrador (para su personal) o por el gestor (para el administrador). */
  app.post('/api/admin/users/:id/reset-link', async (req) => {
    const a = requireModule(req, 'users');
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [t] = await sql`select id, role, active from users where id = ${id} and establishment_id = ${est}`;
    if (!t) throw notFound('Usuario');
    if (t.role !== 'staff' && !(a.kind === 'user' && a.role === 'superadmin')) throw forbidden('El enlace del administrador lo genera el gestor de Loryand');
    if (!t.active) throw conflict('user_inactive', 'El usuario está desactivado');
    return sql.begin(async (tx) => {
      const link = await createResetLink(tx, id, 'admin', actorLabel(a));
      await audit(tx, est, actorLabel(a), 'auth.reset_link', { userId: id });
      return link;
    });
  });

  // ---------- Mi cuenta ----------
  app.get('/api/auth/account', async (req) => {
    const a = requireUser(req);
    const [u] = await sql`select username, name, email, role, totp_enabled,
                                 (select count(*)::int from recovery_codes c where c.user_id = users.id and c.used_at is null) as codes_left
                          from users where id = ${a.id}`;
    return {
      username: u.username, name: u.name, email: u.email, role: u.role, totpEnabled: u.totp_enabled, recoveryCodesLeft: u.codes_left,
      mailConfigured: mailConfigured(), mfaRequired: u.role === 'superadmin' && config.requireGestorMfa,
    };
  });

  app.patch('/api/auth/account', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    const b = parse(z.object({ currentPassword: z.string().min(1), email: z.string().trim().toLowerCase().email('Correo no válido').max(120).nullable() }), req.body);
    await verifyOwnPassword(a.id, b.currentPassword, req);
    const [dup] = b.email ? await sql`select 1 from users where lower(email) = ${b.email} and id <> ${a.id}` : [];
    if (dup) throw conflict('email_taken', 'Ese correo ya lo usa otra cuenta');
    await sql`update users set email = ${b.email} where id = ${a.id}`;
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    const b = parse(z.object({ currentPassword: z.string().min(1), password }), req.body);
    await verifyOwnPassword(a.id, b.currentPassword, req);
    const keep = sha(req.cookies[COOKIE] ?? '');
    await sql.begin(async (tx) => {
      await tx`update users set password_hash = ${await hashPassword(b.password)} where id = ${a.id}`;
      // Se mantiene esta sesión y se cierran las demás.
      await tx`delete from sessions where user_id = ${a.id} and token_hash <> ${keep}`;
      await tx`delete from password_resets where user_id = ${a.id} and used_at is null`;
      await audit(tx, a.establishmentId, actorLabel(a), 'auth.password_change');
    });
    return { ok: true };
  });

  // ---------- Doble verificación ----------
  app.post('/api/auth/2fa/setup', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    const b = parse(z.object({ currentPassword: z.string().min(1) }), req.body);
    await verifyOwnPassword(a.id, b.currentPassword, req);
    const [u] = await sql`select username, totp_enabled from users where id = ${a.id}`;
    if (u.totp_enabled) throw conflict('mfa_enabled', 'La doble verificación ya está activada');
    const secret = newTotpSecret();
    await sql`update users set totp_secret_enc = ${encryptSecret(secret)}, totp_last_step = null where id = ${a.id}`;
    return { secret, otpauth: otpauthUrl(secret, u.username) };
  });

  app.post('/api/auth/2fa/enable', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    const b = parse(z.object({ code }), req.body);
    return sql.begin(async (tx) => {
      const [u] = await tx`select totp_secret_enc, totp_enabled from users where id = ${a.id} for update`;
      if (u.totp_enabled) throw conflict('mfa_enabled', 'La doble verificación ya está activada');
      if (!u.totp_secret_enc) throw conflict('mfa_not_setup', 'Primero escanea el código QR');
      const step = verifyTotp(decryptSecret(u.totp_secret_enc), b.code);
      if (step == null) { recordFailure(req, 'login'); throw new AppError(400, 'bad_code', 'El código no coincide. Comprueba que la hora del móvil es automática.'); }
      await tx`update users set totp_enabled = true, totp_last_step = ${step} where id = ${a.id}`;
      const codes = await replaceRecoveryCodes(tx, a.id);
      await audit(tx, a.establishmentId, actorLabel(a), 'auth.2fa_enabled');
      return { recoveryCodes: codes };
    });
  });

  app.post('/api/auth/2fa/recovery-codes', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    const b = parse(z.object({ currentPassword: z.string().min(1), code }), req.body);
    await verifyOwnPassword(a.id, b.currentPassword, req);
    return sql.begin(async (tx) => {
      if (!(await checkSecondFactor(tx, a.id, b.code))) throw new AppError(400, 'bad_code', 'Código incorrecto');
      const codes = await replaceRecoveryCodes(tx, a.id);
      await audit(tx, a.establishmentId, actorLabel(a), 'auth.recovery_codes_regenerated');
      return { recoveryCodes: codes };
    });
  });

  app.post('/api/auth/2fa/disable', async (req) => {
    const a = requireUser(req);
    checkLimit(req, 'login');
    if (a.role === 'superadmin' && config.requireGestorMfa) throw forbidden('La doble verificación es obligatoria para el gestor general');
    const b = parse(z.object({ currentPassword: z.string().min(1), code }), req.body);
    await verifyOwnPassword(a.id, b.currentPassword, req);
    await sql.begin(async (tx) => {
      if (!(await checkSecondFactor(tx, a.id, b.code))) throw new AppError(400, 'bad_code', 'Código incorrecto');
      await disableMfa(tx, a.id);
      await audit(tx, a.establishmentId, actorLabel(a), 'auth.2fa_disabled');
    });
    return { ok: true };
  });

  /** El administrador quita la doble verificación a alguien de su personal que ha perdido el móvil (el gestor, también al administrador). */
  app.post('/api/admin/users/:id/reset-2fa', async (req) => {
    const a = requireModule(req, 'users');
    const est = establishmentOf(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [t] = await sql`select id, role from users where id = ${id} and establishment_id = ${est}`;
    if (!t) throw notFound('Usuario');
    if (t.role !== 'staff' && !(a.kind === 'user' && a.role === 'superadmin')) throw forbidden('Solo el gestor puede hacerlo con el administrador');
    await sql.begin(async (tx) => {
      await disableMfa(tx, id);
      await tx`delete from sessions where user_id = ${id}`;
      await audit(tx, est, actorLabel(a), 'auth.2fa_reset', { userId: id });
    });
    return { ok: true };
  });
}

async function replaceRecoveryCodes(tx: Tx, userId: string) {
  const codes = newRecoveryCodes();
  await tx`delete from recovery_codes where user_id = ${userId}`;
  for (const c of codes) await tx`insert into recovery_codes (user_id, code_hash) values (${userId}, ${recoveryHash(userId, c)})`;
  return codes;
}

async function disableMfa(tx: Tx, userId: string) {
  await tx`update users set totp_enabled = false, totp_secret_enc = null, totp_last_step = null where id = ${userId}`;
  await tx`delete from recovery_codes where user_id = ${userId}`;
}
